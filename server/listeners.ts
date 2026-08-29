// Listeners — deterministic pollers a session arms for an external event it's
// waiting on (e.g. its own PR getting reviewed), instead of an expensive model
// polling every N seconds. One shared wall-clock scheduler ticks every few
// seconds and polls whichever listeners are due. On a strong signal the poller
// wakes the session with a THIN pointer (sendMessage → the real conversation,
// which respawns via --resume if it exited); the session re-fetches details and
// decides. See docs/TRIGGERS.md for the full decision record.
//
// Guarantees: at-least-once. We advance a listener's watermark only AFTER the
// wake is delivered, so a crash between detect and deliver just re-fires next
// poll — harmless, because the thin signal only tells the session to re-look.
// Delivery is queued until the session is idle (never clobbers an in-flight
// turn) and coalesced (a burst becomes one wake).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type Listener,
  listListeners,
  getListener,
  patchListener,
  getSession,
  addListener,
  removeListener as stateRemoveListener,
  cfg,
} from './state.js';
import {
  classifyGhError,
  diffPr,
  type PrSnapshot,
  type PrWatermark,
  type PrDiff,
} from './listeners-pr.js';
import {
  classifyLinearError,
  diffLinearIssue,
  type LinearIssueSnapshot,
  type LinearIssueWatermark,
  type LinearIssueDiff,
} from './listeners-linear.js';
import {
  classifySlackError,
  diffSlack,
  type SlackSnapshot,
  type SlackWatermark,
  type SlackDiff,
} from './listeners-slack.js';
import {
  fetchWhatsappMessages,
  diffWhatsapp,
  addGroupSubscription,
  removeGroupSubscription,
  resolveActiveJid,
  type WhatsAppWatermark,
  DEFAULT_DB_PATH as WA_DEFAULT_DB_PATH,
} from './listeners-whatsapp.js';
import {
  startBridge,
  isBridgeRunning,
  isPaired,
  WA_DB_PATH,
} from './whatsapp-bridge.js';
import { evaluateWorker, type WorkerWatermark } from './watchdog.js';
import * as claude from './claude.js';
import * as linear from './linear-mcp.js';
import * as slack from './slack.js';

const execFileP = promisify(execFile);

const TICK_MS = 5_000;
const DEFAULT_INTERVAL_SEC = 30;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_AUTH_FAILS = 3;
const DEFAULT_TTL_DAYS = 7;

// ---- gh plumbing ------------------------------------------------------------

interface GhResult {
  ok: boolean;
  status: number;
  data?: any;
  stderr?: string;
}

async function ghApi(pathArg: string, cwd?: string): Promise<GhResult> {
  try {
    const { stdout } = await execFileP('gh', ['api', pathArg], {
      cwd,
      maxBuffer: 16e6,
      timeout: 15_000,
    });
    return { ok: true, status: 200, data: JSON.parse(stdout) };
  } catch (e: any) {
    const stderr = `${e?.stderr || ''}${e?.message || ''}`;
    const m = /HTTP (\d{3})/.exec(stderr);
    return { ok: false, status: m ? Number(m[1]) : 0, stderr };
  }
}

// ---- github-pr poller -------------------------------------------------------

interface PollOutcome {
  kind: 'ok' | 'transient' | 'auth' | 'gone';
  diff?: PrDiff | LinearIssueDiff | SlackDiff;
  ignoreLogin?: string;
  error?: string;
}

async function fetchPrSnapshot(
  o: string,
  r: string,
  n: number
): Promise<{ snap?: PrSnapshot; err?: GhResult }> {
  const meta = await ghApi(`repos/${o}/${r}/pulls/${n}`);
  if (!meta.ok) return { err: meta };
  // Reviews/comments/CI are best-effort — a partial fetch shouldn't kill the poll.
  const sha = meta.data?.head?.sha as string | undefined;
  const [reviews, issueComments, reviewComments, checks, combined] = await Promise.all([
    ghApi(`repos/${o}/${r}/pulls/${n}/reviews?per_page=100`),
    ghApi(`repos/${o}/${r}/issues/${n}/comments?per_page=100`),
    ghApi(`repos/${o}/${r}/pulls/${n}/comments?per_page=100`),
    // Both CI surfaces: modern check-runs (Actions, Chromatic…) + legacy commit
    // statuses (older integrations report only there).
    sha ? ghApi(`repos/${o}/${r}/commits/${sha}/check-runs?per_page=100`) : Promise.resolve({ ok: false, status: 0 } as GhResult),
    sha ? ghApi(`repos/${o}/${r}/commits/${sha}/status`) : Promise.resolve({ ok: false, status: 0 } as GhResult),
  ]);
  return {
    snap: {
      meta: meta.data,
      reviews: Array.isArray(reviews.data) ? reviews.data : [],
      issueComments: Array.isArray(issueComments.data) ? issueComments.data : [],
      reviewComments: Array.isArray(reviewComments.data) ? reviewComments.data : [],
      checkRuns: Array.isArray(checks.data?.check_runs) ? checks.data.check_runs : [],
      statusContexts: Array.isArray(combined.data?.statuses) ? combined.data.statuses : [],
    },
  };
}

