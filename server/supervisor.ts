// RES1 — the host supervisor's PURE decision layer.
//
// "The business must keep running unless a human answer is genuinely required."
// Every session gets a computed health state instead of a guess, and every
// unhealthy state maps to one rung of a recovery ladder (docs/RESILIENCE.md §2).
//
// Kept pure (no state singleton, no IO, no imports) so it is unit-testable the
// same way watchdog.ts / listeners-pr.ts are — server/supervisor-loop.ts does all
// the IO around it (read the sessions, run the action, write the receipts).
//
// The one hard rule, enforced structurally in decide(): a WAITING_HUMAN session
// is NEVER auto-nudged, respawned, downgraded or otherwise touched. The most the
// supervisor may do is re-notify the human (push), which does not reach into the
// session at all.

// ---- health model (§1) ------------------------------------------------------

export type Health =
  | 'RUNNING' // a turn is in flight, or the prompt queue is non-empty
  | 'IDLE_OK' // finished and reported; nothing owed
  | 'WAITING_HUMAN' // genuinely blocked on a person — the ONLY state where stopping is correct
  | 'BLOCKED_SYSTEM' // auth revoked, accounts+models exhausted, proc dead, MCP down
  | 'STALLED'; // no progress for N minutes with nothing owed to a human

/** The error family of the session's last failed turn (claude.js regexes). */
export type ErrorClass = 'limit' | 'auth' | 'mcp-down' | 'proc-dead' | 'other';

/** Everything the decision needs, flattened out of Session + accounts + ledger. */
export interface SessionView {
  id: string;
  title?: string;
  archived?: boolean;
  agent?: string | null;

  // --- liveness
  claudeState?: string; // idle | working | awaiting-input | restarting | dead
  procAlive?: boolean; // claude.isRunning(id)
  lastActivityAt?: number; // epoch ms of the last transcript/state activity
  queued?: number; // pendingPrompts.length
  autoPlay?: boolean; // the queue is set to play itself when the turn ends

  // --- owed to a human
  action?: boolean; // an open request_action card
  screenRequest?: boolean; // an open request_screen
  setupRequest?: boolean; // an open request_setup card
  reviewRequested?: boolean; // "In Review" and not yet approved
  budgetExceeded?: boolean; // A3/A5 daily cap hit — WAITING_HUMAN by design
  mergePending?: boolean; // approved branch the human has not merged yet

  // --- system failures
  lastErrorClass?: ErrorClass | null;
  accountsExhausted?: boolean; // limit hit and no pooled account left
  modelRungsLeft?: number; // rungs still below the current one in the chain
  mcpDown?: string[]; // MCP servers currently reported down
  mcpRequired?: boolean; // one of them is genuinely required for this session

  // --- model ladder
  modelRung?: number; // index into the effective chain (0 = top rung)
  modelRestoreAt?: string | null; // ISO: when the top rung's quota resets

  // --- orchestration
  master?: string | null; // metadata.master — this session owes that one a report
  reported?: boolean; // metadata.result exists with a terminal state
  waitingOn?: { sessionId: string; since: string; what: string } | null;
  waitingOnChildKnows?: boolean; // the child has the ask (pending queue / recent task)
  waitingOnChildGone?: boolean; // the child no longer exists
}

export interface Classification {
  state: Health;
  reason: string;
}

/** Thresholds — the loop passes them in so tests can shrink them. */
export interface Thresholds {
  now: number;
  stallMs: number; // no progress for this long → STALLED (when something is owed)
  reportGraceMs: number; // a child idle this long without a report → synthesize
  notifyEveryMs: number; // re-notify the human about the same block at most this often
  maxRespawns: number; // consecutive respawn failures before escalating
  maxAuthRetries: number; // consecutive auth-refresh failures before escalating
  maxNudges: number; // nudges before escalating to a respawn
}

export const DEFAULT_THRESHOLDS: Omit<Thresholds, 'now'> = {
  stallMs: 10 * 60_000,
  reportGraceMs: 2 * 60_000,
  notifyEveryMs: 60 * 60_000,
  maxRespawns: 2,
  maxAuthRetries: 2,
  maxNudges: 1,
};

