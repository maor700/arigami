// Triggers + the Pending-tasks queue. See docs/TRIGGERS.md.
//
// Two trigger kinds share one poll loop + persisted registry:
// - 'linear-filter' — a PURE PRODUCER: polls a Linear filter and drops matching
//   tickets into the Pending queue. All automation POLICY lives on the queue —
//   a single autoplay switch + a global maxConcurrent cap. Starting a pending
//   item spins up an ordinary ticket session (via the same startTicketSession
//   the launcher uses), so a triggered session is identical to a hand-launched
//   one — including which skill/model/effort it runs with, which the trigger
//   captured at creation time since no human is present when it fires.
// - 'cron' — a general-purpose, agent-callable schedule (cron expr/interval/
//   one-shot). Fires an isolated session or delivers into an existing one,
//   sharing the Pending queue's maxConcurrent budget rather than a parallel
//   one. See docs/TRIGGERS.md "Cron".
//
// Persistence: ~/.arigami/triggers.json (debounced), independent of state.json.
import fs from 'node:fs';
import path from 'node:path';
import { broadcast } from './bus.js';
import { cfg, nano } from './state.js';
import * as state from './state.js';
import * as cronSchedule from './cron-schedule.js';
import { migrateFile, stamp, SchemaVersionError } from './lib/schema-version.js';
import { TRIGGERS_SCHEMA } from './lib/state-schemas.js';
import type { Schedule } from './cron-schedule.js';

const STORE = path.join(
  cfg.configDir!,
  'triggers.json'
);

const POLL_MS = 60_000; // global poll cadence (decision: not per-trigger in v1)
const DRAIN_MS = 15_000; // autoplay drain check (local-only, cheap)
const FETCH_LIMIT = 100; // higher than the picker's 50 so reconcile rarely truncates

export interface LinearFilterTrigger {
  id: string;
  type: 'linear-filter';
  name: string;
  enabled: boolean;
  autonomous: boolean; // skip ALL questions — run unattended (bypass perms + no-pause directive)
  injectPrompt: string; // extra instructions appended to the task prompt on start
  skill?: string; // skill dir name to run (e.g. 'onboarding'); '' = plain ticket prompt
  model?: string; // engine model value; '' = engine default
  effort?: string; // reasoning-effort value; '' = engine default
  engine?: string; // 'claude' (default) | 'codex' — which CLI its sessions run on
  filters: Record<string, unknown>; // FilterBar facet shape (assignee/state/labels/labelOp/…)
  seen: string[]; // high-water mark; dismissed items stay here
  primed: boolean; // false until the first successful fetch seeds `seen`
  createdSessions: { ticket: string; sessionId: string; at: string }[];
  createdAt: string;
  lastPolledAt?: number;
  lastError?: string | null;
}

// A general-purpose, agent-callable schedule (see docs/TRIGGERS.md "Cron").
// `sessionMode: 'isolated'` spawns a fresh session per run (closed/archived on
// a terminal report_to_master); `'existing:<sessionId>'` delivers the prompt
// into a running session via the same idle/busy channel task_session uses.
export interface CronDeliver {
  push?: boolean; // web-push on completion (default true — decision: push is the default channel)
  /** JID to notify, or `true` for config.notify.whatsappJid. Real since notify.ts. */
  whatsapp?: string | boolean;
  master?: string; // session id to wake with a thin pointer, like report_to_master
}

export interface CronRun {
  at: string; // ISO
  sessionId: string | null;
  state: 'started' | 'done' | 'blocked' | 'error' | 'milestone' | 'held';
  summary?: string;
}

export interface CronTrigger {
  id: string;
  type: 'cron';
  name: string;
  enabled: boolean;
  schedule: Schedule;
  prompt: string;
  sessionMode: string; // 'isolated' | 'existing:<sessionId>'
  deliver: CronDeliver;
  autonomous: boolean; // isolated runs only: bypassPermissions + no-questions directive
  bundleKey?: string; // "<bundle>/<slug>" when registered from a Profile Bundle — re-applying the bundle updates this trigger instead of adding another (F4 #2)
  agent?: string | null; // A2: isolated runs are born from this agent (create_session({agent}) path) — the agent's "שגרה"
  createdAt: string;
  createdBySessionId?: string | null; // provenance; also what the create-guard checks upstream
  lastRun: number | null; // ms epoch of the last fire attempt
  lastError?: string | null;
  runs: CronRun[]; // bounded run history (see MAX_CRON_RUNS)
}