async function pollGithubPr(l: Listener): Promise<PollOutcome> {
  const { owner, repo, number } = l.params as { owner: string; repo: string; number: number };
  const { snap, err } = await fetchPrSnapshot(owner, repo, number);
  if (err) return { kind: classifyGhError(err.status, err.stderr), error: err.stderr };
  const ignoreLogin = snap!.meta?.user?.login as string | undefined;
  const diff = diffPr(snap!, l.watermark as PrWatermark, { fireOn: l.fireOn, ignoreLogin });
  return { kind: 'ok', diff, ignoreLogin };
}

// ---- linear-issue poller ------------------------------------------------------
// Deterministic, server-side poll via the host's persistent Linear MCP CLIENT
// (linear-mcp.ts) — NOT the model's MCP tools. The stored OAuth grant is
// audience-scoped to mcp.linear.app and does not authenticate against the public
// api.linear.app GraphQL endpoint, so the MCP client is the only transport the
// credential permits; the SDK client handles token refresh internally. Two
// tool calls per poll: get_issue (status/assignee) + list_comments.

interface LinearFetchResult {
  snap?: LinearIssueSnapshot;
  err?: { status: number; message: string };
}

// Classify a thrown MCP/transport error into the (status, message) shape
// classifyLinearError expects. NEEDS_AUTH (from linear-mcp connect) → auth.
function linearErrFromThrow(e: any): { status: number; message: string } {
  const message = String(e?.message || e || 'linear poll failed').slice(0, 300);
  if (message === linear.NEEDS_AUTH_MSG || /needs?[_ ]auth|unauthor/i.test(message))
    return { status: 401, message };
  return { status: 0, message };
}

// Normalize the MCP shapes into the transport-agnostic LinearIssueSnapshot the
// pure diff consumes. get_issue returns a flat object (status name + statusType
// + assignee name + assigneeId); list_comments returns { author } per node.
async function fetchLinearIssueSnapshot(issueRef: string): Promise<LinearFetchResult> {
  let issue: any;
  try {
    issue = await linear.getIssue(issueRef);
  } catch (e) {
    return { err: linearErrFromThrow(e) };
  }
  if (!issue || typeof issue !== 'object' || (!issue.id && !issue.identifier))
    return { err: { status: 404, message: 'entity not found' } };

  let rawComments: any[] = [];
  try {
    rawComments = await linear.listComments(issue.id || issue.identifier || issueRef);
  } catch {
    // Comments are best-effort: a partial fetch shouldn't kill the poll (mirrors
    // the github-pr snapshot). Status/assignee events still evaluate.
    rawComments = [];
  }

  const statusName: string = issue.status || issue.state?.name || '';
  const statusType: string = issue.statusType || issue.state?.type || '';
  const assigneeId: string = issue.assigneeId || issue.assignee?.id || '';
  const assigneeName: string = issue.assignee?.displayName || issue.assignee?.name || issue.assignee || '';

  return {
    snap: {
      id: issue.id || issue.identifier || issueRef,
      identifier: issue.identifier || issue.id || issueRef,
      title: issue.title,
      url: issue.url,
      // status carries no stable id on the MCP surface — use the name as the
      // change-detection key (status names are unique within a team lifecycle).
      state: { id: statusName, name: statusName, type: statusType },
      assignee: assigneeId || assigneeName ? { id: assigneeId, name: assigneeName, displayName: assigneeName } : null,
      comments: rawComments.map((c: any) => ({
        id: String(c?.id || ''),
        createdAt: c?.createdAt || '',
        body: c?.body,
        // list_comments exposes the author as `author`; the pure diff reads `user`.
        user: c?.author || c?.user || null,
      })),
    },
  };
}

async function pollLinearIssue(l: Listener): Promise<PollOutcome> {
  const { issueId, viewerId } = l.params as { issueId: string; viewerId?: string };
  const { snap, err } = await fetchLinearIssueSnapshot(issueId);
  if (err) return { kind: classifyLinearError(err.status, err.message), error: err.message };
  const diff = diffLinearIssue(snap!, l.watermark as LinearIssueWatermark, {
    fireOn: l.fireOn,
    ignoreUserId: viewerId,
  });
  return { kind: 'ok', diff };
}

// ---- slack poller -------------------------------------------------------------
// Deterministic HTTP poll of the Slack Web API using the host's own user token
// (~/.arigami/slack-token.json). conversations.history for a channel/DM, or
// conversations.replies when a thread_ts is pinned.

async function fetchSlackSnapshot(
  channelId: string,
  threadTs: string | undefined,
  oldest: string | undefined,
  meta: { channelName?: string; isDm?: boolean }
): Promise<{ snap?: SlackSnapshot; err?: { status: number; error: string } }> {
  const res = threadTs
    ? await slack.conversationsReplies(channelId, threadTs, oldest)
    : await slack.conversationsHistory(channelId, oldest);
  if (!res.ok) return { err: { status: res.status, error: res.error || 'unknown_error' } };
  const messages = Array.isArray(res.data?.messages) ? res.data.messages : [];
  return {
    snap: { channelId, channelName: meta.channelName, isDm: meta.isDm, messages },
  };
}

