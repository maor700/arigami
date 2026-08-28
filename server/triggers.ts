// Triggers + the Pending-tasks queue. See docs/TRIGGERS.md.
//
// A trigger is a PURE PRODUCER: it polls a source (v1: a Linear filter) and drops
// matching tickets into the Pending queue. All automation POLICY lives on the
// queue — a single autoplay switch + a global maxConcurrent cap. Starting a
// pending item spins up an ordinary ticket session (via the same
// startTicketSession the launcher uses), so a triggered session is identical to a
// hand-launched one — including which skill/model/effort it runs with, which the
// trigger captured at creation time since no human is present when it fires.
//
// Persistence: ~/.arigami/triggers.json (debounced), independent of state.json.
import fs from 'node:fs';
import path from 'node:path';
import { broadcast } from './bus.js';
import { cfg, nano } from './state.js';
import * as state from './state.js';

const STORE = path.join(
  cfg.configDir || path.join(process.env.HOME || '.', '.arigami'),
  'triggers.json'
);

const POLL_MS = 60_000; // global poll cadence (decision: not per-trigger in v1)
const DRAIN_MS = 15_000; // autoplay drain check (local-only, cheap)
const FETCH_LIMIT = 100; // higher than the picker's 50 so reconcile rarely truncates

export interface Trigger {
  id: string;
  type: 'linear-filter';
  name: string;
  enabled: boolean;
  autonomous: boolean; // skip ALL questions — run unattended (bypass perms + no-pause directive)
  injectPrompt: string; // extra instructions appended to the task prompt on start
  skill?: string; // skill dir name to run (e.g. 'onboarding'); '' = plain ticket prompt
  model?: string; // `claude --model` value; '' = CLI default
  effort?: string; // `claude --effort` value; '' = CLI default
  filters: Record<string, unknown>; // FilterBar facet shape (assignee/state/labels/labelOp/…)
  seen: string[]; // high-water mark; dismissed items stay here
  primed: boolean; // false until the first successful fetch seeds `seen`
  createdSessions: { ticket: string; sessionId: string; at: string }[];
  createdAt: string;
  lastPolledAt?: number;
  lastError?: string | null;
}

export interface PendingItem {
  id: string;
  kind: 'ticket' | 'empty'; // ticket → ticket session; empty → plain session
  title: string;
  triggerId: string | null; // null = manually deferred (no trigger)
  triggerName: string;
  addedAt: string;
  ticket?: string; // kind 'ticket' — identifier, e.g. ENG-123 (uppercase)
  cwd?: string; // kind 'empty'
  permissionMode?: string; // kind 'empty'
  prompt?: string; // custom starting prompt (overrides the default on start)
  skill?: string; // skill dir name to run; '' = plain prompt
  model?: string; // `claude --model` value; '' = CLI default
  effort?: string; // `claude --effort` value; '' = CLI default
}

interface QueueSettings {
  autoplay: boolean;
  maxConcurrent: number;
}

const db: {
  triggers: Map<string, Trigger>;
  pending: PendingItem[]; // ordered; order IS the autoplay execution order
  settings: QueueSettings;
} = {
  triggers: new Map(),
  pending: [],
  settings: { autoplay: false, maxConcurrent: 3 },
};

// ---- persistence ----------------------------------------------------------
// `load()` runs only inside startTriggerScheduler (in the server.listen
// callback). If the port bind fails, or a SIGTERM/SIGINT arrives before listen
// fires (fast restart loops, K8s probe kills), shutdown() still calls flush() —
// which would write the empty in-memory `db` over the real file, wiping every
// trigger, its `seen` watermark (→ mass re-firing), and the pending queue.
// Gate writes on having actually loaded first.
let loaded = false;
function load(): void {
  loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8')) as {
      triggers?: Trigger[];
      pending?: PendingItem[];
      settings?: Partial<QueueSettings>;
    };
    for (const t of j.triggers || []) {
      // Back-compat: records created before autonomous/injectPrompt existed.
      if (typeof t.autonomous !== 'boolean') t.autonomous = false;
      if (typeof t.injectPrompt !== 'string') t.injectPrompt = '';
      db.triggers.set(t.id, t);
    }
    db.pending = (Array.isArray(j.pending) ? j.pending : []).map((p) => ({
      ...p,
      kind: p.kind || (p.ticket ? 'ticket' : 'empty'), // back-compat: pre-kind records
    }));
    db.settings = {
      autoplay: !!j.settings?.autoplay,
      maxConcurrent: clampConcurrent(j.settings?.maxConcurrent),
    };
  } catch {}
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 500);
}
export function flush(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  // Never persist a db we never loaded — that would clobber the on-disk store
  // with defaults (see the `loaded` note above).
  if (!loaded) return;
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(
      STORE,
      JSON.stringify(
        {
          triggers: [...db.triggers.values()],
          pending: db.pending,
          settings: db.settings,
        },
        null,
        2
      )
    );
  } catch (e) {
    console.error('[triggers] persist failed:', (e as Error).message);
  }
}

