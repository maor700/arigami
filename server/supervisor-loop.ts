// RES1 — the supervisor's IO half: one wall-clock tick that reads every session,
// asks the pure decision layer (server/supervisor.ts) what to do, does it, and
// leaves a receipt. Mirrors the listeners.ts split: all the judgement lives in a
// pure module, all the side effects live here.
//
// What it owns:
//   §1 the health map every session gets (rail dots, /__api/health)
//   §2 the recovery ladder — respawn, auth refresh, model ladder, MCP disable,
//      nudge, escalate — each one writing a chat receipt AND an incidents.jsonl
//      line, and each one refusing to touch a WAITING_HUMAN session
//   §3 orchestration liveness — synthesize a child's missing report, re-deliver
//      an ask the child never got, and aggregate everything a human owes into
//      the "ממתין לך" (waiting for you) queue
//
// The loop never restarts the host and never touches anything outside a session.
import {
  cfg,
  getSession,
  listSessions,
  patchSession,
  type Session,
} from './state.js';
import { broadcast } from './bus.js';
import {
  classify,
  decide,
  floorActivity,
  freshWatermark,
  resetOnProgress,
  waitingRow,
  HEALTH_DOT,
  type Decision,
  type Health,
  type SessionView,
  type Thresholds,
  type WaitingRow,
  type Watermark,
} from './supervisor.js';
import { appendIncident, readIncidents, summarize, type Incident } from './incidents.js';
import * as claude from './claude.js';
import { getAgent } from './agents.js';
import { budgetState } from './agent-ledger.js';
import { listAccounts } from './accounts.js';

// MCP verdicts that mean "this server is not answering right now". needs-auth /
// needs-reconnect are credentials problems a respawn can't fix — they surface as
// Connect cards, not as supervisor incidents.
const MCP_DOWN = new Set(['degraded', 'failed']);

interface Tracked {
  watermark: Watermark;
  health: Health;
  reason: string;
  since: number; // when the session entered this health state
  escalated: boolean;
  /**
   * The chat seq of the last real turn we accounted for. NOT updatedAt: our own
   * receipts and metadata writes bump that, so an escalated session would look
   * like it had recovered on the very next tick.
   */
  lastTurnSeq: number;
  /**
   * The last tick this session was legitimately waiting on owned work (a live
   * child, or a waitingOn pointer not yet cleared). 0 = never observed. SUP1:
   * once that work clears, this becomes the floor for lastActivityAt — so a
   * controller whose last child JUST finished gets a full fresh stall window
   * before it is nudged, instead of being judged against however stale its own
   * transcript activity happens to be.
   */
  ownedWorkUntil: number;
}

const tracked = new Map<string, Tracked>();

function trackOf(id: string): Tracked {
  let t = tracked.get(id);
  if (!t) {
    t = {
      watermark: freshWatermark(),
      health: 'IDLE_OK',
      reason: 'idle',
      since: Date.now(),
      escalated: false,
      lastTurnSeq: 0,
      ownedWorkUntil: 0,
    };
    tracked.set(id, t);
  }
  return t;
}

export function thresholds(now = Date.now()): Thresholds {
  const s = cfg.supervisor;
  return {
    now,
    stallMs: Math.max(1000, (s?.stallMin ?? 10) * 60_000),
    reportGraceMs: Math.max(1000, (s?.reportGraceMin ?? 2) * 60_000),
    notifyEveryMs: Math.max(1000, (s?.notifyEveryMin ?? 60) * 60_000),
    maxRespawns: s?.maxRespawns ?? 2,
    maxAuthRetries: 2,
    maxNudges: 1,
  };
}

// ---- building the view ------------------------------------------------------

/** True when every pooled account is quarantined/unusable right now. */
function accountsAllLimited(): boolean {
  const pool = (listAccounts().accounts as any[]).filter((a) => a.pool);
  if (!pool.length) return false;
  return pool.every((a) => !a.available);
}

/** The MCP servers this session reports as down and hasn't already dropped. */
function mcpDownOf(s: Session): string[] {
  const servers = (s.claude?.mcp?.servers || {}) as Record<string, { status?: string; disabled?: boolean }>;
  return Object.entries(servers)
    .filter(([, sv]) => !sv.disabled && MCP_DOWN.has(sv.status || ''))
    .map(([name]) => name);
}

/**
 * Is one of those servers something this session genuinely cannot work without?
 * `arigami` is the host's own bridge (no cockpit tools at all without it); an
 * agent whose allowlist explicitly names a server asked for it by name.
 */