async function pollSlack(l: Listener): Promise<PollOutcome> {
  const { channelId, threadTs, viewerId, channelName, isDm } = l.params as {
    channelId: string;
    threadTs?: string;
    viewerId?: string;
    channelName?: string;
    isDm?: boolean;
  };
  const wm = l.watermark as SlackWatermark;
  const { snap, err } = await fetchSlackSnapshot(channelId, threadTs, wm.lastTs, { channelName, isDm });
  if (err) return { kind: classifySlackError(err.status, err.error), error: err.error };
  const diff = diffSlack(snap!, wm, { fireOn: l.fireOn, ignoreUserId: viewerId });
  return { kind: 'ok', diff };
}

// ---- worker watchdog poller (decision 8) ------------------------------------
// Inspects a dispatch worker and pushes a thin event to its MASTER on crash
// (claude dead) or stall (no progress past stallTimeoutSec). The decision is the
// pure evaluateWorker(); this just does the IO around it. Retires itself once the
// worker reports a terminal result (explicit path covered it) or is deleted.

function pollWorker(l: Listener, now: number): void {
  const params = l.params as { workerId: string; subtask?: string | null };
  const wid = params.workerId;
  const subtask = params.subtask || wid;
  const worker = getSession(wid);
  if (!worker) {
    llog(l.id, 'info', 'worker gone — watchdog retired');
    patchListener(l.id, { status: 'stopped', lastError: 'worker-gone' });
    return;
  }

  const decision = evaluateWorker({
    worker: {
      claudeState: worker.claude?.state,
      updatedAt: worker.updatedAt,
      result: (worker.metadata?.result as { state?: string; reportedAt?: string }) || null,
    },
    watermark: (l.watermark as unknown as WorkerWatermark) || { lastState: null, lastStallActivity: 0 },
    stallMs: (cfg.dispatcher?.stallTimeoutSec || 600) * 1000,
    now,
  });

  const reschedule = (extra: Partial<Listener> = {}) =>
    patchListener(l.id, {
      lastPolledAt: now,
      nextPollAt: now + l.intervalSec * 1000,
      watermark: decision.nextWatermark as unknown as Record<string, unknown>,
      ...extra,
    });

  if (decision.action === 'retire') {
    llog(l.id, 'info', `worker reported ${decision.reason} — watchdog retired`);
    patchListener(l.id, {
      status: 'stopped',
      lastError: null,
      watermark: decision.nextWatermark as unknown as Record<string, unknown>,
    });
    return;
  }
  if (decision.action === 'crash') {
    llog(l.id, 'fire', `worker ${wid} crashed (claude dead)`);
    enqueueWake(
      l.sessionId,
      `⚠️ Watchdog: worker ${wid} (${subtask}) crashed — its claude process died. Decide: respawn (within maxAttempts) or escalate.`,
      `watchdog:${wid}:dead`
    );
    reschedule({ firedCount: l.firedCount + 1 });
    return;
  }
  if (decision.action === 'stall') {
    llog(l.id, 'fire', `worker ${wid} stalled (${decision.reason})`);
    enqueueWake(
      l.sessionId,
      `⚠️ Watchdog: worker ${wid} (${subtask}) has not made progress for ${decision.reason} (no state change or report). Decide: kill-with-cleanup + respawn, or escalate.`,
      `watchdog:${wid}:stall`
    );
    reschedule({ firedCount: l.firedCount + 1 });
    return;
  }
  reschedule();
}

// ---- activity log (in-memory, for the details modal) ------------------------
// A small per-listener ring buffer of meaningful events (armed / fired / queued /
// delivered / errors). Routine no-change polls are NOT logged — the modal shows
// liveness from lastPolledAt instead, so the log stays signal, not noise.
const MAX_LOG = 200;
const logs = new Map<string, { ts: number; level: string; text: string }[]>();

function llog(id: string, level: 'info' | 'fire' | 'warn' | 'error', text: string): void {
  const arr = logs.get(id) || [];
  arr.push({ ts: Date.now(), level, text });
  if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG);
  logs.set(id, arr);
}

export function getListenerLog(id: string): { ts: number; level: string; text: string }[] {
  return logs.get(id) || [];
}

// Type-agnostic watermark compare (both PR and Linear watermarks are flat
// objects of scalars/string-arrays) — key-order-stable so it never false-fires.
const wmChanged = (a: any = {}, b: any = {}): boolean => {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return JSON.stringify(a, keys) !== JSON.stringify(b, keys);
};

// ---- queue-until-idle delivery ----------------------------------------------

interface Pending {
  sessionId: string;
  text: string;
  nextWatermark: Record<string, unknown>;
  terminal: boolean;
}
const pending = new Map<string, Pending>(); // listenerId → pending wake

// Ad-hoc thin wakes not tied to a listener (e.g. a worker reporting to its master,
// or the worker-watchdog). Same queue-until-idle + coalesce delivery path as
// listeners. Keyed so repeated wakes from the same source collapse to the latest.
interface AdhocWake {
  sessionId: string;
  text: string;
}
const adhoc = new Map<string, AdhocWake>(); // key → pending wake

// Enqueue a thin pointer to `sessionId`, delivered once it's idle (coalesced with
// any other pending wakes for that session). `key` dedups bursts from one source
// (default: a fresh key, so every call is its own line). Used by report_to_master.
let wakeSeq = 0;
export function enqueueWake(sessionId: string, text: string, key?: string): void {
  adhoc.set(key || `wake_${++wakeSeq}`, { sessionId, text });
  tryDeliver(sessionId);
}