function clampConcurrent(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 3;
  return Math.min(10, Math.max(1, Math.round(v)));
}

// ---- activity log (in-memory ring buffer, for the trigger details modal) ----
const MAX_LOG = 200;
const logs = new Map<string, { ts: number; level: string; text: string }[]>();
function tlog(id: string, level: 'info' | 'fire' | 'warn' | 'error', text: string): void {
  const arr = logs.get(id) || [];
  arr.push({ ts: Date.now(), level, text });
  if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG);
  logs.set(id, arr);
}
export function getTriggerLog(id: string): { ts: number; level: string; text: string }[] {
  return logs.get(id) || [];
}

// ---- broadcasts -----------------------------------------------------------
function emitTriggers(): void {
  broadcast({ type: 'triggers', triggers: [...db.triggers.values()] });
}
function emitPending(): void {
  broadcast({ type: 'pending', pending: db.pending, queue: db.settings });
}

// ---- reads (for the WS snapshot + REST) -----------------------------------
export function listTriggers(): Trigger[] {
  return [...db.triggers.values()];
}
export function snapshot(): {
  triggers: Trigger[];
  pending: PendingItem[];
  queue: QueueSettings;
} {
  return {
    triggers: [...db.triggers.values()],
    pending: db.pending,
    queue: db.settings,
  };
}

// ---- ticket/session helpers ----------------------------------------------
function issueId(it: any): string {
  return String(it?.identifier || it?.id || it?.key || '').toUpperCase();
}
function issueTitle(it: any): string {
  return String(it?.title || it?.name || '');
}

// A live (non-archived, not-dead) session already working this ticket.
function liveTicketSession(ticket: string): boolean {
  const up = ticket.toUpperCase();
  return state.listSessions().some(
    (s: any) =>
      String(s.metadata?.ticket || '').toUpperCase() === up &&
      s.claude?.state !== 'dead'
  );
}

// Live sessions started FROM the queue (auto or manual Play) — the maxConcurrent
// budget. Direct launcher ticket sessions don't count.
function countQueueSessions(): number {
  return state
    .listSessions()
    .filter((s: any) => s.metadata?.fromQueue && s.claude?.state !== 'dead').length;
}

async function fetchMatches(filters: Record<string, unknown>): Promise<any[]> {
  const mcp = await import('./linear-mcp.js');
  return mcp.listIssuesByFacets({ ...filters, limit: FETCH_LIMIT });
}

// ---- pending queue --------------------------------------------------------
function pendingHas(ticket: string, triggerId: string | null): boolean {
  const up = ticket.toUpperCase();
  return db.pending.some(
    (p) => p.ticket?.toUpperCase() === up && p.triggerId === triggerId
  );
}

function enqueue(item: Omit<PendingItem, 'id' | 'addedAt'>): void {
  db.pending.push({ id: 'pend_' + nano(), addedAt: new Date().toISOString(), ...item });
}

// Drop every pending row for a ticket (e.g. once it has a live session).
function removePendingByTicket(ticket: string): void {
  const up = ticket.toUpperCase();
  db.pending = db.pending.filter((p) => p.ticket?.toUpperCase() !== up);
}