export type Trigger = LinearFilterTrigger | CronTrigger;

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
  model?: string; // engine model value; '' = engine default
  effort?: string; // reasoning-effort value; '' = engine default
  engine?: string; // 'claude' (default) | 'codex' — which CLI the started session runs on
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
// Exported for tests only (see test/cron-trigger.test.js) — startTriggerScheduler()
// also starts the poll/drain intervals, which would hang a one-shot test process.
export function load(): void {
  // Forward-migrate before the first read (lib/schema-version.ts). On a file
  // written by a NEWER build we leave `loaded` false, which the flush() guard
  // below already turns into "never write over the store" — the human's
  // triggers stay on disk, intact, for the build that understands them.
  try {
    migrateFile(STORE, TRIGGERS_SCHEMA);
  } catch (e) {
    if (e instanceof SchemaVersionError) {
      console.error(`[triggers] ${e.message} Triggers are not running this boot.`);
      return;
    }
    throw e;
  }
  loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8')) as {
      triggers?: Trigger[];
      pending?: PendingItem[];
      settings?: Partial<QueueSettings>;
    };
    for (const t of j.triggers || []) {
      if (typeof t.autonomous !== 'boolean') t.autonomous = false;
      if (t.type === 'cron') {
        const c = t as CronTrigger;
        if (!Array.isArray(c.runs)) c.runs = [];
        if (typeof c.lastRun !== 'number') c.lastRun = null;
        if (typeof c.lastError !== 'string') c.lastError = null;
        if (!c.deliver || typeof c.deliver !== 'object') c.deliver = { push: true };
      } else {
        // Back-compat: records created before injectPrompt existed.
        if (typeof (t as LinearFilterTrigger).injectPrompt !== 'string') (t as LinearFilterTrigger).injectPrompt = '';
      }
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
        stamp({
          triggers: [...db.triggers.values()],
          pending: db.pending,
          settings: db.settings,
        }, TRIGGERS_SCHEMA),
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
  broadcast({ type: 'triggers', triggers: withNextRun(listTriggers()) });
}
/** B33: decorate cron triggers with nextRunAt — the WS list (store.js overwrites the REST one) must carry it too. */
export function withNextRun<T extends { type: string }>(list: T[]): T[] {
  return list.map((x) => (x.type === 'cron' ? { ...x, nextRunAt: nextRunFor(x as unknown as CronTrigger) } : x));
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
  // (Only linear-filter triggers ever populate the pending queue.)
  if (item.triggerId && item.ticket) {
    const t = db.triggers.get(item.triggerId);
    const up = item.ticket.toUpperCase();
    if (t && t.type === 'linear-filter' && !t.seen.includes(up)) t.seen.push(up);
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
  opts?: { skill?: string; model?: string; effort?: string; engine?: string }
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
    engine: opts?.engine,
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
  engine?: string;
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
    engine: opts.engine,
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
      engine: item.engine,
      metadata: { fromQueue: true },
    });
    db.pending = db.pending.filter((p) => p.id !== id);
    persist();
    emitPending();
    return { sessionId };
  }

  const ticket = item.ticket!;
  // Only linear-filter triggers ever produce ticket pending items.
  const t0 = item.triggerId ? db.triggers.get(item.triggerId) : null;
  const t = t0 && t0.type === 'linear-filter' ? t0 : null;

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
    engine: item.engine ?? t?.engine,
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
  engine?: string;
}): Promise<LinearFilterTrigger> {
  const t: LinearFilterTrigger = {
    id: 'trig_' + nano(),
    type: 'linear-filter',
    name: (input.name || '').trim() || 'Untitled trigger',
    enabled: true,
    autonomous: !!input.autonomous,
    injectPrompt: typeof input.injectPrompt === 'string' ? input.injectPrompt : '',
    skill: typeof input.skill === 'string' ? input.skill : '',
    model: typeof input.model === 'string' ? input.model : '',
    effort: typeof input.effort === 'string' ? input.effort : '',
    // '' = claude, exactly like an absent Session.engine — a trigger armed
    // before engines existed keeps firing Claude sessions.
    engine: input.engine === 'codex' ? 'codex' : '',
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

// Patch shared + type-specific fields. Cron's `schedule` is re-validated
// (throws — the API route turns that into a 400) so a typo'd cron expression
// fails loudly instead of silently never firing again.
export function patchTrigger(id: string, patch: Record<string, unknown>): Trigger | null {
  const t = db.triggers.get(id);
  if (!t) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) t.name = patch.name.trim();
  if (typeof patch.enabled === 'boolean') t.enabled = patch.enabled;
  if (typeof patch.autonomous === 'boolean') t.autonomous = patch.autonomous;
  if (t.type === 'linear-filter') {
    if (typeof patch.injectPrompt === 'string') t.injectPrompt = patch.injectPrompt;
    if (typeof patch.skill === 'string') t.skill = patch.skill;
    if (typeof patch.model === 'string') t.model = patch.model;
    if (typeof patch.effort === 'string') t.effort = patch.effort;
    // Unlike create (where an unrecognized value just falls back to the
    // default), an unrecognized PATCH value is ignored: silently moving a live
    // codex trigger back onto claude because of a typo is the quiet wrong-CLI
    // failure this whole seam exists to avoid. 'claude'/'' set it explicitly.
    if (patch.engine === 'codex') t.engine = 'codex';
    else if (patch.engine === 'claude' || patch.engine === '') t.engine = '';
    if (patch.filters && typeof patch.filters === 'object') {
      t.filters = patch.filters as Record<string, unknown>;
      // Filter changed → re-prime so old matches under the new filter don't all fire.
      t.primed = false;
    }
  } else {
    if (typeof patch.prompt === 'string' && patch.prompt.trim()) t.prompt = patch.prompt.trim();
    if (typeof patch.bundleKey === 'string' && patch.bundleKey) t.bundleKey = patch.bundleKey;
    // A4: a bundle re-apply may adopt the agent its cron is born from ('' / null = none).
    if (t.type === 'cron' && (patch.agent === null || typeof patch.agent === 'string')) t.agent = patch.agent ? String(patch.agent) : null;
    if (typeof patch.sessionMode === 'string') {
      const sm = patch.sessionMode;
      if (sm !== 'isolated' && !(sm.startsWith('existing:') && sm.length > 'existing:'.length))
        throw new Error(`invalid sessionMode: "${sm}" (expected "isolated" or "existing:<sessionId>")`);
      t.sessionMode = sm;
    }
    if (patch.deliver && typeof patch.deliver === 'object')
      t.deliver = { ...t.deliver, ...(patch.deliver as CronDeliver) };
    if (patch.schedule && typeof patch.schedule === 'object') {
      const s = patch.schedule as { kind?: string; value?: string };
      const schedule = { kind: s.kind, value: String(s.value ?? '') } as Schedule;
      const from = Date.parse(t.createdAt);
      cronSchedule.validateSchedule(schedule, Number.isFinite(from) ? from : Date.now()); // throws on bad input
      t.schedule = schedule;
    }
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

// ---- cron trigger CRUD ------------------------------------------------------
const MAX_CRON_RUNS = 20;

function recordCronRun(t: CronTrigger, run: CronRun): void {
  t.runs.push(run);
  if (t.runs.length > MAX_CRON_RUNS) t.runs.splice(0, t.runs.length - MAX_CRON_RUNS);
}

// Where a cron fire's outcome is announced. Isolated runs call this from the
// /report handler (api.ts, on report_to_master); pre-flight failures (bad
// target, thrown exception) call it directly from fireCron. Reuses push.ts
// (a 4th trigger in its table, see docs/SPEC.md) and listeners.ts' wake
// channel — no new delivery transport.
async function deliverCronResult(
  triggerName: string,
  cronId: string | undefined,
  deliver: CronDeliver,
  result: { state: string; summary?: string; note?: string }
): Promise<void> {
  const isFailure = result.state === 'error' || result.state === 'blocked';
  const rawText = (result.summary || result.note || '(no summary)').trim();
  // [SILENT] suppresses a SUCCESS announcement only — failures always report.
  if (!isFailure && /^\[SILENT\]/i.test(rawText)) return;
  const text = rawText.replace(/^\[SILENT\]\s*/i, '');
  const title = `${triggerName}${isFailure ? ` — ${result.state}` : ''}`;
  if (deliver.push) {
    try {
      const n = await import('./notify.js');
      await n.notify({ title: title.slice(0, 80), body: text.slice(0, 200), tag: `cron:${cronId || triggerName}`, channels: ['push'] });
    } catch {}
  }
  if (deliver.whatsapp) {
    // Real since notify.ts: the host owns ONE paired WhatsApp process
    // (whatsapp-bridge.ts) and whatsapp-proxy.ts can send through it, so this
    // is no longer schema-only. `deliver.whatsapp` is either a JID or `true`
    // (= config.notify.whatsappJid). Not paired / no default JID → skipped.
    try {
      const n = await import('./notify.js');
      const jid = typeof deliver.whatsapp === 'string' ? deliver.whatsapp : undefined;
      const payload = { title, body: text, tag: `cron:${cronId || triggerName}`, channels: ['whatsapp'], ...(jid ? { whatsappJid: jid } : {}) };
      if (n.whatsappTarget(payload)) await n.notify(payload);
      else if (cronId) tlog(cronId, 'warn', 'WhatsApp delivery skipped — no target JID (set notify.whatsappJid in config, or give deliver.whatsapp a JID)');
    } catch (e) {
      if (cronId) tlog(cronId, 'warn', `WhatsApp delivery failed: ${(e as Error).message}`);
    }
  }
  if (deliver.master) {
    try {
      const listeners = await import('./listeners.js');
      listeners.enqueueWake(
        deliver.master,
        `cron "${triggerName}" ${result.state}${text ? `: ${text}` : ''}`,
        `cron:${cronId || triggerName}:${Date.now()}`
      );
    } catch {}
  }
}

// Sessions started from a cron fire share the SAME maxConcurrent budget as
// the Pending queue (decision, SPEC-ARIGAMI-BRAIN.md M2.1) — tag them
// `fromQueue` so the existing countQueueSessions() counts them without a
// parallel accounting mechanism.
const cronFiring = new Set<string>(); // in-memory lock against a double-fire within one poll tick

async function fireCron(
  t: CronTrigger,
  opts: { manual?: boolean } = {}
): Promise<{ ok: true; sessionId?: string } | { ok: false; reason: string }> {
  if (cronFiring.has(t.id)) return { ok: false, reason: 'already-firing' };
  cronFiring.add(t.id);
  try {
    if (!opts.manual && countQueueSessions() >= db.settings.maxConcurrent) {
      tlog(t.id, 'warn', `held — maxConcurrent (${db.settings.maxConcurrent}) reached; will retry next poll`);
      return { ok: false, reason: 'at-capacity' };
    }
    t.lastRun = Date.now();
    const at = new Date(t.lastRun).toISOString();
    const api = await import('./api.js');

    if (t.sessionMode === 'isolated') {
      // No explicit memory-bootstrap call here: claude.js's writeUserMessage
      // already prepends the USER.md/MEMORY.md snapshot to a fresh (non-resumed)
      // session's first message unconditionally (M1.3) — startEmptySession below
      // routes through claude.sendMessage like any other new session, so this
      // isolated run gets it for free. Doing it again here would double-inject.
      let prompt = `${t.prompt}\n\n${api.CRON_REPORT_DIRECTIVE}`;
      if (t.autonomous) prompt += `\n\n${api.AUTONOMY_DIRECTIVE}`;
      const { id: sessionId } = api.startEmptySession({
        title: t.name,
        prompt,
        permissionMode: t.autonomous ? 'bypassPermissions' : undefined,
        agent: t.agent || null, // A2: same path as create_session({agent}) — persona, memory, model, color
        metadata: {
          fromQueue: true,
          fromCronTrigger: t.id, // guard: sessions spawned by cron can't create more cron jobs
          cronTriggerId: t.id,
          cronTriggerName: t.name,
          cronDeliver: t.deliver,
        },
      });
      recordCronRun(t, { at, sessionId, state: 'started' });
      tlog(t.id, 'fire', `started isolated session ${sessionId}${opts.manual ? ' (run now)' : ''}`);
      return { ok: true, sessionId };
    }

    // 'existing:<sessionId>' — deliver like task_session: idle → now, busy → queued.
    const targetId = t.sessionMode.slice('existing:'.length);
    const target = state.getSession(targetId);
    if (!target) {
      recordCronRun(t, { at, sessionId: null, state: 'error', summary: `target session ${targetId} not found` });
      tlog(t.id, 'error', `target session ${targetId} not found`);
      await deliverCronResult(t.name, t.id, t.deliver, { state: 'error', summary: `target session ${targetId} not found` });
      return { ok: false, reason: 'target-not-found' };
    }
    // Tag the (pre-existing) target so a later report_to_master call from it
    // correlates back to this trigger — same fields the isolated branch sets
    // at creation time. onCronReport below only archives for sessionMode
    // 'isolated', so this never causes a persistent session (e.g. the brain
    // singleton, spec M4.2/M4.3) to get archived out from under itself.
    state.patchSession(targetId, {
      metadata: { cronTriggerId: t.id, cronTriggerName: t.name, cronDeliver: t.deliver },
    });
    const delivered = api.deliverToSession(targetId, `[Cron: ${t.name}]\n\n${t.prompt}`);
    recordCronRun(t, { at, sessionId: targetId, state: 'started', summary: `delivered (${delivered.delivered})` });
    tlog(t.id, 'fire', `delivered to existing session ${targetId} (${delivered.delivered}${opts.manual ? ', run now' : ''})`);
    return { ok: true, sessionId: targetId };
  } catch (e) {
    const msg = (e as Error).message;
    recordCronRun(t, { at: new Date().toISOString(), sessionId: null, state: 'error', summary: msg });
    tlog(t.id, 'error', `fire failed: ${msg}`);
    await deliverCronResult(t.name, t.id, t.deliver, { state: 'error', summary: msg });
    return { ok: false, reason: msg };
  } finally {
    cronFiring.delete(t.id);
    persist();
    emitTriggers();
  }
}

export async function createCronTrigger(input: {
  name?: string;
  prompt?: string;
  schedule?: { kind?: string; value?: string };
  sessionMode?: string;
  deliver?: CronDeliver;
  autonomous?: boolean;
  bundleKey?: string;
  agent?: string | null;
  createdBySessionId?: string;
}): Promise<CronTrigger> {
  // Guard against runaway scheduling loops (lesson from OpenClaw #21775 /
  // Hermes allow_agent_scheduling:false): a session spawned BY a cron fire
  // can't itself create new cron jobs.
  if (input.createdBySessionId) {
    const creator = state.getSession(input.createdBySessionId);
    if (creator?.metadata?.fromCronTrigger)
      throw new Error('a session spawned by a cron job cannot create new cron jobs (guard against runaway scheduling loops)');
  }
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  const kind = input.schedule?.kind;
  if (kind !== 'cron' && kind !== 'interval' && kind !== 'at')
    throw new Error(`invalid schedule.kind: "${kind}" (expected "cron" | "interval" | "at")`);
  const schedule: Schedule = { kind, value: String(input.schedule?.value ?? '') };
  const sessionMode = String(input.sessionMode || 'isolated');
  if (sessionMode !== 'isolated' && !(sessionMode.startsWith('existing:') && sessionMode.length > 'existing:'.length))
    throw new Error(`invalid sessionMode: "${sessionMode}" (expected "isolated" or "existing:<sessionId>")`);
  // A2: the agent the runs are born from. Explicit `agent` wins; a cron job
  // created FROM an agent's session defaults to that agent (its שגרה); an
  // unknown slug is refused. `agent: ''` = explicitly none.
  let agent: string | null = null;
  if (input.agent !== undefined && input.agent !== null) {
    if (String(input.agent).trim()) {
      const { getAgent } = await import('./agents.js');
      const a = getAgent(String(input.agent).trim());
      if (!a) throw new Error(`unknown agent: ${input.agent}`);
      agent = a.slug;
    }
  } else if (input.createdBySessionId) {
    const creator = state.getSession(input.createdBySessionId);
    const fromAgent = (creator?.metadata as any)?.agent;
    if (typeof fromAgent === 'string' && fromAgent) agent = fromAgent;
  }
  const createdAt = new Date().toISOString();
  // Fail the create on a bad expression instead of discovering it only when
  // the poll loop silently never fires.
  const nextRun = cronSchedule.validateSchedule(schedule, Date.parse(createdAt));
  const t: CronTrigger = {
    id: 'trig_' + nano(),
    type: 'cron',
    name: (input.name || '').trim() || 'Untitled cron',
    enabled: true,
    schedule,
    prompt,
    sessionMode,
    deliver: {
      push: input.deliver?.push !== false, // decision: push is the default delivery channel
      whatsapp: input.deliver?.whatsapp || undefined,
      master: input.deliver?.master || undefined,
    },
    autonomous: !!input.autonomous,
    ...(input.bundleKey ? { bundleKey: String(input.bundleKey) } : {}),
    ...(agent ? { agent } : {}),
    createdAt,
    createdBySessionId: input.createdBySessionId || null,
    lastRun: null,
    lastError: null,
    runs: [],
  };
  db.triggers.set(t.id, t);
  tlog(t.id, 'info', `armed — next run ${new Date(nextRun).toISOString()}`);
  persist();
  emitTriggers();
  import('./funnel.js').then((f) => f.firstTime('cron.first')).catch(() => {}); // K5 funnel
  return t;
}

// Fire immediately, bypassing both the schedule and the maxConcurrent gate
// (an explicit one-off action — UI "run now" / cronjob action:'run').
export async function runCronNow(id: string): Promise<{ ok: boolean; sessionId?: string; reason?: string }> {
  const t = db.triggers.get(id);
  if (!t || t.type !== 'cron') return { ok: false, reason: 'no such cron trigger' };
  const r = await fireCron(t, { manual: true });
  return r.ok ? { ok: true, sessionId: r.sessionId } : { ok: false, reason: r.reason };
}

// Called from the /report handler (api.ts) when a session with
// metadata.cronTriggerId calls report_to_master — records the run + delivers
// + tells the caller whether to auto-archive the session.
export async function onCronReport(
  sessionId: string,
  result: { state: string; summary?: string; note?: string; reportedAt?: string }
): Promise<{ archive: boolean }> {
  const s = state.getSession(sessionId) as any;
  const cronId = s?.metadata?.cronTriggerId as string | undefined;
  const triggerName = (s?.metadata?.cronTriggerName as string) || 'Cron';
  const deliver = (s?.metadata?.cronDeliver as CronDeliver) || {};
  const t = cronId ? db.triggers.get(cronId) : null;
  if (t && t.type === 'cron') {
    recordCronRun(t, {
      at: result.reportedAt || new Date().toISOString(),
      sessionId,
      state: (result.state as CronRun['state']) || 'milestone',
      summary: result.summary || result.note,
    });
    tlog(t.id, result.state === 'error' ? 'error' : 'fire', `session ${sessionId} reported ${result.state}${result.summary ? `: ${result.summary.slice(0, 140)}` : ''}`);
    persist();
    emitTriggers();
  }
  await deliverCronResult(triggerName, cronId, deliver, result);
  // Only auto-archive a session this cron itself spawned (sessionMode
  // 'isolated') — an 'existing' delivery target (e.g. the M4 brain singleton)
  // pre-existed the fire and must never be archived out from under itself
  // just because it reported a terminal state.
  const archive = t?.type === 'cron' && t.sessionMode === 'isolated' && (result.state === 'done' || result.state === 'error');
  return { archive };
}

export function nextRunFor(t: CronTrigger): number | null {
  try {
    return cronSchedule.computeNextRun(t.schedule, { createdAt: Date.parse(t.createdAt), lastRun: t.lastRun });
  } catch {
    return null;
  }
}

async function pollCronTrigger(t: CronTrigger): Promise<void> {
  let next: number | null;
  try {
    next = cronSchedule.computeNextRun(t.schedule, { createdAt: Date.parse(t.createdAt), lastRun: t.lastRun });
  } catch (e) {
    t.lastError = (e as Error).message;
    return;
  }
  t.lastError = null;
  if (next == null || next > Date.now()) return;
  await fireCron(t);
}

// ---- poll runner (linear-filter) -------------------------------------------
async function pollTrigger(t: LinearFilterTrigger): Promise<void> {
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
      if (t.type === 'linear-filter') await pollTrigger(t);
      else await pollCronTrigger(t);
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