function enqueue(l: Listener, text: string, nextWatermark: Record<string, unknown>, terminal: boolean): void {
  const wasPending = pending.has(l.id);
  pending.set(l.id, { sessionId: l.sessionId, text, nextWatermark, terminal });
  tryDeliver(l.sessionId);
  if (!wasPending && pending.has(l.id))
    llog(l.id, 'info', 'session busy — wake queued until it goes idle');
}

// Deliver every pending wake for a session, but only when it's idle — coalesced
// into one message. Watermark advances here (post-delivery) for at-least-once.
function tryDeliver(sessionId: string): void {
  const s = getSession(sessionId);
  const mine = [...pending.entries()].filter(([, p]) => p.sessionId === sessionId);
  const myAdhoc = [...adhoc.entries()].filter(([, p]) => p.sessionId === sessionId);
  if (!mine.length && !myAdhoc.length) return;
  if (!s) {
    for (const [lid] of mine) pending.delete(lid);
    for (const [k] of myAdhoc) adhoc.delete(k);
    return;
  }
  if (s.claude?.state !== 'idle') return; // hold; onSessionIdle will retry

  const text = [...mine.map(([, p]) => p.text), ...myAdhoc.map(([, p]) => p.text)].join('\n\n');
  // Collect labels for the push notification
  const labels = mine.map(([lid]) => getListener(lid)?.label).filter(Boolean);
  try {
    claude.sendMessage(sessionId, text);
  } catch {
    return; // session not spawnable right now — keep pending, retry on next idle/poll
  }
  // Send push notification with the eventId of the just-appended chat event
  if (mine.length) {
    import('./push.js')
      .then((push) => {
        if (!push.hasSubscriptions()) return;
        // The chat event was just appended — read the latest to get its id
        const latest = claude.getChat(sessionId, 0);
        const lastEvent = Array.isArray(latest) ? latest[latest.length - 1] : null;
        push.sendPush({
          title: labels[0] || 'Arigami',
          body: text.slice(0, 200),
          tag: mine[0]?.[0] || 'listener',
          sessionId,
          eventId: lastEvent?.id,
          url: `/__host/#/session/${encodeURIComponent(sessionId)}`, // relative: SW resolves against its own origin
        });
      })
      .catch(() => {});
  }
  for (const [k] of myAdhoc) adhoc.delete(k);
  for (const [lid, p] of mine) {
    const l = getListener(lid);
    if (l)
      patchListener(lid, {
        watermark: p.nextWatermark,
        firedCount: l.firedCount + 1,
        status: p.terminal ? 'stopped' : 'watching',
        lastError: null,
      });
    llog(lid, 'info', p.terminal ? 'woke session with the terminal notice — listener stopped' : 'woke session — wake delivered');
    pending.delete(lid);
  }
}

// Called by claude.js when a session's turn finishes (state → idle).
export function onSessionIdle(sessionId: string): void {
  tryDeliver(sessionId);
}

// ---- scheduler --------------------------------------------------------------