function mcpRequired(s: Session, down: string[]): boolean {
  if (down.includes('arigami')) return true;
  const slug = typeof s.metadata?.agent === 'string' ? s.metadata.agent : null;
  const tools = (slug && getAgent(slug)?.tools) || [];
  return down.some((name) => tools.some((t) => String(t).includes(name)));
}

/** The child of a `waitingOn` master: does it actually know about the ask? */
function childKnows(w: { sessionId: string; since: string }): { knows: boolean; gone: boolean } {
  const child = getSession(w.sessionId);
  if (!child) return { knows: false, gone: true };
  const since = Date.parse(w.since) || 0;
  // It knows if the ask is still in its queue, if it has been busy since, or if
  // it already answered (a result recorded after the ask went out).
  if ((child.pendingPrompts || []).length) return { knows: true, gone: false };
  if (child.claude?.state === 'working' || child.claude?.state === 'restarting') return { knows: true, gone: false };
  const reportedAt = Date.parse(String((child.metadata?.result as any)?.reportedAt || '')) || 0;
  if (reportedAt >= since) return { knows: true, gone: false };
  const updated = Date.parse(child.updatedAt || '') || 0;
  return { knows: updated > since, gone: false };
}

/** True when a session's `metadata.result` records a terminal state. */
function isReported(s: Session): boolean {
  const result = (s.metadata as any)?.result as { state?: string } | undefined;
  return !!result?.state && ['done', 'blocked', 'error'].includes(String(result.state));
}

/**
 * Every session id that has at least one live child right now: another
 * non-archived session with metadata.master === that id which has not
 * reported yet (SUP1). Computed once per sweep over the same list the sweep
 * already iterates — dispatch workers and full project children are both
 * discovered the same way, via metadata.master.
 */
function liveChildParents(sessions: Session[]): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) {
    const master = (s.metadata as any)?.master as string | undefined;
    if (master && !isReported(s)) out.add(master);
  }
  return out;
}

/** Everything supervisor.ts needs about one session, read from live sources. */
export function viewOf(s: Session, now = Date.now(), hasLiveChildren = false): SessionView {
  const slug = typeof s.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null;
  const md = (s.metadata || {}) as Record<string, any>;
  const down = mcpDownOf(s);
  const ladder = claude.ladderState(s.id);
  const errClass = claude.lastTurnError(s.id);
  const waitingOn = (md.waitingOn as SessionView['waitingOn']) || null;
  const know = waitingOn ? childKnows(waitingOn) : null;
  const budget = slug ? budgetState(slug) : null;
  return {
    id: s.id,
    title: s.title,
    archived: !!s.archived,
    agent: slug,
    claudeState: s.claude?.state,
    procAlive: claude.isRunning(s.id),
    lastActivityAt: Date.parse(s.updatedAt || s.createdAt || '') || now,
    queued: (s.pendingPrompts || []).length,
    autoPlay: !!s.promptAutoPlay,
    action: !!s.action,
    screenRequest: !!s.claude?.screenRequest,
    setupRequest: !!s.claude?.setupRequest,
    reviewRequested: s.status === 'In Review' && md.review?.state !== 'approved',
    mergePending: md.review?.state === 'approved' && !md.merged && !!md.branch,
    budgetExceeded: !!budget?.exceeded,
    lastErrorClass: errClass,
    // A limit we could not route around: the account pool is dry.
    accountsExhausted: errClass === 'limit' && accountsAllLimited(),
    accountsAvailable: !accountsAllLimited(),
    modelRungsLeft: ladder.rungsLeft,
    mcpDown: down,
    mcpRequired: mcpRequired(s, down),
    modelRung: ladder.rung,
    modelRestoreAt: ladder.restoreAt,
    hadTurn: claude.lastTurnSeq(s.id) > 0,
    escalated: !!md.supervisor?.escalated,
    escalatedReason: md.supervisor?.reason || undefined,
    master: (md.master as string) || null,
    reported: isReported(s),
    waitingOn,
    hasLiveChildren,
    ...(know ? { waitingOnChildKnows: know.knows, waitingOnChildGone: know.gone } : {}),
  };
}

// ---- receipts ---------------------------------------------------------------

function receipt(id: string, text: string): void {
  try {
    claude.appendChat(id, { kind: 'system', text });
  } catch {
    /* a chat receipt is never allowed to fail the recovery it describes */
  }
}

function incident(id: string, d: Decision, outcome: string, extra: Record<string, unknown> = {}): void {
  const e = appendIncident({
    sessionId: id,
    action: d.action,
    health: d.health,
    reason: d.reason,
    outcome,
    detail: { ...(d.detail || {}), ...extra },
  });
  void e; // appendIncident broadcasts {type:'incident'} itself (incidents.ts)
}