export function dismissPending(id: string): boolean {
  const item = db.pending.find((p) => p.id === id);
  if (!item) return false;
  db.pending = db.pending.filter((p) => p.id !== id);
  // Keep the ticket in its trigger's `seen` so it won't reappear next poll.
  if (item.triggerId && item.ticket) {
    const t = db.triggers.get(item.triggerId);
    const up = item.ticket.toUpperCase();
    if (t && !t.seen.includes(up)) t.seen.push(up);
  }
  persist();
  emitPending();
  return true;
}

// Reorder the queue (= autoplay execution order) to the given id sequence.
export function reorderPending(orderedIds: string[]): boolean {
  const byId = new Map(db.pending.map((p) => [p.id, p]));
  const next: PendingItem[] = [];
  for (const id of orderedIds) {
    const p = byId.get(id);
    if (p) {
      next.push(p);
      byId.delete(id);
    }
  }
  for (const p of byId.values()) next.push(p); // keep any not named, at the end
  db.pending = next;
  persist();
  emitPending();
  return true;
}

// Add a manually-deferred ticket (no trigger) to the queue.
export function deferTicket(
  ticket: string,
  title?: string,
  prompt?: string,
  opts?: { skill?: string; model?: string; effort?: string }
): PendingItem | null {
  const up = String(ticket || '').toUpperCase();
  if (!up) return null;
  if (pendingHas(up, null) || liveTicketSession(up)) return null;
  enqueue({
    kind: 'ticket',
    ticket: up,
    title: title || up,
    prompt,
    triggerId: null,
    triggerName: 'Manual',
    skill: opts?.skill,
    model: opts?.model,
    effort: opts?.effort,
  });
  persist();
  emitPending();
  return db.pending[db.pending.length - 1];
}

// Add a manually-deferred EMPTY (plain) session to the queue. No ticket — start
// spins up a blank session with these params instead of a ticket workflow.
export function deferEmpty(opts: {
  title?: string;
  cwd?: string;
  permissionMode?: string;
  prompt?: string;
  skill?: string;
  model?: string;
  effort?: string;
}): PendingItem {
  enqueue({
    kind: 'empty',
    title: (opts.title || '').trim() || 'scratch',
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    prompt: opts.prompt,
    skill: opts.skill,
    model: opts.model,
    effort: opts.effort,
    triggerId: null,
    triggerName: 'Manual',
  });
  persist();
  emitPending();
  return db.pending[db.pending.length - 1];
}

// Start a pending item → a session, remove the row (+ any
// duplicate rows for the same ticket from other triggers).
export async function startPending(
  id: string
): Promise<{ sessionId: string } | { held: true; reason: string } | null> {
  const item = db.pending.find((p) => p.id === id);
  if (!item) return null;
  const api = await import('./api.js');

  // Empty (plain) pending item → blank session, no ticket workflow.
  if (item.kind === 'empty') {
    const { id: sessionId } = api.startEmptySession({
      title: item.title,
      cwd: item.cwd,
      permissionMode: item.permissionMode,
      prompt: item.prompt,
      skill: item.skill,
      model: item.model,
      effort: item.effort,
      metadata: { fromQueue: true },
    });
    db.pending = db.pending.filter((p) => p.id !== id);
    persist();
    emitPending();
    return { sessionId };
  }

  const ticket = item.ticket!;
  const t = item.triggerId ? db.triggers.get(item.triggerId) : null;

  // Trigger-readiness gate: never fire a ticket session into an unprovisioned
  // workspace (it would dead-end on the missing workspace). The item stays
  // queued and retries on the next drain once onboarding makes a repo ready.
  const onboarding = await import('./onboarding.js');
  if (!onboarding.workspaceReady()) {
    if (item.triggerId)
      tlog(
        item.triggerId,
        'warn',
        `held ${ticket} — workspace not ready; run onboarding (Setup / arigami:onboarding)`
      );
    return { held: true, reason: 'workspace-not-ready' };
  }

  const { id: sessionId } = api.startTicketSession({
    ticket,
    title: item.title,
    ...(item.prompt ? { prompt: item.prompt } : {}),
    skill: item.skill ?? t?.skill,
    model: item.model ?? t?.model,
    effort: item.effort ?? t?.effort,
    metadata: {
      fromQueue: true,
      ...(item.triggerId
        ? { fromTrigger: item.triggerId, fromTriggerName: item.triggerName }
        : {}),
      ...(t?.autonomous ? { autonomous: true } : {}),
    },
    autonomous: t?.autonomous,
    injectPrompt: t?.injectPrompt,
  });
  if (t && item.triggerId) {
    if (!t.seen.includes(ticket.toUpperCase())) t.seen.push(ticket.toUpperCase());
    t.createdSessions.push({ ticket, sessionId, at: new Date().toISOString() });
    tlog(
      item.triggerId,
      'fire',
      `started ${ticket} → session ${sessionId}${t.autonomous ? ' (autonomous)' : ''}`
    );
  }
  removePendingByTicket(ticket);
  persist();
  emitTriggers();
  emitPending();
  return { sessionId };
}

