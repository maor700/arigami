// D3 — opt-in telemetry. OFF by default; there is NO second measurement
// mechanism: what leaves the box is exactly the K5 funnel (server/funnel.ts)
// reduced to allow-listed event NAMES + timestamps, plus a handful of
// non-identifying facts about the install (version/commit, os/arch, docker,
// bucketed session count, bucketed per engine) under a random instance id.
//
// Effective state = DO_NOT_TRACK=1 → off, else ARIGAMI_TELEMETRY env → that,
// else config.telemetry.enabled (Settings toggle / wizard step). When off,
// nothing here ever opens a socket — `start()` returns without a timer and
// `flush()` is a no-op.
//
// Files (all under $ARIGAMI_DIR): `telemetry-id` (the uuid; delete/rotate it
// to become a new anonymous instance) and `telemetry.json` (cursor into
// funnel.jsonl, last send, last payload for "show what would be sent").
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ARIGAMI_DIR } from './lib/instance.js';
import { cfg, updateTelemetryConfig } from './lib/config.js';
import { onFunnel, readEvents, FUNNEL_FILE, type FunnelEvent } from './funnel.js';

export const ID_FILE = path.join(ARIGAMI_DIR, 'telemetry-id');
export const STATE_FILE = path.join(ARIGAMI_DIR, 'telemetry.json');

export const SCHEMA_VERSION = 1;
export const SEND_TIMEOUT_MS = 5_000;
export const PING_EVERY_MS = 24 * 60 * 60_000; // daily ping, even with no new events
export const BATCH_DEBOUNCE_MS = 5 * 60_000; // new milestone → one send 5 min later (coalesced)
export const MAX_EVENTS_PER_SEND = 500;
// AUDIT2 — an unreachable collector must not leave a queue growing forever.
// A DNS-level failure (the host does not resolve) drops the batch at once;
// any other failure drops it after this many consecutive misses. After a drop
// nothing is retried for UNREACHABLE_BACKOFF_MS; new events in that window are
// dropped too (counted in state.dropped, shown by GET /__api/telemetry).
export const MAX_CONSECUTIVE_FAILURES = 3;
export const UNREACHABLE_BACKOFF_MS = 24 * 60 * 60_000;
const DNS_FAILURE = /ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL/;

// funnel name → wire name. Anything not in this map is DROPPED before it can
// leave the box (so a new funnel.emit() elsewhere never leaks by accident).
// Wire names are [a-z_] only — no dots, so a hostname-shaped string can never
// appear in the payload (see assertClean).
export const EVENT_MAP: Record<string, string> = {
  'install': 'install',
  'session.first': 'first_session',
  'pm.first_tree': 'first_pm_tree',
  'screen.first_request': 'first_request_screen',
  'skill.first_applied': 'first_proposal_applied',
  'artifact.first_publish': 'first_artifact_published',
  'share.first_link': 'first_share_link',
  'cron.first': 'first_cron',
  'onboarding.step': 'onboarding_step',
  'onboarding.done': 'onboarding_done',
};

// The ONLY props that survive, per wire event, and the values they may take.
const STEP_IDS = new Set(['pair', 'claude', 'codex', 'git', 'profile', 'integrations', 'repo', 'telemetry', 'health']);
const STEP_STATUS = new Set(['ok', 'todo', 'skipped', 'blocked', 'error', 'running']);

export interface WireEvent {
  name: string;
  at: string;
  step?: string;
  status?: string;
}

export interface Payload {
  v: number;
  id: string;
  sentAt: string;
  version: string;
  commit: string | null;
  os: string;
  arch: string;
  docker: boolean;
  sessions: '0' | '1' | '2-5' | '6+';
  engines: Record<(typeof ENGINES)[number], Payload['sessions']>;
  events: WireEvent[];
}

export const ENGINES = ['claude', 'codex'] as const;