function notify(id: string, title: string, body: string): void {
  // notify.ts: Web Push plus every registered channel (WhatsApp, extensions).
  import('./notify.js')
    .then((n) =>
      n.notify({
        title: title.slice(0, 80),
        body: body.slice(0, 200),
        tag: `supervisor:${id}`,
        sessionId: id,
        url: `/__host/#/session/${encodeURIComponent(id)}`,
      })
    )
    .catch(() => {});
}

// ---- §3: the report the child never sent ------------------------------------

/**
 * A child reached a terminal state without report_to_master. Build the report
 * the host CAN see — its status, branch and last words — record it as the
 * session's result (flagged `synthesized`) and wake the master with the same
 * thin pointer an explicit report would have produced.
 *
 * RES2: the host never claims 'done' on a child's behalf — it does not and
 * cannot know whether the work actually finished (that is exactly the bug this
 * fixes: a worker interrupted mid-file previously got reported 'done'). The
 * state is unconditionally 'unknown'; the note says plainly that the child
 * never reported and quotes its last words so the master can judge for itself.
 */
function synthesizeReport(s: Session, terminal?: string): { state: string; summary: string } {
  const md = (s.metadata || {}) as Record<string, any>;
  const dead = s.claude?.state === 'dead';
  const state = 'unknown';
  let lastWords = '';
  try {
    const evs = (claude.getChat(s.id, 0) || []) as any[];
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i].kind === 'assistant-text' && evs[i].text) {
        lastWords = String(evs[i].text).slice(0, 400);
        break;
      }
    }
  } catch {
    /* no transcript */
  }
  const parts = [
    `[host-synthesized] this worker did NOT call report_to_master — the host does not know whether the work finished.`,
    `status: ${s.status || '—'}${dead ? ' (its claude process died)' : ''}`,
    terminal ? `why we stopped waiting: ${terminal}` : null,
    md.branch ? `branch: ${md.branch}` : null,
    md.worktree ? `worktree: ${md.worktree}` : null,
    lastWords ? `last words (may be mid-task, not a conclusion): ${lastWords}` : 'last words: (none found)',
  ].filter(Boolean);
  const summary = parts.join('\n');
  const result = {
    state,
    summary,
    artifacts: [],
    note: 'synthesized by the host supervisor — the child never reported; treat as unknown, not done',
    reportedAt: new Date().toISOString(),
    synthesized: true,
  };
  patchSession(s.id, { metadata: { result } });
  return { state, summary };
}

/** Clear a master's `waitingOn` once the child it pointed at has answered. */
export function clearWaitingOn(masterId: string | null | undefined, childId: string): void {
  if (!masterId) return;
  const m = getSession(masterId);
  const w = (m?.metadata as any)?.waitingOn;
  if (w && w.sessionId === childId) patchSession(masterId, { metadata: { waitingOn: null } });
}

// ---- running one decision ---------------------------------------------------