async function pollOne(l: Listener): Promise<void> {
  const now = Date.now();
  if (now > l.ttlAt) {
    llog(l.id, 'info', 'TTL expired — listener stopped');
    patchListener(l.id, { status: 'stopped', lastError: 'ttl-expired' });
    return;
  }

  if (l.type === 'worker') return pollWorker(l, now);

  // ---- whatsapp poller (synchronous SQLite read, no network) -----------------
  if (l.type === 'whatsapp') {
    const { dbPath, groupJid } = l.params as { dbPath: string; groupJid?: string | null };
    const wm = l.watermark as unknown as WhatsAppWatermark;
    const nextSince = new Date(now).toISOString();
    const { messages, error } = fetchWhatsappMessages(dbPath, wm.since, groupJid);
    if (error) {
      const level = l.backoffLevel + 1;
      const wait = Math.min(BASE_BACKOFF_MS * 2 ** (level - 1), MAX_BACKOFF_MS);
      llog(l.id, 'warn', `whatsapp db error — backing off ${Math.round(wait / 1000)}s: ${error.slice(0, 120)}`);
      patchListener(l.id, { backoffLevel: level, nextPollAt: now + wait, lastPolledAt: now, lastError: error.slice(0, 300) });
      return;
    }
    const diff = diffWhatsapp(messages, nextSince);
    if (diff.shouldFire) {
      llog(l.id, 'fire', `${messages.length} new WhatsApp message(s)`);
      enqueue(l, diff.summary, diff.nextWatermark, false);
    } else {
      patchListener(l.id, { lastPolledAt: now, nextPollAt: now + l.intervalSec * 1000, backoffLevel: 0 });
    }
    return;
  }

  if (l.type === 'sms') {
    const sms = await import('./sms.js');
    const wm = l.watermark as { since: string };
    const fromFilter = (l.params as any)?.fromFilter || null;
    const nextSince = new Date(now).toISOString();
    let msgs = sms.getSmsAfter(wm.since);
    if (fromFilter) msgs = msgs.filter((m: any) => m.from.includes(fromFilter));
    if (msgs.length) {
      const lines = msgs.map((m: any) => `📱 SMS from ${m.from}: ${m.body}`);
      const summary = `🔔 ${msgs.length} new SMS:\n${lines.join('\n')}`;
      llog(l.id, 'fire', `${msgs.length} new SMS`);
      enqueue(l, summary, { since: nextSince }, false);
    } else {
      patchListener(l.id, { lastPolledAt: now, nextPollAt: now + l.intervalSec * 1000, backoffLevel: 0 });
    }
    return;
  }

  let outcome: PollOutcome;
  try {
    if (l.type === 'github-pr') outcome = await pollGithubPr(l);
    else if (l.type === 'linear-issue') outcome = await pollLinearIssue(l);
    else if (l.type === 'slack') outcome = await pollSlack(l);
    else {
      patchListener(l.id, { status: 'errored', lastError: `unknown listener type: ${l.type}` });
      return;
    }
  } catch (e: any) {
    outcome = { kind: 'transient', error: e?.message };
  }

  const reschedule = (extra: Partial<Listener> = {}) =>
    patchListener(l.id, {
      lastPolledAt: now,
      nextPollAt: now + l.intervalSec * 1000,
      backoffLevel: 0,
      ...extra,
    });

  if (outcome.kind === 'transient') {
    const level = l.backoffLevel + 1;
    const wait = Math.min(BASE_BACKOFF_MS * 2 ** (level - 1), MAX_BACKOFF_MS);
    llog(l.id, 'warn', `transient error — backing off ${Math.round(wait / 1000)}s: ${(outcome.error || '').slice(0, 120)}`);
    patchListener(l.id, { backoffLevel: level, nextPollAt: now + wait, lastPolledAt: now, lastError: outcome.error?.slice(0, 300) || 'transient error' });
    return;
  }

  // Type-specific wording for the gone/auth notices.
  const p = l.params as any;
  const { target, provider, reauthHint } =
    l.type === 'linear-issue'
      ? {
          target: `Linear issue ${p.issueId}`,
          provider: 'Linear',
          reauthHint: 'Re-connect Linear from the host settings, then re-arm the listener.',
        }
      : l.type === 'slack'
        ? {
            target: `Slack ${p.channelName || p.channelId}`,
            provider: 'Slack',
            reauthHint: 'Re-connect Slack (refresh the user token in the host settings), then re-arm the listener.',
          }
        : {
            target: `PR #${p.number}`,
            provider: 'GitHub',
            reauthHint: 'Re-auth (gh auth login / refresh the token), then re-arm the listener.',
          };

  if (outcome.kind === 'gone') {
    // The target was deleted/unreachable — terminal.
    llog(l.id, 'error', `${target} not found (deleted or no access) — stopping`);
    enqueue(l, `⚠️ Listener: ${target} could not be found (deleted or no access). The watch has stopped.`, l.watermark, true);
    reschedule({ lastError: 'not-found' });
    return;
  }

  if (outcome.kind === 'auth') {
    const authFails = l.authFails + 1;
    if (authFails >= MAX_AUTH_FAILS) {
      llog(l.id, 'error', `${provider} auth error (${authFails}/${MAX_AUTH_FAILS}) — stopping; re-auth and re-arm`);
      enqueue(l, `⚠️ Listener for ${target} hit a ${provider} auth error and stopped: ${(outcome.error || '').slice(0, 200)}\n${reauthHint}`, l.watermark, true);
      patchListener(l.id, { status: 'errored', authFails, lastPolledAt: now, lastError: 'auth' });
    } else {
      const wait = Math.min(BASE_BACKOFF_MS * 2 ** authFails, MAX_BACKOFF_MS);
      llog(l.id, 'warn', `${provider} auth error — retry ${authFails}/${MAX_AUTH_FAILS} in ${Math.round(wait / 1000)}s`);
      patchListener(l.id, { authFails, nextPollAt: now + wait, lastPolledAt: now, lastError: 'auth (retrying)' });
    }
    return;
  }

  // ok
  const diff = outcome.diff!;
  if (diff.terminal || diff.shouldFire) {
    // Don't advance the watermark here — that happens on delivery (at-least-once).
    llog(l.id, 'fire', diff.summary.split('\n')[0].replace(/^🔔 Listener: /, ''));
    enqueue(l, diff.summary, diff.nextWatermark as Record<string, unknown>, !!diff.terminal);
    reschedule({ authFails: 0, lastError: null });
  } else {
    // New-but-non-firing events (e.g. our own comments): advance the watermark
    // now so we don't re-evaluate them, but don't wake anyone.
    if (wmChanged(diff.nextWatermark, l.watermark))
      llog(l.id, 'info', 'new activity from a filtered author — watermark advanced, no wake');
    reschedule({ watermark: diff.nextWatermark as Record<string, unknown>, authFails: 0, lastError: null });
  }
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    // GC logs for listeners that were cancelled/removed.
    if (logs.size) {
      const live = new Set(listListeners().map((l) => l.id));
      for (const id of logs.keys()) if (!live.has(id)) logs.delete(id);
    }
    const due = listListeners().filter((l) => l.status === 'watching' && l.nextPollAt <= now);
    // Sequential — small N, and keeps gh load gentle.
    for (const l of due) {
      try {
        await pollOne(l);
      } catch (e: any) {
        console.error('[listeners] poll failed:', l.id, e?.message);
      }
    }
  } finally {
    ticking = false;
  }
}