const DEAD_STATES = new Set(['dead']);
const BUSY_STATES = new Set(['working', 'restarting']);

/** True when the session owes a report/answer to somebody in the tree. */
function owesWork(v: SessionView): boolean {
  if (v.master && !v.reported) return true; // a worker that never reported
  // A queue only counts as owed when auto-play promised to run it. A queue the
  // human parked with auto-play OFF is theirs to release, not ours to nudge.
  if ((v.queued || 0) > 0 && v.autoPlay) return true;
  if (v.waitingOn && !v.waitingOnChildGone) return true; // a master mid-orchestration
  return false;
}

/**
 * The computed health of one session (§1). WAITING_HUMAN is evaluated FIRST and
 * wins over every system signal: a session with an open question card must never
 * be auto-recovered, even if its token also expired.
 */
export function classify(v: SessionView, th: Thresholds): Classification {
  if (v.archived) return { state: 'IDLE_OK', reason: 'archived' };

  // ---- WAITING_HUMAN — genuinely blocked on a person
  if (v.screenRequest) return { state: 'WAITING_HUMAN', reason: 'screen-request' };
  if (v.setupRequest) return { state: 'WAITING_HUMAN', reason: 'setup-request' };
  if (v.action) return { state: 'WAITING_HUMAN', reason: 'action-card' };
  if (v.budgetExceeded) return { state: 'WAITING_HUMAN', reason: 'over-budget' };
  if (v.reviewRequested) return { state: 'WAITING_HUMAN', reason: 'review-requested' };
  if (v.mergePending) return { state: 'WAITING_HUMAN', reason: 'merge-pending' };
  if (v.claudeState === 'awaiting-input') return { state: 'WAITING_HUMAN', reason: 'awaiting-input' };

  // ---- BLOCKED_SYSTEM — nothing a person owes us; the host has to act
  if (DEAD_STATES.has(v.claudeState || '')) return { state: 'BLOCKED_SYSTEM', reason: 'proc-dead' };
  if (BUSY_STATES.has(v.claudeState || '') && v.procAlive === false)
    return { state: 'BLOCKED_SYSTEM', reason: 'proc-dead' };
  if (v.lastErrorClass === 'auth') return { state: 'BLOCKED_SYSTEM', reason: 'auth' };
  if (v.lastErrorClass === 'proc-dead') return { state: 'BLOCKED_SYSTEM', reason: 'proc-dead' };
  if (v.accountsExhausted) return { state: 'BLOCKED_SYSTEM', reason: 'accounts-exhausted' };
  if ((v.mcpDown || []).length) return { state: 'BLOCKED_SYSTEM', reason: 'mcp-down' };

  // ---- RUNNING
  const idleMs = v.lastActivityAt ? Math.max(0, th.now - v.lastActivityAt) : 0;
  if (BUSY_STATES.has(v.claudeState || '')) return { state: 'RUNNING', reason: v.claudeState! };
  if ((v.queued || 0) > 0 && idleMs <= th.stallMs) return { state: 'RUNNING', reason: 'queued' };

  // ---- STALLED — only when something is actually owed. A plain human chat that
  // is simply idle is IDLE_OK: nudging the user's own session would be noise.
  if (owesWork(v) && v.lastActivityAt && idleMs > th.stallMs)
    return { state: 'STALLED', reason: `${Math.round(idleMs / 1000)}s` };

  return { state: 'IDLE_OK', reason: v.reported ? 'reported' : 'idle' };
}

// ---- the recovery ladder (§2) -----------------------------------------------

export type ActionKind =
  | 'none'
  | 'respawn' // proc dead → --resume and replay the last user message
  | 'refresh-auth' // token expired/revoked → refresh and respawn
  | 'model-down' // no pooled account left → drop a rung of the model chain
  | 'model-restore' // the top rung's quota reset → climb back up
  | 'disable-mcp' // an MCP server is down → drop it for this session, tell the model
  | 'nudge' // STALLED with nothing owed to a human → "continue; if blocked, report why"
  | 'synthesize-report' // a child hit a terminal state without report_to_master
  | 'redeliver-ask' // a master waits on a child that never got the ask
  | 'notify-human' // re-notify (push) about an existing block — never touches the session
  | 'escalate'; // out of ladder → WAITING_HUMAN + push