async function run(s: Session, d: Decision): Promise<void> {
  const id = s.id;
  switch (d.action) {
    case 'respawn': {
      const last = claude.lastUserMessage(id);
      receipt(id, '⤷ the session process had died — restarted it and replayed the last message');
      try {
        claude.restart(id, { silent: true });
        if (last) {
          const t = setTimeout(() => {
            try {
              claude.sendMessage(id, last);
            } catch {
              /* the respawn failed too — the next tick escalates */
            }
          }, 900);
          if (t.unref) t.unref();
        }
        incident(id, d, 'ok', { replayed: !!last });
      } catch (e) {
        incident(id, d, 'failed', { error: (e as Error).message });
      }
      return;
    }
    case 'refresh-auth': {
      const ok = await claude.recoverAuth(id);
      incident(id, d, ok ? 'ok' : 'failed');
      return;
    }
    case 'model-down': {
      // Climb back when the earliest quarantined account frees up, if we know.
      const soonest = (listAccounts().accounts as any[])
        .filter((a) => a.pool && a.quarantineUntil)
        .map((a) => a.quarantineUntil)
        .sort()[0] as string | undefined;
      const r = claude.downgradeModel(id, { resetAt: soonest || null, why: 'all accounts limited' });
      if (r.ok) incident(id, d, 'ok', { from: r.from, to: r.model });
      else if (r.reason === 'bottom') incident(id, d, 'failed', { reason: 'bottom-rung' });
      return;
    }
    case 'model-restore': {
      const to = claude.restoreModel(id);
      incident(id, d, to ? 'ok' : 'failed', { to });
      return;
    }
    case 'disable-mcp': {
      const servers = (d.detail?.servers as string[]) || [];
      let any = false;
      for (const name of servers) any = claude.disableMcpServer(id, name, 'not answering') || any;
      incident(id, d, any ? 'ok' : 'failed', { servers });
      return;
    }
    case 'nudge': {
      receipt(id, '⤷ no progress for a while and nothing is owed to a human — asking the session to continue');
      try {
        const api = await import('./api.js');
        api.deliverToSession(
          id,
          '[host supervisor] You have been idle with work still owed. Continue where you left off; if you are blocked, say exactly what is blocking you (and call report_to_master if you have one).'
        );
        incident(id, d, 'ok');
      } catch (e) {
        incident(id, d, 'failed', { error: (e as Error).message });
      }
      return;
    }
    case 'synthesize-report': {
      const master = String(d.detail?.master || '');
      const terminal = d.detail?.terminal ? String(d.detail.terminal) : undefined;
      const r = synthesizeReport(s, terminal);
      receipt(id, `⤷ you did not report_to_master — the host told your master (${master}) it does not know whether this finished`);
      try {
        const listeners = await import('./listeners.js');
        const subtask = (s.metadata?.subtask as string) || s.title;
        listeners.enqueueWake(
          master,
          `worker ${id} (${subtask}) did NOT report_to_master — host-synthesized, state: ${r.state}\n${r.summary}`,
          `report:${id}`
        );
        clearWaitingOn(master, id);
        incident(id, d, 'ok', { master, state: r.state });
      } catch (e) {
        incident(id, d, 'failed', { master, error: (e as Error).message });
      }
      return;
    }
    case 'redeliver-ask': {
      const child = String(d.detail?.child || '');
      const what = String(d.detail?.what || '');
      try {
        const api = await import('./api.js');
        api.deliverToSession(child, `[host supervisor] Your controller is still waiting on this — it never reached you:\n\n${what}`);
        receipt(id, `⤷ the child ${child} never got your ask — the host re-delivered it`);
        incident(id, d, 'ok', { child });
      } catch (e) {
        incident(id, d, 'failed', { child, error: (e as Error).message });
      }
      return;
    }
    case 'notify-human': {
      notify(id, s.title || 'Arigami', `still waiting for you — ${d.reason}`);
      incident(id, d, 'ok');
      return;
    }
    case 'escalate': {
      receipt(id, `⤷ the host could not recover this on its own (${d.reason}) — handing it to you`);
      patchSession(id, {
        metadata: {
          supervisor: { escalated: true, at: new Date().toISOString(), reason: d.reason, after: d.detail?.after || null },
        },
      });
      notify(id, s.title || 'Arigami', `needs you — ${d.reason}`);
      incident(id, d, 'escalated');
      return;
    }
    default:
      return;
  }
}

// ---- the tick ---------------------------------------------------------------

let lastBroadcast = '';

export interface HealthRow {
  sessionId: string;
  title: string;
  state: Health;
  reason: string;
  dot: 'grey' | 'blue' | 'amber' | 'red';
  since: string;
  escalated?: boolean;
  model?: string | null;
  modelRung?: number;
}

export interface HealthSnapshot {
  sessions: HealthRow[];
  waiting: WaitingRow[];
  waitingCount: number;
  incidents24h: number;
  by: Record<string, number>;
}

/**
 * Classify every live session without acting on anything — what /__api/health
 * and the rail dots read. `act:true` (the tick) also walks the ladder.
 */