export function startListenerScheduler(): void {
  if (timer) return;
  tick();
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();

  // Auto-start bridge if a WhatsApp listener is already registered
  const waListeners = listListeners().filter((l) => l.type === 'whatsapp' && l.status === 'watching');
  if (waListeners.length > 0 && !isBridgeRunning()) {
    const l = waListeners[0];
    llog('whatsapp-bridge', 'info', 'auto-starting bridge for existing WhatsApp listener');
    startBridge(l.sessionId, enqueueWake).catch(console.error);
  }
}

// ---- registration -----------------------------------------------------------

function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url || '');
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

// Resolve a PR target from explicit args, or infer it from the session worktree's
// current branch (`gh pr view`) — the common "I just opened a PR" case.
async function resolvePrTarget(
  cwd: string | undefined,
  args: { url?: string; owner?: string; repo?: string; number?: number }
): Promise<{ owner: string; repo: string; number: number }> {
  if (args.url) {
    const p = parsePrUrl(args.url);
    if (!p) throw new Error(`could not parse a GitHub PR from url: ${args.url}`);
    return p;
  }
  if (args.owner && args.repo && args.number)
    return { owner: args.owner, repo: args.repo, number: Number(args.number) };
  try {
    const { stdout } = await execFileP('gh', ['pr', 'view', '--json', 'url'], { cwd, timeout: 15_000 });
    const p = parsePrUrl(JSON.parse(stdout).url);
    if (p) return p;
  } catch {}
  throw new Error('no PR specified and none found for the current branch — pass a url or owner/repo/number');
}

export async function registerGithubPrListener(
  sessionId: string,
  args: { url?: string; owner?: string; repo?: string; number?: number; fire_on?: string[]; ttl_days?: number; interval_sec?: number }
): Promise<Listener> {
  const s = getSession(sessionId);
  if (!s) throw new Error(`unknown session: ${sessionId}`);
  const cwd = (s.metadata?.worktree as string) || s.cwd;
  const { owner, repo, number } = await resolvePrTarget(cwd, args);

  // Default includes the CI/conflict signals — a red PR is always worth a wake.
  const fireOn =
    Array.isArray(args.fire_on) && args.fire_on.length
      ? args.fire_on
      : ['new_review', 'new_comment', 'ci_failed', 'conflicts'];

  // Baseline poll: capture current state as the watermark so we DON'T fire on
  // history, and fail fast if the PR is unreachable or already closed.
  const { snap, err } = await fetchPrSnapshot(owner, repo, number);
  if (err) {
    const kind = classifyGhError(err.status, err.stderr);
    throw new Error(
      kind === 'gone'
        ? `PR ${owner}/${repo}#${number} not found (or no access).`
        : kind === 'auth'
          ? `GitHub auth error reaching ${owner}/${repo}#${number} — check gh auth.`
          : `could not reach ${owner}/${repo}#${number}: ${(err.stderr || '').slice(0, 200)}`
    );
  }
  if (snap!.meta?.merged || snap!.meta?.state === 'closed')
    throw new Error(`PR ${owner}/${repo}#${number} is already ${snap!.meta?.merged ? 'merged' : 'closed'} — nothing to watch.`);

  const baseline = diffPr(snap!, {}, { fireOn });
  const now = Date.now();
  const intervalSec = Number(args.interval_sec) > 0 ? Number(args.interval_sec) : DEFAULT_INTERVAL_SEC;
  const ttlDays = Number(args.ttl_days) > 0 ? Number(args.ttl_days) : DEFAULT_TTL_DAYS;

  const listener = addListener({
    sessionId,
    type: 'github-pr',
    label: `PR #${number}`,
    params: { owner, repo, number },
    fireOn,
    watermark: baseline.nextWatermark as Record<string, unknown>,
    ttlAt: now + ttlDays * 86_400_000,
    intervalSec,
    nextPollAt: now + intervalSec * 1000,
  });
  llog(listener.id, 'info', `armed — watching ${owner}/${repo}#${number} for ${fireOn.join(', ')} (every ${intervalSec}s, baseline captured)`);
  return listener;
}

export async function registerLinearIssueListener(
  sessionId: string,
  args: { issue_id?: string; issueId?: string; fire_on?: string[]; ttl_days?: number; interval_sec?: number }
): Promise<Listener> {
  const s = getSession(sessionId);
  if (!s) throw new Error(`unknown session: ${sessionId}`);
  const issueRef = String(args.issue_id || args.issueId || '').trim();
  if (!issueRef) throw new Error('issue_id required — a Linear identifier (e.g. ENG-1234) or UUID');

  const fireOn =
    Array.isArray(args.fire_on) && args.fire_on.length ? args.fire_on : ['new_comment'];

  // Baseline poll: capture current comments/status/assignee as the watermark so
  // we DON'T fire on history, and fail fast if the issue is unreachable or done.
  const { snap, err } = await fetchLinearIssueSnapshot(issueRef);
  if (err) {
    const kind = classifyLinearError(err.status, err.message);
    throw new Error(
      kind === 'gone'
        ? `Linear issue ${issueRef} not found (or no access).`
        : kind === 'auth'
          ? `Linear auth error reaching ${issueRef} — connect Linear from the host settings.`
          : `could not reach Linear for ${issueRef}: ${(err.message || '').slice(0, 200)}`
    );
  }
  const stateType = snap!.state?.type;
  if (stateType === 'completed' || stateType === 'canceled')
    throw new Error(`Linear issue ${snap!.identifier} is already ${stateType} — nothing to watch.`);

  // The session's own Linear user — the equivalent of github-pr's ignoreLogin.
  // Best-effort: with no viewer id we just don't filter self-comments.
  const viewerId = (await linear.viewerId().catch(() => null)) || undefined;
  const baseline = diffLinearIssue(snap!, {}, { fireOn });
  const now = Date.now();
  const intervalSec = Number(args.interval_sec) > 0 ? Number(args.interval_sec) : DEFAULT_INTERVAL_SEC;
  const ttlDays = Number(args.ttl_days) > 0 ? Number(args.ttl_days) : DEFAULT_TTL_DAYS;

  const listener = addListener({
    sessionId,
    type: 'linear-issue',
    label: `${snap!.identifier} comments`,
    // Keep the human identifier as the poll key (readable in the UI/logs); the
    // UUID rides along for anything that needs the stable id.
    params: { issueId: snap!.identifier || issueRef, uuid: snap!.id, viewerId },
    fireOn,
    watermark: baseline.nextWatermark as Record<string, unknown>,
    ttlAt: now + ttlDays * 86_400_000,
    intervalSec,
    nextPollAt: now + intervalSec * 1000,
  });
  llog(listener.id, 'info', `armed — watching ${snap!.identifier} for ${fireOn.join(', ')} (every ${intervalSec}s, baseline captured)`);
  return listener;
}