interface TelemetryState {
  cursor: number; // number of funnel.jsonl lines already considered
  lastSentAt: string | null;
  lastPayload: Payload | null;
  lastError: string | null;
  failures: number; // consecutive failed sends since the last success/drop
  dropped: number; // events given up on because the collector was unreachable
  nextTryAt: string | null; // backoff after a drop — no send before this
}

// ---------------------------------------------------------------------------
// on/off
// ---------------------------------------------------------------------------

export type Reason = 'dnt' | 'env' | 'config';

/** What actually applies right now, and why. */
export function effective(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; reason: Reason; configured: boolean } {
  const configured = configuredOnDisk();
  if (/^(1|true|yes)$/i.test(String(env.DO_NOT_TRACK || ''))) return { enabled: false, reason: 'dnt', configured };
  const e = env.ARIGAMI_TELEMETRY;
  if (e != null && e !== '') return { enabled: /^(1|true|yes|on)$/i.test(e), reason: 'env', configured };
  return { enabled: configured, reason: 'config', configured };
}

export const isEnabled = (): boolean => effective().enabled;

/** The persisted choice (config.json), untouched by env pins — what the toggle shows while pinned. */
function configuredOnDisk(): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(String(cfg.configFile), 'utf8'));
    return !!j?.telemetry?.enabled;
  } catch {
    return false;
  }
}

/** Settings toggle / wizard decision. Persists; returns the effective view. */
export function setEnabled(on: boolean): ReturnType<typeof effective> {
  updateTelemetryConfig({ enabled: !!on });
  if (on) schedule(0); else stopTimers();
  return effective();
}

// ---------------------------------------------------------------------------
// anonymous instance id
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function instanceId(): string {
  try {
    const s = fs.readFileSync(ID_FILE, 'utf8').trim();
    if (UUID_RE.test(s)) return s;
  } catch {
    /* absent */
  }
  return rotateId();
}

/** "Delete my data": a fresh uuid — the server side can't link old to new. */
export function rotateId(): string {
  const id = randomUUID();
  try {
    fs.mkdirSync(ARIGAMI_DIR, { recursive: true });
    fs.writeFileSync(ID_FILE, id + '\n', { mode: 0o600 });
  } catch {
    /* a read-only data dir still gets a (volatile) id */
  }
  return id;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

function readState(): TelemetryState {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && typeof j === 'object')
      return {
        cursor: Number(j.cursor) || 0,
        lastSentAt: j.lastSentAt || null,
        lastPayload: j.lastPayload || null,
        lastError: j.lastError || null,
        failures: Number(j.failures) || 0,
        dropped: Number(j.dropped) || 0,
        nextTryAt: j.nextTryAt || null,
      };
  } catch {
    /* fresh */
  }
  return { cursor: 0, lastSentAt: null, lastPayload: null, lastError: null, failures: 0, dropped: 0, nextTryAt: null };
}