/** Per-session counters the loop persists between ticks. */
export interface Watermark {
  respawns: number;
  authRetries: number;
  nudges: number;
  lastActedActivity: number; // lastActivityAt we already acted on (de-dupe)
  lastNotifyAt: number;
  reportSynthesized: boolean;
  lastRedeliverAt: number;
  /** When we handed this session to a human. Cleared by the next real progress. */
  escalatedAt: number;
}

export const freshWatermark = (): Watermark => ({
  respawns: 0,
  authRetries: 0,
  nudges: 0,
  lastActedActivity: 0,
  lastNotifyAt: 0,
  reportSynthesized: false,
  lastRedeliverAt: 0,
  escalatedAt: 0,
});

export interface Decision {
  action: ActionKind;
  health: Health;
  reason: string;
  detail?: Record<string, unknown>;
  next: Watermark;
  /** Set when the action ends the ladder: the session becomes WAITING_HUMAN. */
  escalated?: boolean;
}

const bump = (w: Watermark, patch: Partial<Watermark>): Watermark => ({ ...w, ...patch });

/**
 * One rung of the ladder for one session, this tick.
 *
 * HARD RULE: a WAITING_HUMAN session returns 'none' or 'notify-human' and
 * nothing else — the very first branch, so no rule below it can ever fire.
 */
export function decide(input: {
  view: SessionView;
  watermark?: Watermark;
  thresholds: Thresholds;
}): Decision {
  const { view: v, thresholds: th } = input;
  const w = input.watermark || freshWatermark();
  const cl = classify(v, th);
  const idleMs = v.lastActivityAt ? Math.max(0, th.now - v.lastActivityAt) : 0;
  const none = (reason = cl.reason): Decision => ({ action: 'none', health: cl.state, reason, next: w });

  // ---- the hard rule ---------------------------------------------------------
  if (cl.state === 'WAITING_HUMAN') {
    if (th.now - w.lastNotifyAt >= th.notifyEveryMs)
      return {
        action: 'notify-human',
        health: cl.state,
        reason: cl.reason,
        next: bump(w, { lastNotifyAt: th.now }),
      };
    return none();
  }

  // A model rung we dropped to has served its purpose once the top rung's quota
  // reset — climb back before anything else, so the session runs on the model the
  // human actually picked.
  if ((v.modelRung || 0) > 0 && shouldRestoreModel(v.modelRestoreAt, th.now))
    return { action: 'model-restore', health: cl.state, reason: 'quota-reset', next: w };

  // Already handed to a human and nothing has moved since — the ladder is over.
  // Re-notify on the cadence, but never walk it again (that is what turns a
  // one-off failure into a nudge loop).
  if (w.escalatedAt && (v.lastActivityAt || 0) <= w.escalatedAt) {
    if (th.now - w.lastNotifyAt >= th.notifyEveryMs)
      return { action: 'notify-human', health: cl.state, reason: cl.reason, next: bump(w, { lastNotifyAt: th.now }) };
    return none();
  }

  // A child that reached a terminal state without report_to_master (§3): the
  // master is never left guessing. Fires once per session (reportSynthesized).
  if (
    v.master &&
    !v.reported &&
    !w.reportSynthesized &&
    (cl.state === 'IDLE_OK' || cl.state === 'STALLED') &&
    idleMs >= th.reportGraceMs
  )
    return {
      action: 'synthesize-report',
      health: cl.state,
      reason: 'child-terminal-without-report',
      detail: { master: v.master },
      next: bump(w, { reportSynthesized: true }),
    };

  // A master waiting on a child that never got the ask (§3) — re-deliver it.
  if (
    v.waitingOn &&
    v.waitingOnChildKnows === false &&
    !v.waitingOnChildGone &&
    th.now - w.lastRedeliverAt >= th.notifyEveryMs
  )
    return {
      action: 'redeliver-ask',
      health: cl.state,
      reason: 'child-never-got-the-ask',
      detail: { child: v.waitingOn.sessionId, what: v.waitingOn.what },
      next: bump(w, { lastRedeliverAt: th.now }),
    };

  if (cl.state === 'BLOCKED_SYSTEM') return blocked(v, cl, w, th);
  if (cl.state === 'STALLED') return stalled(v, cl, w, th);
  return none();
}