// Parse a Slack target from explicit args or a Slack archive URL:
//   .../archives/C0123ABCD                 → { channelId }
//   .../archives/C0123ABCD/p1699999999123  → { channelId, threadTs: 1699999999.123 }
function parseSlackTarget(args: {
  channel_id?: string;
  channelId?: string;
  thread_ts?: string;
  url?: string;
}): { channelId: string; threadTs?: string } {
  const explicit = String(args.channel_id || args.channelId || '').trim();
  if (explicit) {
    const ts = String(args.thread_ts || '').trim() || undefined;
    return { channelId: explicit, threadTs: ts };
  }
  const m = /\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/.exec(args.url || '');
  if (m) return { channelId: m[1], threadTs: m[2] && m[3] ? `${m[2]}.${m[3]}` : undefined };
  throw new Error('channel_id required — a Slack channel/DM id (e.g. C0123ABCD / D0123ABCD) or a message url');
}

export async function registerSlackListener(
  sessionId: string,
  args: {
    channel_id?: string;
    channelId?: string;
    thread_ts?: string;
    url?: string;
    fire_on?: string[];
    ttl_days?: number;
    interval_sec?: number;
  }
): Promise<Listener> {
  const s = getSession(sessionId);
  if (!s) throw new Error(`unknown session: ${sessionId}`);
  if (!slack.getToken())
    throw new Error('Slack is not connected — add a user token in the host settings, then re-arm.');

  const { channelId, threadTs } = parseSlackTarget(args);
  const fireOn =
    Array.isArray(args.fire_on) && args.fire_on.length ? args.fire_on : ['new_message'];

  // Channel name/DM flag for the label + summary (best-effort — never blocks arming).
  const info = (await slack.conversationInfo(channelId).catch(() => null)) || {};

  // Baseline poll: capture the current window as the watermark so we DON'T fire
  // on history, and fail fast if the channel is unreachable / not authed.
  const { snap, err } = await fetchSlackSnapshot(channelId, threadTs, undefined, {
    channelName: info.name,
    isDm: info.isDm,
  });
  if (err) {
    const kind = classifySlackError(err.status, err.error);
    throw new Error(
      kind === 'gone'
        ? `Slack channel ${channelId} not found or the token isn't a member (${err.error}).`
        : kind === 'auth'
          ? `Slack auth error reaching ${channelId} (${err.error}) — refresh the user token in the host settings.`
          : `could not reach Slack for ${channelId}: ${err.error}`
    );
  }

  const viewerId = (await slack.viewerId().catch(() => null)) || undefined;
  const baseline = diffSlack(snap!, {}, { fireOn });
  const now = Date.now();
  const intervalSec = Number(args.interval_sec) > 0 ? Number(args.interval_sec) : DEFAULT_INTERVAL_SEC;
  const ttlDays = Number(args.ttl_days) > 0 ? Number(args.ttl_days) : DEFAULT_TTL_DAYS;
  const label = threadTs
    ? `${info.name || channelId} thread`
    : `${info.isDm ? 'DM' : info.name || channelId} messages`;

  const listener = addListener({
    sessionId,
    type: 'slack',
    label,
    params: { channelId, threadTs, viewerId, channelName: info.name, isDm: info.isDm },
    fireOn,
    watermark: baseline.nextWatermark as Record<string, unknown>,
    ttlAt: now + ttlDays * 86_400_000,
    intervalSec,
    nextPollAt: now + intervalSec * 1000,
  });
  llog(listener.id, 'info', `armed — watching ${label} for ${fireOn.join(', ')} (every ${intervalSec}s, baseline captured)`);
  return listener;
}