function writeState(s: TelemetryState): void {
  try {
    fs.mkdirSync(ARIGAMI_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
  } catch {
    /* ignore */
  }
}

function funnelLineCount(): number {
  try {
    return fs.readFileSync(FUNNEL_FILE, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// payload
// ---------------------------------------------------------------------------

/** Reduce a raw funnel event to its wire shape, or null if it's not shipped. */
export function toWire(ev: FunnelEvent): WireEvent | null {
  const name = EVENT_MAP[ev.name];
  if (!name) return null;
  const at = typeof ev.at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(ev.at) ? ev.at : new Date().toISOString();
  const w: WireEvent = { name, at };
  if (name === 'onboarding_step') {
    if (typeof ev.step === 'string' && STEP_IDS.has(ev.step)) w.step = ev.step;
    if (typeof ev.status === 'string' && STEP_STATUS.has(ev.status)) w.status = ev.status;
  }
  return w;
}

export function inDocker(): boolean {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    return /docker|kubepods|containerd/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

export function bucketSessions(n: number): Payload['sessions'] {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 5) return '2-5';
  return '6+';
}

export interface Facts {
  version: string;
  commit: string | null;
  sessions: number;
  engines?: Partial<Record<(typeof ENGINES)[number], number>>;
}

let factsProvider: () => Promise<Facts> = async () => {
  let version = '0.0.0';
  let commit: string | null = null;
  let sessions = 0;
  const engines = { claude: 0, codex: 0 };
  try {
    const v = await import('./version.js');
    const info = await v.getVersion();
    version = info.version;
    commit = info.commit;
  } catch {
    /* keep defaults */
  }
  try {
    const st = await import('./state.js');
    const all = st.listSessions({ archived: true });
    sessions = all.length;
    for (const s of all) engines[s.engine === 'codex' ? 'codex' : 'claude']++;
  } catch {
    /* CLI / tests without state */
  }
  return { version, commit, sessions, engines };
};

/** Tests / the CLI inject their own facts so nothing heavy is imported. */
export function setFactsProvider(f: () => Promise<Facts>): void {
  factsProvider = f;
}

// Defence in depth: whatever the providers return, refuse to ship a payload
// that carries a path, an email, a URL, a hostname or free text. Keys are a
// closed set; every string is checked against the forbidden shapes.
const FORBIDDEN_STRING = /[\/\\@\s]|:\/\/|[a-z0-9-]+\.[a-z]{2,}/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SEMVER_ISH = /^[0-9A-Za-z.+-]{1,40}$/;
const HEX = /^[0-9a-f]{4,40}$/;
const WORD = /^[a-z0-9_-]{1,40}$/i;

export function assertClean(p: Payload): void {
  const bad = (what: string): never => {
    throw new Error(`telemetry payload rejected: ${what}`);
  };
  const keys = Object.keys(p).sort().join(',');
  if (keys !== 'arch,commit,docker,engines,events,id,os,sentAt,sessions,v,version') bad(`unexpected keys ${keys}`);
  if (!UUID_RE.test(p.id)) bad('id');
  if (!ISO_DATE.test(p.sentAt)) bad('sentAt');
  if (!SEMVER_ISH.test(p.version) || FORBIDDEN_STRING.test(p.version.replace(/\./g, ''))) bad('version');
  if (p.commit != null && !HEX.test(p.commit)) bad('commit');
  if (!WORD.test(p.os) || !WORD.test(p.arch)) bad('os/arch');
  if (typeof p.docker !== 'boolean') bad('docker');
  if (!['0', '1', '2-5', '6+'].includes(p.sessions)) bad('sessions');
  if (!p.engines || typeof p.engines !== 'object' || Object.keys(p.engines).sort().join(',') !== ENGINES.join(',')) bad('engines');
  for (const e of ENGINES) if (!['0', '1', '2-5', '6+'].includes(p.engines[e])) bad(`engines.${e}`);
  if (!Array.isArray(p.events) || p.events.length > MAX_EVENTS_PER_SEND) bad('events');
  const wire = new Set(Object.values(EVENT_MAP));
  for (const e of p.events) {
    const ek = Object.keys(e).sort().join(',');
    if (!['at,name', 'at,name,status', 'at,name,step', 'at,name,status,step'].includes(ek)) bad(`event keys ${ek}`);
    if (!wire.has(e.name)) bad(`event name ${e.name}`);
    if (!ISO_DATE.test(e.at)) bad('event at');
    if (e.step != null && !STEP_IDS.has(e.step)) bad('event step');
    if (e.status != null && !STEP_STATUS.has(e.status)) bad('event status');
  }
  // Belt and braces: nothing string-ish anywhere may look like a path/email/host.
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (ISO_DATE.test(v) || UUID_RE.test(v)) return;
      if (FORBIDDEN_STRING.test(v)) bad(`string ${JSON.stringify(v)}`);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(p);
}

/**
 * Build the next payload: the funnel events after `cursor` (allow-listed and
 * reduced) + install facts. Pure w.r.t. state — nothing is persisted here.
 */
export async function buildPayload(opts: { fromCursor?: number; now?: Date } = {}): Promise<{ payload: Payload; cursor: number }> {
  const all = readEvents(Number.MAX_SAFE_INTEGER);
  const total = funnelLineCount();
  const from = Math.min(Math.max(0, opts.fromCursor ?? readState().cursor), all.length);
  const fresh = all.slice(from).map(toWire).filter((e): e is WireEvent => !!e).slice(0, MAX_EVENTS_PER_SEND);
  const f = await factsProvider();
  const payload: Payload = {
    v: SCHEMA_VERSION,
    id: instanceId(),
    sentAt: (opts.now || new Date()).toISOString(),
    version: String(f.version || '0.0.0'),
    commit: f.commit ? String(f.commit).slice(0, 40) : null,
    os: process.platform,
    arch: process.arch,
    docker: inDocker(),
    sessions: bucketSessions(f.sessions),
    engines: { claude: bucketSessions(f.engines?.claude ?? 0), codex: bucketSessions(f.engines?.codex ?? 0) },
    events: fresh,
  };
  assertClean(payload);
  return { payload, cursor: Math.max(total, all.length) };
}

/** "Show what would be sent": the payload the next send would carry (not persisted). */
export async function preview(): Promise<Payload> {
  return (await buildPayload()).payload;
}

// ---------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------

export type Sender = (url: string, body: string) => Promise<{ ok: boolean; status: number }>;

const defaultSender: Sender = async (url, body) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ac.signal,
    });
    return { ok: r.ok, status: r.status };
  } finally {
    clearTimeout(t);
  }
};