function blocked(v: SessionView, cl: Classification, w: Watermark, th: Thresholds): Decision {
  const out = (action: ActionKind, next: Watermark, detail?: Record<string, unknown>, escalated?: boolean): Decision => ({
    action,
    health: cl.state,
    reason: cl.reason,
    ...(detail ? { detail } : {}),
    next,
    ...(escalated ? { escalated: true } : {}),
  });

  if (cl.reason === 'proc-dead')
    return w.respawns < th.maxRespawns
      ? out('respawn', bump(w, { respawns: w.respawns + 1 }))
      : out('escalate', bump(w, { escalatedAt: th.now }), { after: 'respawn', attempts: w.respawns }, true);

  if (cl.reason === 'auth')
    return w.authRetries < th.maxAuthRetries
      ? out('refresh-auth', bump(w, { authRetries: w.authRetries + 1 }))
      : out('escalate', bump(w, { escalatedAt: th.now }), { after: 'refresh-auth', attempts: w.authRetries }, true);

  // The account pool is exhausted — the account switch in claude.js already ran
  // and found nothing. Drop a rung of the model chain and keep working; only the
  // bottom rung with no quota left is a human's problem.
  if (cl.reason === 'accounts-exhausted')
    return (v.modelRungsLeft || 0) > 0
      ? out('model-down', w, { rungsLeft: v.modelRungsLeft })
      : out('escalate', bump(w, { escalatedAt: th.now }), { after: 'model-ladder' }, true);

  if (cl.reason === 'mcp-down')
    return v.mcpRequired
      ? out('escalate', bump(w, { escalatedAt: th.now }), { after: 'mcp', servers: v.mcpDown }, true)
      : out('disable-mcp', w, { servers: v.mcpDown });

  return out('none', w);
}

function stalled(v: SessionView, cl: Classification, w: Watermark, th: Thresholds): Decision {
  const out = (action: ActionKind, next: Watermark, escalated?: boolean): Decision => ({
    action,
    health: cl.state,
    reason: cl.reason,
    next,
    ...(escalated ? { escalated: true } : {}),
  });
  // De-dupe: one ladder step per stalled activity timestamp, so a session that
  // stays quiet isn't nudged every 30s.
  if (w.lastActedActivity === (v.lastActivityAt || 0)) return out('none', w);
  const next = bump(w, { lastActedActivity: v.lastActivityAt || 0 });

  if (w.nudges < th.maxNudges) return out('nudge', bump(next, { nudges: w.nudges + 1 }));
  if (w.respawns < th.maxRespawns) return out('respawn', bump(next, { respawns: w.respawns + 1 }));
  return out('escalate', bump(next, { escalatedAt: th.now }), true);
}

/** A successful turn clears the ladder counters — the session is healthy again. */
export function resetOnProgress(w: Watermark): Watermark {
  return { ...w, respawns: 0, authRetries: 0, nudges: 0, escalatedAt: 0, lastNotifyAt: 0 };
}

// ---- the model ladder -------------------------------------------------------
// "Fable ran out but weaker models still have quota — keep going." A rung is a
// `claude --model` value (an alias or a full id); dropping one is a plain
// setModel + --resume, so the conversation survives.

export const DEFAULT_MODEL_CHAIN: readonly string[] = ['fable', 'sonnet', 'haiku'];

const clean = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [];

/**
 * The chain this session drops down. Most specific wins: an explicit per-session
 * chain, else the agent's, else the host default. The model the human actually
 * picked always stays the TOP rung, even when it isn't in the configured chain.
 */