export async function registerWhatsappListener(
  sessionId: string,
  args: { db_path?: string; ttl_days?: number; interval_sec?: number; group_jid?: string }
): Promise<Listener> {
  const s = getSession(sessionId);
  if (!s) throw new Error(`unknown session: ${sessionId}`);
  const dbPath = args.db_path || WA_DB_PATH;
  // Resolve phone-number JIDs to their active LID equivalent if one exists.
  const rawJid = args.group_jid || null;
  const groupJid = rawJid ? resolveActiveJid(dbPath, rawJid) : null;

  // Ensure the bridge process is running. If not paired, startBridge will
  // open a QR code in the browser AND wake the session with scan instructions.
  if (!isBridgeRunning()) {
    const paired = isPaired();
    llog('whatsapp-bridge', 'info', paired ? 'starting bridge (already paired)' : 'starting bridge — QR scan required');
    await startBridge(sessionId, enqueueWake);
    if (!paired) {
      enqueueWake(
        sessionId,
        '📱 WhatsApp is not yet paired. A browser window will open with a QR code — scan it with your phone to connect.',
        `wa:setup:${sessionId}`
      );
    }
  }

  // If tracking a group, add it to the subscription table so the bridge starts storing its messages.
  if (groupJid) {
    addGroupSubscription(dbPath, groupJid);
    llog('whatsapp-bridge', 'info', `subscribed to group: ${groupJid}`);
  }

  // Baseline watermark: "now" so we don't replay history.
  const since = new Date().toISOString();
  const now = Date.now();
  const intervalSec = Number(args.interval_sec) > 0 ? Number(args.interval_sec) : 10;
  const ttlDays = Number(args.ttl_days) > 0 ? Number(args.ttl_days) : DEFAULT_TTL_DAYS;

  const isGroup = groupJid?.endsWith('@g.us') ?? false;
  const label = groupJid
    ? isGroup ? `WhatsApp group ${groupJid}` : `WhatsApp DM ${groupJid}`
    : 'WhatsApp messages';
  const listener = addListener({
    sessionId,
    type: 'whatsapp',
    label,
    params: { dbPath, groupJid },
    fireOn: ['new_message'],
    watermark: { since } as Record<string, unknown>,
    ttlAt: now + ttlDays * 86_400_000,
    intervalSec,
    nextPollAt: now + intervalSec * 1000,
  });
  llog(listener.id, 'info', `armed — polling WhatsApp DB every ${intervalSec}s${groupJid ? ` (group: ${groupJid})` : ''} (bridge running: ${isBridgeRunning()})`);
  return listener;
}

// ---- SMS webhook listener ---------------------------------------------------

export function registerSmsListener(sessionId: string, args: Record<string, any>) {
  const s = getSession(sessionId);
  if (!s) throw new Error(`unknown session: ${sessionId}`);

  const since = new Date().toISOString();
  const now = Date.now();
  const intervalSec = Number(args.interval_sec) > 0 ? Number(args.interval_sec) : 5;
  const ttlDays = Number(args.ttl_days) > 0 ? Number(args.ttl_days) : DEFAULT_TTL_DAYS;
  const fromFilter = args.from_filter || null; // optional: only SMS from this number

  const label = fromFilter ? `SMS from ${fromFilter}` : 'SMS messages';
  const listener = addListener({
    sessionId,
    type: 'sms',
    label,
    params: { fromFilter },
    fireOn: ['new_sms'],
    watermark: { since } as Record<string, unknown>,
    ttlAt: now + ttlDays * 86_400_000,
    intervalSec,
    nextPollAt: now + intervalSec * 1000,
  });
  llog(listener.id, 'info', `armed — polling SMS inbox every ${intervalSec}s${fromFilter ? ` (from: ${fromFilter})` : ''}`);
  return listener;
}

// Clean up group subscription when a whatsapp listener is removed.
export function removeWhatsappListener(id: string): boolean {
  const l = getListener(id);
  if (!l) return false;
  if (l.type === 'whatsapp') {
    const { dbPath, groupJid } = l.params as { dbPath: string; groupJid?: string | null };
    if (groupJid) {
      // Only remove subscription if no other active listener is watching this group
      const others = listListeners().filter(
        (o) => o.id !== id && o.type === 'whatsapp' &&
          (o.params as any)?.groupJid === groupJid && o.status === 'watching'
      );
      if (others.length === 0) {
        removeGroupSubscription(dbPath, groupJid);
        llog('whatsapp-bridge', 'info', `unsubscribed from group: ${groupJid}`);
      }
    }
  }
  return stateRemoveListener(id);
}

// Auto-armed by the host when a master spawns a worker (decision 15). Watches the
// worker session and wakes the MASTER on crash/stall. Poll cadence is derived
// from the stall threshold so a stall is caught within a fraction of it.
export function registerWorkerWatchdog(
  masterId: string,
  workerId: string,
  subtask: string | null
): Listener {
  const now = Date.now();
  const stallSec = cfg.dispatcher?.stallTimeoutSec || 600;
  const intervalSec = Math.max(15, Math.min(60, Math.round(stallSec / 8)));
  const listener = addListener({
    sessionId: masterId,
    type: 'worker',
    label: `watchdog ${subtask || workerId}`,
    params: { workerId, subtask: subtask || null },
    fireOn: ['dead', 'stall'],
    watermark: { lastState: null, lastStallActivity: 0 },
    ttlAt: now + 7 * 86_400_000,
    intervalSec,
    nextPollAt: now + intervalSec * 1000,
  });
  llog(listener.id, 'info', `armed — watching worker ${workerId} (${subtask || '—'}) for crash/stall (every ${intervalSec}s)`);
  return listener;
}