let sender: Sender = defaultSender;
export function setSender(s: Sender | null): void {
  sender = s || defaultSender;
}

export interface FlushResult {
  sent: boolean;
  reason?: 'disabled' | 'nothing' | 'error' | 'backoff';
  events?: number;
  status?: number;
  error?: string;
  /** events given up on in this call (collector unreachable) */
  dropped?: number;
}

let inflight: Promise<FlushResult> | null = null;

/**
 * Send one batch if enabled. `force` = the daily ping (send even with zero
 * new events so "active instances" can be counted). Quiet on every failure:
 * the cursor is NOT advanced, so events are retried on the next tick.
 */
export function flush(opts: { force?: boolean } = {}): Promise<FlushResult> {
  if (inflight) return inflight;
  inflight = (async (): Promise<FlushResult> => {
    const eff = effective();
    if (!eff.enabled) return { sent: false, reason: 'disabled' };
    const st = readState();
    let built: Awaited<ReturnType<typeof buildPayload>>;
    try {
      built = await buildPayload({ fromCursor: st.cursor });
    } catch (e) {
      st.lastError = (e as Error).message;
      writeState(st);
      return { sent: false, reason: 'error', error: st.lastError! };
    }
    const { payload, cursor } = built;
    if (!payload.events.length && !opts.force) {
      // Nothing new and not the daily ping: advance the cursor past any
      // non-shipped lines so they aren't re-scanned forever.
      if (cursor !== st.cursor) { st.cursor = cursor; writeState(st); }
      return { sent: false, reason: 'nothing' };
    }
    // Give up on this batch: the cursor moves past it so the queue stops
    // growing, and nothing is retried until the backoff window has passed.
    const drop = (): number => {
      const n = payload.events.length;
      st.cursor = cursor;
      st.dropped = (st.dropped || 0) + n;
      st.failures = 0;
      st.nextTryAt = new Date(Date.now() + UNREACHABLE_BACKOFF_MS).toISOString();
      return n;
    };
    if (st.nextTryAt && Date.parse(st.nextTryAt) > Date.now()) {
      const dropped = payload.events.length ? drop() : 0;
      if (dropped) writeState(st);
      return { sent: false, reason: 'backoff', error: st.lastError || undefined, dropped };
    }
    const endpoint = String(cfg.telemetry?.endpoint || '');
    if (!/^https?:\/\//.test(endpoint)) return { sent: false, reason: 'error', error: 'no endpoint' };
    const failed = (error: string, status?: number): FlushResult => {
      st.lastError = error;
      st.failures = (st.failures || 0) + 1;
      const dropped = DNS_FAILURE.test(error) || st.failures >= MAX_CONSECUTIVE_FAILURES ? drop() : 0;
      writeState(st);
      return { sent: false, reason: 'error', ...(status ? { status } : {}), error, ...(dropped ? { dropped } : {}) };
    };
    try {
      const r = await sender(endpoint, JSON.stringify(payload));
      if (!r.ok) return failed(`http ${r.status}`, r.status);
      st.cursor = cursor;
      st.lastSentAt = payload.sentAt;
      st.lastPayload = payload;
      st.lastError = null;
      st.failures = 0;
      st.nextTryAt = null;
      writeState(st);
      return { sent: true, events: payload.events.length, status: r.status };
    } catch (e) {
      return failed((e as Error)?.name === 'AbortError' ? 'timeout' : String((e as Error)?.message || e).slice(0, 120));
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// ---------------------------------------------------------------------------
// scheduling
// ---------------------------------------------------------------------------

let pingTimer: ReturnType<typeof setInterval> | null = null;
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let unhook: (() => void) | null = null;

function stopTimers(): void {
  if (pingTimer) clearInterval(pingTimer);
  if (batchTimer) clearTimeout(batchTimer);
  pingTimer = batchTimer = null;
}

/** Coalesce: one send `delayMs` after the first new milestone. */
function schedule(delayMs = BATCH_DEBOUNCE_MS): void {
  if (!isEnabled()) return;
  if (batchTimer) return;
  batchTimer = setTimeout(() => {
    batchTimer = null;
    flush().catch(() => {});
  }, delayMs);
  (batchTimer as any).unref?.();
}

function dueForPing(): boolean {
  const last = readState().lastSentAt;
  return !last || Date.now() - Date.parse(last) >= PING_EVERY_MS;
}

/**
 * Host boot. Hooks the funnel (a new milestone → batched send) and arms the
 * daily ping. Idempotent. When telemetry is off the hook still registers (so
 * turning it on later just works) but never schedules anything.
 */
export function start(): void {
  if (!unhook) unhook = onFunnel(() => schedule());
  if (!pingTimer) {
    pingTimer = setInterval(() => {
      if (isEnabled() && dueForPing()) flush({ force: true }).catch(() => {});
    }, 60 * 60_000);
    (pingTimer as any).unref?.();
  }
  if (isEnabled() && dueForPing()) schedule(30_000);
}

export function stop(): void {
  stopTimers();
  if (unhook) unhook();
  unhook = null;
}

/** GET /__api/telemetry — everything the Settings card shows. */
export async function status(): Promise<{
  enabled: boolean;
  reason: Reason;
  configured: boolean;
  dnt: boolean;
  endpoint: string;
  id: string;
  lastSentAt: string | null;
  lastError: string | null;
  pending: number;
  dropped: number;
  nextTryAt: string | null;
  preview: Payload;
}> {
  const eff = effective();
  const st = readState();
  const built = await buildPayload({ fromCursor: st.cursor });
  return {
    ...eff,
    dnt: eff.reason === 'dnt',
    endpoint: String(cfg.telemetry?.endpoint || ''),
    id: instanceId(),
    lastSentAt: st.lastSentAt,
    lastError: st.lastError,
    pending: built.payload.events.length,
    dropped: st.dropped || 0,
    nextTryAt: st.nextTryAt,
    preview: built.payload,
  };
}

/** Rotate the id and forget the send history (the server can't link the two ids). */
export function forget(): { id: string } {
  const id = rotateId();
  writeState({ cursor: readState().cursor, lastSentAt: null, lastPayload: null, lastError: null, failures: 0, dropped: 0, nextTryAt: null });
  return { id };
}