// Autoplay: start queue items top-down until the maxConcurrent budget is full.
export async function drain(): Promise<void> {
  // Prune ticket rows whose ticket already has a live session (empty rows never
  // go stale — they have no ticket).
  const before = db.pending.length;
  db.pending = db.pending.filter((p) => p.kind === 'empty' || !liveTicketSession(p.ticket!));
  if (db.pending.length !== before) {
    persist();
    emitPending();
  }
  if (!db.settings.autoplay) return;
  let slots = db.settings.maxConcurrent - countQueueSessions();
  let i = 0;
  // Skip held items (workspace-not-ready) instead of blocking the queue head on
  // them; a started item removes its row so the next shifts into [i].
  while (slots > 0 && i < db.pending.length) {
    const r = await startPending(db.pending[i].id);
    if (r && 'sessionId' in r) slots--;
    else i++;
  }
}

// ---- queue settings -------------------------------------------------------
export function setQueueSettings(patch: Partial<QueueSettings>): QueueSettings {
  if (typeof patch.autoplay === 'boolean') db.settings.autoplay = patch.autoplay;
  if (patch.maxConcurrent != null) db.settings.maxConcurrent = clampConcurrent(patch.maxConcurrent);
  persist();
  emitPending();
  if (db.settings.autoplay) void drain();
  return db.settings;
}

// ---- trigger CRUD ---------------------------------------------------------
export async function createTrigger(input: {
  name?: string;
  filters?: Record<string, unknown>;
  autonomous?: boolean;
  injectPrompt?: string;
  skill?: string;
  model?: string;
  effort?: string;
}): Promise<Trigger> {
  const t: Trigger = {
    id: 'trig_' + nano(),
    type: 'linear-filter',
    name: (input.name || '').trim() || 'Untitled trigger',
    enabled: true,
    autonomous: !!input.autonomous,
    injectPrompt: typeof input.injectPrompt === 'string' ? input.injectPrompt : '',
    skill: typeof input.skill === 'string' ? input.skill : '',
    model: typeof input.model === 'string' ? input.model : '',
    effort: typeof input.effort === 'string' ? input.effort : '',
    filters: input.filters && typeof input.filters === 'object' ? input.filters : {},
    seen: [],
    primed: false,
    createdSessions: [],
    createdAt: new Date().toISOString(),
    lastError: null,
  };
  // Prime: seed `seen` with everything currently matching, WITHOUT queuing — so
  // the trigger only fires on tickets that enter the filter after arming.
  try {
    const matches = await fetchMatches(t.filters);
    t.seen = matches.map(issueId).filter(Boolean);
    t.primed = true;
    t.lastPolledAt = Date.now();
  } catch (e) {
    // Couldn't reach Linear yet — leave unprimed; the first good poll primes it.
    t.lastError = (e as Error).message;
  }
  db.triggers.set(t.id, t);
  tlog(
    t.id,
    t.primed ? 'info' : 'warn',
    t.primed
      ? `armed — primed ${t.seen.length} existing match(es); will fire only on new entrants`
      : `armed — Linear unreachable (${t.lastError}); will prime on first successful poll`
  );
  persist();
  emitTriggers();
  return t;
}