export async function sweep({ act = false }: { act?: boolean } = {}): Promise<HealthSnapshot> {
  const th = thresholds();
  const rows: HealthRow[] = [];
  const waiting: WaitingRow[] = [];
  const live = new Set<string>();
  const sessions = listSessions({ archived: false });
  const withLiveChildren = liveChildParents(sessions);

  for (const s of sessions) {
    live.add(s.id);
    const t = trackOf(s.id);
    const v = viewOf(s, th.now, withLiveChildren.has(s.id));

    // SUP1: while this session owns live work (a live child, or a waitingOn
    // pointer it hasn't heard back on), the floor tracks "now" — so the moment
    // that work clears, the session is judged against a fresh stall window
    // instead of however stale its own transcript activity happens to be. A
    // controller whose child JUST reported must not be nudged on the very next
    // tick just because it hadn't said anything itself in the meantime.
    if (v.hasLiveChildren || (v.waitingOn && !v.waitingOnChildGone)) t.ownedWorkUntil = th.now;
    v.lastActivityAt = floorActivity(v.lastActivityAt || 0, t.ownedWorkUntil);

    // A turn that actually finished, with no error left behind, is the only
    // thing that clears the ladder counters — a session that recovered must not
    // carry its failure history into the next incident, and one we handed to a
    // human must not look recovered just because we wrote a receipt into it.
    const turnSeq = v.hadTurn ? claude.lastTurnSeq(s.id) : 0;
    if (turnSeq > t.lastTurnSeq) {
      t.lastTurnSeq = turnSeq;
      if (!v.lastErrorClass && v.claudeState !== 'dead') {
        t.watermark = resetOnProgress(t.watermark);
        t.escalated = false;
        // The escalation is over: clear the persisted flag too, so the session
        // leaves the "waiting for you" queue and the rail dot goes back to normal.
        if (v.escalated) {
          patchSession(s.id, { metadata: { supervisor: null } });
          v.escalated = false;
          v.escalatedReason = undefined;
        }
      }
    }

    if (v.escalated) t.escalated = true;
    const cl = classify(v, th);
    if (cl.state !== t.health) {
      // Entering WAITING_HUMAN: the card/request that put it there pushed its own
      // notification, so start the re-notify clock now instead of buzzing twice.
      if (cl.state === 'WAITING_HUMAN') t.watermark = { ...t.watermark, lastNotifyAt: th.now };
      t.health = cl.state;
      t.reason = cl.reason;
      t.since = th.now;
    } else {
      t.reason = cl.reason;
    }

    if (act) {
      const d = decide({ view: v, watermark: t.watermark, thresholds: th });
      t.watermark = d.next;
      if (d.escalated) t.escalated = true;
      if (d.action !== 'none') {
        try {
          await run(s, d);
        } catch (e) {
          console.error('[supervisor]', s.id, d.action, 'failed:', (e as Error).message);
        }
      }
    }

    rows.push({
      sessionId: s.id,
      title: s.title,
      state: cl.state,
      reason: cl.reason,
      dot: HEALTH_DOT[cl.state],
      since: new Date(t.since).toISOString(),
      ...(t.escalated ? { escalated: true } : {}),
      // What the session actually runs on — null means "the CLI's own default".
      // Never the head of its chain: that is only where it WOULD start.
      model: s.claude?.modelChoice || null,
      modelRung: v.modelRung || 0,
    });

    // Prefer the precise timestamp when the card itself carries one.
    const sinceIso = (s.action as { at?: string } | null)?.at || new Date(t.since).toISOString();
    const row = waitingRow(v, th, sinceIso, {
      escalated: t.escalated,
      detail: t.escalated ? cl.reason : undefined,
    });
    if (row) waiting.push(row);
  }

  for (const id of [...tracked.keys()]) if (!live.has(id)) tracked.delete(id);

  const recent = readIncidents();
  const snap: HealthSnapshot = {
    sessions: rows,
    waiting,
    waitingCount: waiting.length,
    incidents24h: recent.length,
    by: summarize(recent),
  };

  // Only broadcast when something the cockpit renders actually changed.
  const sig = JSON.stringify([rows.map((r) => [r.sessionId, r.state, r.escalated]), waiting.map((w) => [w.sessionId, w.kind])]);
  if (sig !== lastBroadcast) {
    lastBroadcast = sig;
    broadcast({ type: 'health', health: rows, waiting, waitingCount: waiting.length });
  }
  return snap;
}

export const healthSnapshot = (): Promise<HealthSnapshot> => sweep({ act: false });
export const waitingQueue = async (): Promise<WaitingRow[]> => (await sweep({ act: false })).waiting;
export const incidents = (hours = 24): Incident[] => readIncidents({ since: Date.now() - hours * 3600_000 });

let timer: NodeJS.Timeout | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await sweep({ act: true });
  } catch (e) {
    console.error('[supervisor] tick failed:', (e as Error).message);
  } finally {
    ticking = false;
  }
}

export function startSupervisor(): void {
  if (timer) return;
  if (cfg.supervisor?.enabled === false) {
    console.log('[supervisor] disabled by config — health is still computed on demand');
    return;
  }
  const every = Math.max(1, cfg.supervisor?.tickSec ?? 30) * 1000;
  timer = setInterval(tick, every);
  if (timer.unref) timer.unref();
  // One classify-only pass at boot: never act on a snapshot taken before the
  // sessions have had a chance to come back up after a host restart.
  sweep({ act: false }).catch(() => {});
}

export function stopSupervisor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: forget every per-session counter. */
export function resetSupervisorState(): void {
  tracked.clear();
  lastBroadcast = '';
}