export function effectiveChain(opts: {
  sessionChain?: unknown;
  agentChain?: unknown;
  configChain?: unknown;
  modelChoice?: string | null;
}): string[] {
  const base = clean(opts.sessionChain).length
    ? clean(opts.sessionChain)
    : clean(opts.agentChain).length
      ? clean(opts.agentChain)
      : clean(opts.configChain).length
        ? clean(opts.configChain)
        : [...DEFAULT_MODEL_CHAIN];
  const pick = (opts.modelChoice || '').trim();
  const chain = pick && base[0] !== pick ? [pick, ...base.filter((m) => m !== pick)] : base;
  return [...new Set(chain)];
}

/** Where the session currently sits in its chain (0 = top; -1 = off-chain). */
export function rungOf(chain: string[], modelChoice: string | null | undefined): number {
  const pick = (modelChoice || '').trim();
  if (!pick) return 0;
  return chain.indexOf(pick);
}

/** The next rung down, or null when we're already at the bottom. */
export function nextRung(chain: string[], rung: number): { model: string; rung: number } | null {
  const i = rung + 1;
  return i >= 0 && i < chain.length ? { model: chain[i], rung: i } : null;
}

export function rungsLeft(chain: string[], rung: number): number {
  return Math.max(0, chain.length - 1 - Math.max(0, rung));
}

export function shouldRestoreModel(restoreAt: string | null | undefined, now: number): boolean {
  if (!restoreAt) return false;
  const t = Date.parse(restoreAt);
  return Number.isFinite(t) && now >= t;
}

// ---- the "ממתין לך" queue (§3) ----------------------------------------------
// One row per thing that needs the human, each saying WHAT is blocked, SINCE
// when, and the ONE action that unblocks it. Labels are i18n keys, not text —
// the cockpit renders them in the user's language.

export type WaitingKind = 'action' | 'screen' | 'setup' | 'review' | 'merge' | 'budget' | 'system';
export type UnblockKind = 'answer' | 'take-over' | 'connect' | 'approve' | 'merge' | 'raise-cap' | 'fix';

export interface WaitingRow {
  sessionId: string;
  title: string;
  agent?: string | null;
  kind: WaitingKind;
  /** i18n key describing what is blocked (`waiting.what.<kind>`). */
  what: string;
  /** i18n key of the single unblocking action (`waiting.do.<unblock>`). */
  unblock: UnblockKind;
  since: string; // ISO
  /** Extra context for the row (capability name, account label, …). */
  detail?: string;
}

const KIND_UNBLOCK: Record<WaitingKind, UnblockKind> = {
  action: 'answer',
  screen: 'take-over',
  setup: 'connect',
  review: 'approve',
  merge: 'merge',
  budget: 'raise-cap',
  system: 'fix',
};

/**
 * The row this session contributes to the queue, or null when it needs nobody.
 * Only WAITING_HUMAN sessions (and escalated system blocks) ever produce one.
 */
export function waitingRow(
  v: SessionView,
  th: Thresholds,
  since: string,
  opts: { escalated?: boolean; detail?: string } = {}
): WaitingRow | null {
  const cl = classify(v, th);
  let kind: WaitingKind | null = null;
  if (cl.state === 'WAITING_HUMAN') {
    kind =
      cl.reason === 'screen-request'
        ? 'screen'
        : cl.reason === 'setup-request'
          ? 'setup'
          : cl.reason === 'over-budget'
            ? 'budget'
            : cl.reason === 'review-requested'
              ? 'review'
              : cl.reason === 'merge-pending'
                ? 'merge'
                : 'action';
  } else if (cl.state === 'BLOCKED_SYSTEM' && opts.escalated) {
    kind = 'system';
  }
  if (!kind) return null;
  return {
    sessionId: v.id,
    title: v.title || v.id,
    agent: v.agent ?? null,
    kind,
    what: `waiting.what.${kind}`,
    unblock: KIND_UNBLOCK[kind],
    since,
    ...(opts.detail ? { detail: opts.detail } : {}),
  };
}

/** Rail dot colour per health state (§4) — one place, so server and UI agree. */
export const HEALTH_DOT: Record<Health, 'grey' | 'blue' | 'amber' | 'red'> = {
  IDLE_OK: 'grey',
  RUNNING: 'blue',
  WAITING_HUMAN: 'amber',
  BLOCKED_SYSTEM: 'red',
  STALLED: 'red',
};