export function patchTrigger(id: string, patch: Partial<Trigger>): Trigger | null {
  const t = db.triggers.get(id);
  if (!t) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) t.name = patch.name.trim();
  if (typeof patch.enabled === 'boolean') t.enabled = patch.enabled;
  if (typeof patch.autonomous === 'boolean') t.autonomous = patch.autonomous;
  if (typeof patch.injectPrompt === 'string') t.injectPrompt = patch.injectPrompt;
  if (typeof patch.skill === 'string') t.skill = patch.skill;
  if (typeof patch.model === 'string') t.model = patch.model;
  if (typeof patch.effort === 'string') t.effort = patch.effort;
  if (patch.filters && typeof patch.filters === 'object') {
    t.filters = patch.filters;
    // Filter changed → re-prime so old matches under the new filter don't all fire.
    t.primed = false;
  }
  persist();
  emitTriggers();
  return t;
}

export function deleteTrigger(id: string): boolean {
  if (!db.triggers.delete(id)) return false;
  logs.delete(id); // drop the in-memory activity ring buffer for this trigger
  // Drop this trigger's still-queued items (its produced rows go with it).
  const before = db.pending.length;
  db.pending = db.pending.filter((p) => p.triggerId !== id);
  persist();
  emitTriggers();
  if (db.pending.length !== before) emitPending();
  return true;
}

// ---- poll runner ----------------------------------------------------------
async function pollTrigger(t: Trigger): Promise<void> {
  let matches: any[];
  try {
    matches = await fetchMatches(t.filters);
  } catch (e) {
    t.lastError = (e as Error).message;
    t.lastPolledAt = Date.now();
    tlog(t.id, 'error', `poll failed: ${t.lastError}`);
    return;
  }
  t.lastError = null;
  t.lastPolledAt = Date.now();

  const ids = matches.map(issueId).filter(Boolean);
  const matchSet = new Set(ids);

  if (!t.primed) {
    // First successful contact for a trigger created while Linear was down:
    // seed `seen`, queue nothing.
    t.seen = ids;
    t.primed = true;
    tlog(t.id, 'info', `primed ${ids.length} match(es) on first contact`);
    return;
  }

  const seen = new Set(t.seen);
  let added = false;
  let queued = 0;
  for (const it of matches) {
    const id = issueId(it);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    t.seen.push(id); // mark seen regardless of whether we queue
    if (liveTicketSession(id)) {
      tlog(t.id, 'info', `${id} entered filter but already has a live session — skipped`);
      continue;
    }
    if (pendingHas(id, t.id)) continue;
    enqueue({ kind: 'ticket', ticket: id, title: issueTitle(it), triggerId: t.id, triggerName: t.name });
    tlog(t.id, 'fire', `queued ${id} · ${issueTitle(it) || '(no title)'}`);
    added = true;
    queued++;
  }

  // Reconcile: drop this trigger's queued rows that no longer match — but only
  // when we have the COMPLETE set (an untruncated page), to avoid false drops.
  if (matches.length < FETCH_LIMIT) {
    const before = db.pending.length;
    const keep = db.pending.filter(
      (p) => p.triggerId !== t.id || matchSet.has(p.ticket?.toUpperCase() ?? '')
    );
    if (keep.length !== before) {
      tlog(t.id, 'warn', `reconciled — dropped ${before - keep.length} stale queued item(s)`);
      db.pending = keep;
      added = true;
    }
  }

  // Per-poll heartbeat so the modal shows the pulling logic running.
  tlog(t.id, 'info', `polled · ${matches.length} match${queued ? ` · ${queued} new → queued` : ' · nothing new'}`);

  if (added) emitPending();
}

async function pollAll(): Promise<void> {
  const enabled = [...db.triggers.values()].filter((t) => t.enabled);
  for (const t of enabled) {
    try {
      await pollTrigger(t);
    } catch (e) {
      t.lastError = (e as Error).message;
    }
  }
  if (enabled.length) {
    persist();
    emitTriggers();
  }
  await drain();
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let drainTimer: ReturnType<typeof setInterval> | null = null;

export function startTriggerScheduler(): void {
  load();
  if (pollTimer) return;
  // First poll shortly after boot (give Linear OAuth a moment to settle).
  setTimeout(() => void pollAll(), 3_000);
  pollTimer = setInterval(() => void pollAll(), POLL_MS);
  drainTimer = setInterval(() => void drain(), DRAIN_MS);
  console.log('[triggers] scheduler started');
}
