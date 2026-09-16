import fs from 'node:fs';
import { auth } from './auth.js';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { broadcast, emitLocal } from './bus.js';
import { ladderBadge } from './supervisor.js'; // pure — no cycle
import { cfg, ensureConfigFile, defaultEngine } from './lib/config.js';
import { migrateFile, stamp, SchemaVersionError } from './lib/schema-version.js';
import { STATE_SCHEMA } from './lib/state-schemas.js';
import { pickSessionAccount } from './accounts.js';
import { providerForEngine } from './lib/providers.js';
import * as funnel from './funnel.js';

export { cfg, ensureConfigFile };

// A function, not a module-load-time const: `bun test` runs every file in one
// process, so whichever file imports this module first would otherwise freeze
// this path for the whole run — see test/_isolate.js's header for the class of
// bug that causes. Re-reading the env on every call costs nothing (env is
// static for the lifetime of a real process) and makes each test's own
// ARIGAMI_STATE_FILE win regardless of import order.
const stateFile = (): string => process.env.ARIGAMI_STATE_FILE || cfg.stateFile;
export const CHAT_DIR =
  process.env.ARIGAMI_CHAT_DIR || cfg.chatDir;

export const nano = (): string =>
  randomBytes(8).toString('base64url').replace(/[-_]/g, () => 'x');

export const untildify = (p: string | null | undefined): string | null | undefined => {
  return p && p.startsWith('~')
    ? path.join(process.env.HOME || '', p.slice(1))
    : p;
};

// ---- Type Definitions ----

// One MCP server's live health verdict. Unlike capabilities.mcpServers (a
// snapshot the init event takes once per proc and never revisits), these are
// re-derived from real signals — the init event, live mcp__* tool results, and
// `claude mcp list` probes under the session's own account — and invalidated
// when the session's account switches (claude.ai connector grants are
// per-account, so a switch silently drops connections the old snapshot still
// reports as "connected").
interface McpServerHealth {
  status: string; // connected | pending | needs-auth | degraded | needs-reconnect | failed | unknown
  statusText?: string;
  at?: number; // when this verdict was recorded
  source?: string; // init | traffic | probe | spawn | stale
  // RES1: the supervisor took this server out of play for the session after it
  // stayed down — the model was told, and the session kept working without it.
  disabled?: boolean;
}

interface ClaudeState {
  sessionId: string | null;
  state: string;
  permissionMode: string;
  modelChoice?: string | null; // user-picked `claude --model` arg (null = default)
  effort?: string | null; // user-picked `claude --effort` arg (null = default)
  accountId?: string | null; // account this session runs on (null = active account)
  model?: string; // model id reported by the running session (init event)
  // RES1 — the model ladder. `modelChain` overrides the host default for this
  // session (agent → config → supervisor.DEFAULT_MODEL_CHAIN); `modelRung` is
  // where we currently sit in it (0 = the top rung the human picked) and
  // `modelRestoreAt` is when the top rung's quota resets, so the supervisor can
  // climb back. See server/supervisor.ts + docs/RESILIENCE.md §2.
  modelChain?: string[] | null;
  modelRung?: number;
  modelRestoreAt?: string | null;
  modelDowngradedFrom?: string | null; // the rung we dropped from (for the receipt)
  // LADDER1 — what the last ladder move replayed: the full conversation, or a
  // compacted digest+tail on a FRESH conversation because the full one did not
  // fit the weaker rung's window (server/lib/ladder-replay.ts). The climb back
  // reads it to resume the original full history.
  ladderReplay?: {
    mode: 'full' | 'compact' | 'full-restore' | 'compact-restore';
    at: string;
    from: string;
    to: string;
    estTokens: number;
    targetWindow: number;
    originalSessionId?: string | null;
    compactSessionId?: string | null;
    tailTurns?: number;
    imagesStripped?: number;
    digest?: 'llm' | 'fallback';
  } | null;
  // LADDER1 — wire-only (toWireSession): the "running below its model" badge,
  // null on the top rung. Never persisted; derived by supervisor.ladderBadge.
  ladder?: {
    running: string;
    configured: string;
    resetAt: string | null;
    compacted: boolean;
  } | null;
  capabilities?: Record<string, unknown>;
  // Live MCP server health map — what the /mcp panel renders (see McpServerHealth).
  mcp?: { servers: Record<string, McpServerHealth>; checkedAt?: number | null } | null;
  // Live context-window usage, derived from each assistant message's token
  // accounting. Drives the "context %" indicator in TermControls/ContextModal.
  usage?: {
    ctxTokens: number;
    ctxWindow: number;
    ctxPct: number;
    breakdown: { cacheRead: number; cacheCreation: number; input: number; output: number };
  } | null;
  // The request_screen call currently blocking this session (see api.ts
  // handleScreenRequest). Lives on the session (not only in the chat log) so
  // the rail can badge "needs you" on sessions whose chat isn't loaded.
  screenRequest?: { requestId: string; reason?: string } | null;
  // S1: an open request_setup card this session is blocked on (manual/ask mode).
  setupRequest?: { id: string; capability: string } | null;
  // Auto-compact threshold (% of the window, and the token count it resolved to).
  autoCompactPct?: number | null;
  autoCompactTokens?: number | null;
  // P3-3: codex app-server's last turn/diff/updated (the Changes tab reloads on `at`).
  turnDiff?: { at: number; additions: number; deletions: number } | null;
}

interface ReviewTarget {
  kind?: string;
  path?: string;
  lineLabel?: string;
  featureTitle?: string;
  line?: number;
  key?: string;
}

interface ReviewReply {
  id: string;
  createdAt: string;
  body: string;
  dir?: string | null;
}

interface ReviewComment {
  id: string;
  createdAt: string;
  target?: ReviewTarget;
  body: string;
  dir?: string | null;
  resolved?: boolean;
  suggested?: boolean;
  replies?: ReviewReply[];
}

interface ReviewDraft {
  comments: ReviewComment[];
}

interface TabSession {
  id: string;
  type: 'session';
  title: string;
}

interface TabUrl {
  id: string;
  type: 'url';
  title: string;
  url: string;
  external?: boolean;
  badge?: string;
  color?: string;
  /**
   * Dead field. The "compare to prod" slider used to live in the core and
   * stamped this on url tabs; it is an extension now
   * (examples/extensions/compare). Kept only so a state.json written before
   * that still parses and round-trips — nothing reads it, and nothing new
   * writes it.
   */
  compare?: unknown;
  // EXT: an extension tab is a `url` tab whose url is /__ext/<ext>/…; these two
  // fields let the cockpit find the manifest (and therefore the permissions the
  // postMessage bridge must enforce) without parsing the url back apart.
  ext?: string;
  extTab?: string;
}

interface TabContent {
  id: string;
  type: 'content';
  title: string;
  format: string;
  body: string;
  badge?: string;
}

type Tab = TabSession | TabUrl | TabContent;

// A published static artifact (A1, server/artifacts.ts). `path` is the
// host-relative URL of the CURRENT version (`/__artifacts/<id>/`); older
// versions stay reachable at `/__artifacts/<id>/v<N>/`.
export interface Artifact {
  id: string;
  title: string;
  path: string;        // '/__artifacts/<id>/'
  source: string;      // realpath of what was published (for re-publish → new version)
  entry: string;       // entry file inside the snapshot (default index.html)
  version: number;
  bytes: number;
  files: number;
  createdAt: string;
  updatedAt: string;
  // K2: the most recent share link minted for this artifact (the link itself
  // is never stored — only its expiry, nonce and pinned version).
  shareExp?: string;
  shareNonce?: string;
  shareVersion?: number;
}

interface ChangesExplanation {
  language: string | null;
  generatedAt: string;
  mode: 'pr' | 'uncommitted' | 'work';
  identity?: string;
  files: unknown[];
  features: unknown[];
}

// A prompt the user queued while the session was busy. Played (sent to Claude)
// manually via ▶, or automatically when the turn ends and autoPlay is on.
export interface PendingPrompt {
  id: string;
  text: string;
  createdAt: string;
}

// A manually-enabled, running status brief for a session (task / progress /
// current state / "what to do now"). Regenerated by a cheap headless run that
// folds the previous text with only the transcript delta since `atSeq`, so it
// stays cheap regardless of conversation length. See claude.js summarizeSession.
export interface StatusSummary {
  text: string;
  tldr?: string; // 2–3 line condensation of `text`, shown as the rail-row tooltip
  lang?: 'auto' | 'en' | 'he'; // 'auto' = follow the conversation; 'en'/'he' = force that language (B9)
  generatedAt: string;
  autoUpdate: boolean; // refresh after each completed turn
  atSeq: number; // chat seq the summary already accounts for (the fold cursor)
}

export interface Session {
  id: string;
  title: string;
  color: string;
  status: string;
  cwd: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  progress: unknown;
  action: unknown;
  tabs: Tab[];
  activeTabId: string;
  artifacts?: Artifact[];
  claude: ClaudeState;
  // Agent-engine CLI driving this session — 'claude' (default) or 'codex'; read by pickEngine() (lib/engine-driver.ts).
  engine?: 'claude' | 'codex';
  bg: unknown[];
  pendingPrompts?: PendingPrompt[];
  promptAutoPlay?: boolean;
  autoPlayHold?: 'action' | null; // wire-only (toWireSession): why the queue isn't moving
  sortOrder?: number; // manual flat-mode rail order (set by reorderSessions)
  folderId?: string | null; // rail folder membership (null/absent = root)
  changesExplaining?: 'pr' | 'uncommitted' | 'work' | null;
  changesExplanations?: Record<string, ChangesExplanation>;
  autoReviewing?: 'pr' | 'uncommitted' | 'work' | null;
  review?: ReviewDraft;
  statusSummary?: StatusSummary | null;
  summarizing?: boolean; // a summary generation run is in flight (transient)
}

// A user-defined rail folder. Membership lives on the session (folderId) so a
// deleted session can't leave a dangling reference; the folder itself is a thin
// record. controllerSessionId present ⇒ "project folder": that session is the
// folder's manager and may task the children (see task_session / DISPATCHER).
export interface Folder {
  id: string;
  name: string;
  collapsed: boolean;
  sortOrder?: number; // shares the root ordering axis with free sessions
  controllerSessionId?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TabNormResult {
  url: string;
  external?: boolean;
  badge?: string;
}

// A deterministic poller a session arms for an external event it's waiting on
// (e.g. its own PR getting reviewed). The scheduler in listeners.ts polls it and
// wakes the session with a thin signal on a match. See docs/TRIGGERS.md.
export interface Listener {
  id: string;
  sessionId: string;
  type: string; // 'github-pr' | 'linear-issue' | 'slack' | 'worker'
  label: string; // human label for the UI chip, e.g. "PR #123"
  params: Record<string, unknown>; // type-specific (owner, repo, number)
  fireOn: string[]; // event kinds that wake the session
  watermark: Record<string, unknown>; // per-stream cursor (advanced after delivery)
  status: 'watching' | 'errored' | 'stopped';
  firedCount: number;
  createdAt: string;
  ttlAt: number; // epoch ms; auto-stop after this
  intervalSec: number;
  nextPollAt: number; // epoch ms; due when <= now
  backoffLevel: number; // transient-error backoff exponent
  authFails: number; // consecutive auth failures
  lastPolledAt?: number;
  lastError?: string | null;
  agent?: string | null; // A2: the agent the arming session was born from (metadata.agent) — the agent's routine
}

// ---- Store ----

const db: {
  colorIndex: number;
  sessions: Map<string, Session>;
  listeners: Map<string, Listener>;
  folders: Map<string, Folder>;
} = { colorIndex: 0, sessions: new Map(), listeners: new Map(), folders: new Map() };

// Set when state.json was written by a NEWER Arigami than this build (a
// rollback after an update — see lib/schema-version.ts rule 4). We refuse to
// read it AND we never write over it: the whole point of stopping is that the
// human's sessions are still in that file, intact, for the newer build.
let refusedTooNew = false;

function load(): void {
  // Forward-migrate before the first read. A file already at the current
  // version is not touched; anything older is backed up next to itself first.
  try {
    migrateFile(stateFile(), STATE_SCHEMA);
  } catch (e) {
    if (e instanceof SchemaVersionError) {
      refusedTooNew = true;
      console.error(`[state] ${e.message}`);
    }
    throw e; // fatal: better to stop than to boot with an empty session list
  }
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as {
      colorIndex?: number;
      sessions?: Session[];
      listeners?: Listener[];
      folders?: Folder[];
    };
    db.colorIndex = j.colorIndex || 0;
    for (const f of j.folders || []) db.folders.set(f.id, f);
    for (const s of j.sessions || []) {
      if (s.claude) s.claude.state = 'idle';
      s.bg = [];
      delete (s as any).changesExplaining;
      delete (s as any).autoReviewing;
      delete (s as any).summarizing; // transient run flag never survives a restart
      db.sessions.set(s.id, s);
    }
    // Rehydrate live listeners; drop ones already finished (self-clean). Force a
    // catch-up poll on boot by making them due now — covers events missed while
    // the host was down (queue-until-idle wakes weren't persisted, so unadvanced
    // watermarks re-detect them).
    for (const l of j.listeners || []) {
      if (l.status === 'stopped') continue;
      if (db.sessions.has(l.sessionId)) {
        l.nextPollAt = 0;
        l.backoffLevel = l.status === 'errored' ? l.backoffLevel : 0;
        db.listeners.set(l.id, l);
      }
    }
  } catch {}
}
load();

let saveTimer: NodeJS.Timeout | null = null;

function persist(): void {
  if (dirSwapped) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, 500);
}

// A full import (server/backup.ts importFull) swaps the whole $ARIGAMI_DIR on
// disk under this still-running process, which keeps the OLD state in memory
// and then writes it back — shutdown() flushes before it exits, so the
// restart that finishes the import came up with the imported chat/ and
// agents/ but the pre-import session list. Reported live: "the import brought
// only the agents, not the sessions". Same shape as refusedTooNew: once the
// bytes on disk are not ours to own, stop writing them.
let dirSwapped = false;
export function freezeState(reason: string): void {
  if (dirSwapped) return;
  dirSwapped = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  // stderr, not stdout: test/_child.js parses this module's stdout as JSON,
  // and state.ts's own diagnostics already go to console.error.
  console.error(`[state] persistence frozen (${reason}) — the data dir on disk is no longer this process's to write`);
}

export function flushState(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  // Never overwrite a state.json we refused to read (see refusedTooNew), nor
  // one a full import just put there (see freezeState).
  if (refusedTooNew || dirSwapped) return;
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(
      stateFile(),
      JSON.stringify(
        stamp({
          colorIndex: db.colorIndex,
          sessions: [...db.sessions.values()],
          listeners: [...db.listeners.values()],
          folders: [...db.folders.values()],
        }, STATE_SCHEMA),
        null,
        2
      )
    );
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error('[state] persist failed:', error.message);
  }
}

// ---- Reads ----

export function listSessions({
  archived = false,
}: { archived?: boolean } = {}): Session[] {
  const all = [...db.sessions.values()];
  return archived ? all : all.filter((s) => !s.archived);
}

// ---- wire form -----------------------------------------------------------------
// What the UI receives for a session in a LIST (GET /__api/sessions, the WS
// state replay, session-updated broadcasts). The in-memory Session carries two
// things the rail never needs and that dominate the payload on a real host
// (~700KB for two dozen sessions, measured 2026-08-29):
//   - claude.capabilities: the Claude Code init handshake (commands, tools,
//     agents, models — ~35KB per session). The list keeps the small scalar
//     fields (permissionMode/model/version/account/mcpServers/skills) plus
//     item counts, flagged `slim: true`; the Capabilities panel fetches the
//     full blob lazily from GET /__api/sessions/:id.
//   - metadata.result.summary of finished workers: truncated to
//     SUMMARY_WIRE_MAX chars with `summaryTruncated: true` once the worker is
//     done (archived, or result.state !== 'milestone'). The Orchestration view
//     reads results through its own endpoint (childSummary), so nothing in the
//     UI depends on the list carrying the full text.
// GET /__api/sessions/:id always returns the full session.
export const SUMMARY_WIRE_MAX = 400;
const CAPS_KEEP = ['permissionMode', 'model', 'version', 'account', 'apiKeySource', 'mcpServers', 'skills'] as const;
const CAPS_COUNTED = ['commands', 'slashCommands', 'tools', 'agents', 'models'] as const;

export function slimCapabilities(caps: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!caps || typeof caps !== 'object') return caps;
  const out: Record<string, unknown> = { slim: true };
  for (const k of CAPS_KEEP) if (caps[k] !== undefined) out[k] = caps[k];
  const counts: Record<string, number> = {};
  for (const k of CAPS_COUNTED) if (Array.isArray(caps[k])) counts[k] = (caps[k] as unknown[]).length;
  out.counts = counts;
  return out;
}

// Auto-play is ON and prompts are waiting, yet nothing plays — why? This is the
// ONE place the rule lives: claude.js's settle timer asks it before playing, and
// toWireSession puts the human-facing half of the answer on the wire.
//   'action' — a sticky action bar (request_action / review card) is waiting on
//              a human decision; playing over it would bury the question.
//   'busy'   — a turn is running (or a permission request flipped the state);
//              the queue moves on its own when it ends.
//   null     — nothing holds it back.
export function autoPlayHold(s: Session): 'action' | 'busy' | null {
  if (!s.promptAutoPlay || !(s.pendingPrompts || []).length) return null;
  if (s.action) return 'action';
  if (s.claude?.state !== 'idle') return 'busy';
  return null;
}

export function toWireSession(s: Session): Session {
  let out: Session = s;
  if (s.claude?.capabilities) out = { ...out, claude: { ...s.claude, capabilities: slimCapabilities(s.claude.capabilities) } };
  // LADDER1: the rail row + chat header badge, derived once here so both agree.
  if (s.claude) {
    const ladder = ladderBadge(s.claude);
    if (ladder || out.claude?.ladder !== undefined) out = { ...out, claude: { ...(out.claude || s.claude), ladder } };
  }
  // 'busy' is already obvious in the UI (the session is visibly working) — only
  // the hold a human has to resolve is worth a hint next to the switch. The
  // client MERGES wire sessions ({...prev, ...next}), so a cleared hold has to
  // be sent as an explicit null, not an absent key — but only for sessions that
  // could be showing the hint at all (auto-play on, queue non-empty), so every
  // other session keeps its identity on the wire.
  const hold = autoPlayHold(s);
  if (hold === 'action') out = { ...out, autoPlayHold: 'action' };
  else if (s.promptAutoPlay && (s.pendingPrompts || []).length) out = { ...out, autoPlayHold: null };
  const result = s.metadata?.result as { state?: string; summary?: unknown } | undefined;
  if (
    result &&
    typeof result.summary === 'string' &&
    result.summary.length > SUMMARY_WIRE_MAX &&
    (s.archived || result.state !== 'milestone')
  ) {
    out = {
      ...out,
      metadata: {
        ...s.metadata,
        result: { ...result, summary: result.summary.slice(0, SUMMARY_WIRE_MAX), summaryTruncated: true },
      },
    };
  }
  return out;
}

export function listSessionsForWire(opts: { archived?: boolean } = {}): Session[] {
  return listSessions(opts).map(toWireSession);
}

export function getSession(id: string): Session | null {
  return db.sessions.get(id) || null;
}

// ---- Mutations ----

function touch(s: Session): void {
  s.updatedAt = new Date().toISOString();
  persist();
}

function nextScratchName(): string {
  let max = 0;
  for (const s of db.sessions.values()) {
    const m = /^scratch-(\d+)$/.exec(s.title || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `scratch-${max + 1}`;
}

export function createSession({
  title,
  cwd,
  permissionMode,
  metadata,
  model,
  effort,
  color,
  engine,
}: {
  title?: string;
  cwd?: string;
  permissionMode?: string;
  metadata?: Record<string, unknown>;
  model?: string | null;
  effort?: string | null;
  color?: string | null; // A1: a session born from an agent takes the agent's color
  engine?: string | null; // 'claude' | 'codex'; unset/unknown = cfg.defaultEngine — see Session.engine
} = {}): Session {
  const eng = engine === 'codex' || engine === 'claude' ? engine : defaultEngine();
  funnel.firstTime('session.first'); // K5 funnel — once per instance
  // pm.first_tree: a master's SECOND child makes it a tree (≥2 children).
  const master = metadata?.master;
  if (typeof master === 'string' && master && !funnel.hasHappened('pm.first_tree')) {
    const siblings = listSessions({ archived: true }).filter((x) => x.metadata?.master === master).length;
    if (siblings >= 1) funnel.firstTime('pm.first_tree');
  }

  const now = new Date().toISOString();
  const firstTab: Tab = {
    id: 'tab_' + nano(),
    type: 'session', // the chat/terminal tab — NOT a url tab (empty url loops the proxy bootstrap)
    title: 'Session',
  };
  const session: Session = {
    id: 'sess_' + nano(),
    title: (title || '').trim() || nextScratchName(),
    color: color || cfg.palette[db.colorIndex++ % cfg.palette.length],
    status: 'In Progress',
    cwd: cwd || cfg.defaultCwd,
    archived: false,
    createdAt: now,
    updatedAt: now,
    metadata: {
      // SIMPLE1: new sessions open in the Simple chat view (prose only; tool
      // activity folded). Sessions from before this field existed keep the
      // terminal view (the web treats "unset" as 'full' on desktop).
      chatMode: 'simple',
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
    },
    progress: null,
    action: null,
    tabs: [firstTab],
    activeTabId: firstTab.id,
    // Recorded as-asked, even if unimplemented — pickEngine() is what refuses to spawn it.
    engine: eng,
    claude: {
      sessionId: null,
      state: 'idle',
      permissionMode: permissionMode || 'bypassPermissions',
      // Pin the account at creation so the session is explicitly owned and its
      // token is deterministic. Switching the active account later only affects
      // NEW sessions — existing ones keep the account they were created on.
      // Picks the active account, or the next available one if active is
      // rate-limited/quarantined, so a new session doesn't start dead-on-arrival.
      // Per PROVIDER: a codex session is pinned to a codex login, never to a
      // Claude token it could not use (server/lib/providers.ts).
      accountId: pickSessionAccount(providerForEngine(eng)) || null,
      // Seed the session's model from the caller's pick, falling back to the
      // configured default (cfg.defaultModel); null means "no --model flag",
      // so the CLI picks. The per-session dropdown can still override later.
      modelChoice: model || (eng === 'claude' ? cfg.defaultModel : null) || null,
      effort: effort || null,
    },
    bg: [],
  };
  db.sessions.set(session.id, session);
  touch(session);
  broadcast({ type: 'session-created', session: toWireSession(session) });
  // EXT domain event — the dotted name is the public one (`session-created` on
  // the wire stays exactly as it is for the cockpit).
  try { emitLocal('session.created', { sessionId: session.id, title: session.title, cwd: session.cwd, agent: (session.metadata as any)?.agent ?? null }); } catch {}
  return session;
}

const PATCHABLE = new Set([
  'title',
  'color',
  'status',
  'metadata',
  'progress',
  'archived',
  'action',
  'folderId',
]);

export function patchSession(
  id: string,
  patch: Record<string, unknown> = {}
): Session | null {
  const s = getSession(id);
  if (!s) return null;
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) continue;
    if (k === 'metadata')
      s.metadata = { ...s.metadata, ...(v as Record<string, unknown> || {}) };
    else (s as any)[k] = v;
  }
  // An archived controller can't manage anyone — demote its project folder.
  if (patch.archived === true) releaseControllerOf(id);
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  if ('action' in patch) broadcast({ type: `action:${id}`, action: s.action });
  if ('progress' in patch)
    broadcast({ type: `progress:${id}`, progress: s.progress });
  return s;
}

export function setClaude(
  id: string,
  patch: Partial<ClaudeState> = {}
): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.claude = { ...s.claude, ...patch };
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

// ---- pending prompts --------------------------------------------------------

export function addPendingPrompt(id: string, text: string): PendingPrompt | null {
  const s = getSession(id);
  if (!s) return null;
  const p: PendingPrompt = {
    id: 'pp_' + nano(),
    text: String(text),
    createdAt: new Date().toISOString(),
  };
  s.pendingPrompts = [...(s.pendingPrompts || []), p];
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return p;
}

export function removePendingPrompt(id: string, promptId: string): PendingPrompt | null {
  const s = getSession(id);
  if (!s) return null;
  const list = s.pendingPrompts || [];
  const p = list.find((x) => x.id === promptId) || null;
  if (!p) return null;
  s.pendingPrompts = list.filter((x) => x.id !== promptId);
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return p;
}

export function reorderPendingPrompts(id: string, orderedIds: string[]): Session | null {
  const s = getSession(id);
  if (!s) return null;
  const list = s.pendingPrompts || [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const next: PendingPrompt[] = [];
  for (const pid of orderedIds) {
    const p = byId.get(pid);
    if (p) {
      next.push(p);
      byId.delete(pid);
    }
  }
  next.push(...byId.values()); // anything the client didn't mention keeps its place at the end
  s.pendingPrompts = next;
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

export function setPromptAutoPlay(id: string, on: boolean): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.promptAutoPlay = !!on;
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

export function setBg(id: string, bg: unknown[]): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.bg = bg;
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

export function setChangesExplanation(
  id: string,
  mode: string,
  explanation: ChangesExplanation
): Session | null {
  const s = getSession(id);
  if (!s) return null;
  const m = mode === 'pr' ? 'pr' : mode === 'work' ? 'work' : 'uncommitted';
  if (!s.changesExplanations || typeof s.changesExplanations !== 'object')
    s.changesExplanations = {};
  (s.changesExplanations as Record<string, ChangesExplanation>)[m] =
    explanation;
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

export function setChangesExplaining(
  id: string,
  mode?: string
): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.changesExplaining =
    mode === 'pr' || mode === 'uncommitted' || mode === 'work'
      ? (mode as 'pr' | 'uncommitted' | 'work')
      : null;
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

// ---- status summary ---------------------------------------------------------

// Store a freshly-generated summary (from the headless run). Clears the running
// flag and stamps the fold cursor + timestamp. Persisted (survives restart).
export function setStatusSummary(
  id: string,
  patch: Partial<StatusSummary>
): Session | null {
  const s = getSession(id);
  if (!s) return null;
  const prev = s.statusSummary || ({} as Partial<StatusSummary>);
  s.statusSummary = {
    text: patch.text ?? prev.text ?? '',
    tldr: patch.tldr ?? prev.tldr,
    lang: patch.lang ?? prev.lang ?? 'auto',
    generatedAt: new Date().toISOString(),
    autoUpdate: patch.autoUpdate ?? prev.autoUpdate ?? false,
    atSeq: patch.atSeq ?? prev.atSeq ?? 0,
  };
  s.summarizing = false;
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

// Toggle auto-update without regenerating.
export function setSummaryAutoUpdate(id: string, on: boolean): Session | null {
  const s = getSession(id);
  if (!s || !s.statusSummary) return null;
  s.statusSummary = { ...s.statusSummary, autoUpdate: !!on };
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

// Set the output language preference ('auto' | 'en'). Caller regenerates.
export function setSummaryLang(id: string, lang: 'auto' | 'en' | 'he'): Session | null {
  const s = getSession(id);
  if (!s || !s.statusSummary) return null;
  s.statusSummary = { ...s.statusSummary, lang: lang === 'en' ? 'en' : 'auto' };
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

// Turn the feature off for a session.
export function clearStatusSummary(id: string): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.statusSummary = null;
  s.summarizing = false;
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

// Transient "generating…" flag — broadcast only, never persisted.
export function setSummarizing(id: string, on: boolean): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.summarizing = !!on;
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

export function addReviewComment(
  id: string,
  comment: Omit<ReviewComment, 'id' | 'createdAt'>
): ReviewComment | null {
  const s = getSession(id);
  if (!s) return null;
  const c: ReviewComment = {
    id: 'cm_' + nano(),
    createdAt: new Date().toISOString(),
    ...comment,
  };
  s.review = {
    comments: [...(s.review?.comments || []), c],
  };
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return c;
}

export function addReviewComments(
  id: string,
  list: Omit<ReviewComment, 'id' | 'createdAt'>[]
): ReviewComment[] | null {
  const s = getSession(id);
  if (!s) return null;
  const add = (Array.isArray(list) ? list : []).map((comment) => ({
    id: 'cm_' + nano(),
    createdAt: new Date().toISOString(),
    ...comment,
  }));
  s.review = {
    comments: [...(s.review?.comments || []), ...add],
  };
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return add;
}

export function removeReviewComment(id: string, cid: string): boolean {
  const s = getSession(id);
  if (!s?.review) return false;
  s.review = {
    comments: s.review.comments.filter((c) => c.id !== cid),
  };
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return true;
}

const findComment = (s: Session | null, cid: string): ReviewComment | null =>
  s?.review?.comments.find((c) => c.id === cid) || null;

export function patchReviewComment(
  id: string,
  cid: string,
  patch: Partial<ReviewComment> = {}
): ReviewComment | null {
  const s = getSession(id);
  const c = findComment(s, cid);
  if (!c) return null;
  if (typeof patch.body === 'string' && patch.body.trim())
    c.body = patch.body;
  if ('resolved' in patch) c.resolved = !!patch.resolved;
  if ('suggested' in patch) c.suggested = !!patch.suggested;
  if (typeof patch.dir === 'string') c.dir = patch.dir;
  touch(s!);
  broadcast({ type: 'session-updated', session: toWireSession(s!) });
  return c;
}

export function addReviewReply(
  id: string,
  cid: string,
  reply: Omit<ReviewReply, 'id' | 'createdAt'>
): ReviewReply | null {
  const s = getSession(id);
  const c = findComment(s, cid);
  if (!c) return null;
  const r: ReviewReply = {
    id: 're_' + nano(),
    createdAt: new Date().toISOString(),
    ...reply,
  };
  c.replies = [...(c.replies || []), r];
  touch(s!);
  broadcast({ type: 'session-updated', session: toWireSession(s!) });
  return r;
}

export function patchReviewReply(
  id: string,
  cid: string,
  rid: string,
  patch: Partial<ReviewReply> = {}
): ReviewReply | null {
  const s = getSession(id);
  const r = findComment(s, cid)?.replies?.find((x) => x.id === rid);
  if (!r) return null;
  if (typeof patch.body === 'string' && patch.body.trim())
    r.body = patch.body;
  touch(s!);
  broadcast({ type: 'session-updated', session: toWireSession(s!) });
  return r;
}

export function removeReviewReply(
  id: string,
  cid: string,
  rid: string
): boolean {
  const s = getSession(id);
  const c = findComment(s, cid);
  if (!c?.replies) return false;
  c.replies = c.replies.filter((x) => x.id !== rid);
  touch(s!);
  broadcast({ type: 'session-updated', session: toWireSession(s!) });
  return true;
}

export function setAutoReviewing(id: string, mode?: string): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.autoReviewing =
    mode === 'pr' || mode === 'uncommitted' || mode === 'work'
      ? (mode as 'pr' | 'uncommitted' | 'work')
      : null;
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

export function clearReview(id: string): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.review = { comments: [] };
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return s;
}

// Manual flat-mode rail order: stamp sortOrder by position. Sessions not named
// keep their existing sortOrder (new ones stay undefined → sorted last).
export function reorderSessions(orderedIds: string[]): void {
  orderedIds.forEach((id, i) => {
    const s = db.sessions.get(id);
    if (s) s.sortOrder = i;
  });
  persist();
  for (const id of orderedIds) {
    const s = db.sessions.get(id);
    if (s) broadcast({ type: 'session-updated', session: toWireSession(s) });
  }
}

export function deleteSession(id: string): boolean {
  try { auth.revokeSessionToken(id); } catch {}
  const s = getSession(id);
  if (!s) return false;
  db.sessions.delete(id);
  // Listeners die with their session.
  for (const l of [...db.listeners.values()])
    if (l.sessionId === id) db.listeners.delete(l.id);
  // A dead controller demotes its project folder (children untouched).
  releaseControllerOf(id);
  persist();
  broadcast({ type: 'session-deleted', id });
  return true;
}

// ---- Folders ----------------------------------------------------------------
// Rail folders. Membership = session.folderId; the folder record is thin (see
// the Folder interface). Deleting a folder NEVER deletes sessions here — the
// purge flow (kill children too) lives in the API layer, which owns process
// teardown; state-level delete only ungroups.

export function listFolders(): Folder[] {
  return [...db.folders.values()];
}

export function getFolder(id: string): Folder | null {
  return db.folders.get(id) || null;
}

export function folderChildren(id: string, { archived = false } = {}): Session[] {
  return [...db.sessions.values()]
    .filter((s) => s.folderId === id && (archived || !s.archived))
    .sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9));
}

export function createFolder({
  name,
  sortOrder,
}: { name?: string; sortOrder?: number } = {}): Folder {
  const now = new Date().toISOString();
  const folder: Folder = {
    id: 'fld_' + nano(),
    name: (name || '').trim() || 'New folder',
    collapsed: false,
    ...(sortOrder != null ? { sortOrder } : {}),
    controllerSessionId: null,
    createdAt: now,
    updatedAt: now,
  };
  db.folders.set(folder.id, folder);
  persist();
  broadcast({ type: 'folder-created', folder });
  return folder;
}

const FOLDER_PATCHABLE = new Set(['name', 'collapsed', 'sortOrder', 'controllerSessionId']);

export function patchFolder(
  id: string,
  patch: Partial<Folder> = {}
): Folder | null {
  const f = db.folders.get(id);
  if (!f) return null;
  for (const [k, v] of Object.entries(patch)) {
    if (FOLDER_PATCHABLE.has(k)) (f as any)[k] = v;
  }
  if (typeof f.name === 'string') f.name = f.name.trim() || f.name;
  f.updatedAt = new Date().toISOString();
  persist();
  broadcast({ type: 'folder-updated', folder: f });
  return f;
}

// Ungroup-and-remove: children return to the root at the folder's position
// (fractional sortOrder slots them between the folder's old neighbours).
export function deleteFolder(id: string): { folder: Folder; children: Session[] } | null {
  const f = db.folders.get(id);
  if (!f) return null;
  const children = folderChildren(id, { archived: true });
  const base = f.sortOrder ?? 1e9;
  children.forEach((s, i) => {
    s.folderId = null;
    s.sortOrder = base + (i + 1) / (children.length + 1);
  });
  db.folders.delete(id);
  persist();
  for (const s of children) broadcast({ type: 'session-updated', session: toWireSession(s) });
  broadcast({ type: 'folder-deleted', id });
  return { folder: f, children };
}

// A controller that's gone (deleted/archived) demotes its project folder back
// to a regular one — never leave a folder locked to a ghost session.
export function releaseControllerOf(sessionId: string): void {
  for (const f of db.folders.values()) {
    if (f.controllerSessionId === sessionId) {
      f.controllerSessionId = null;
      f.updatedAt = new Date().toISOString();
      persist();
      broadcast({ type: 'folder-updated', folder: f });
    }
  }
}

// Atomic drop application: membership moves + full root order + per-folder
// internal order, in one call → one consistent broadcast burst (no window
// where a session is in a folder but not yet placed).
export function railReorder({
  root = [],
  folders = {},
  moves = [],
}: {
  root?: { type: 'session' | 'folder'; id: string }[];
  folders?: Record<string, string[]>;
  moves?: { sessionId: string; folderId: string | null }[];
}): void {
  const touched = new Set<string>();
  for (const mv of moves || []) {
    const s = db.sessions.get(String(mv.sessionId));
    if (!s) continue;
    s.folderId = mv.folderId && db.folders.has(mv.folderId) ? mv.folderId : null;
    touched.add(s.id);
  }
  (root || []).forEach((entry, i) => {
    if (entry?.type === 'folder') {
      const f = db.folders.get(String(entry.id));
      if (f) {
        f.sortOrder = i;
        f.updatedAt = new Date().toISOString();
      }
    } else if (entry) {
      const s = db.sessions.get(String(entry.id));
      if (s) {
        s.sortOrder = i;
        touched.add(s.id);
      }
    }
  });
  for (const [fid, ids] of Object.entries(folders || {})) {
    (ids || []).forEach((sid, i) => {
      const s = db.sessions.get(String(sid));
      if (s && s.folderId === fid) {
        s.sortOrder = i;
        touched.add(s.id);
      }
    });
  }
  persist();
  for (const sid of touched) {
    const s = db.sessions.get(sid);
    if (s) broadcast({ type: 'session-updated', session: toWireSession(s) });
  }
  broadcast({ type: 'folders-updated', folders: listFolders() });
}

// ---- Listeners ----

export function listListeners(
  { sessionId }: { sessionId?: string } = {}
): Listener[] {
  const all = [...db.listeners.values()];
  return sessionId ? all.filter((l) => l.sessionId === sessionId) : all;
}

export function getListener(id: string): Listener | null {
  return db.listeners.get(id) || null;
}

export function addListener(
  l: Omit<
    Listener,
    'id' | 'createdAt' | 'status' | 'firedCount' | 'backoffLevel' | 'authFails'
  >
): Listener {
  const listener: Listener = {
    id: 'lsn_' + nano(),
    createdAt: new Date().toISOString(),
    status: 'watching',
    firedCount: 0,
    backoffLevel: 0,
    authFails: 0,
    ...l,
  };
  // A2: listeners carry the agent of the session that armed them.
  if (listener.agent === undefined) {
    const owner = (db.sessions.get(listener.sessionId)?.metadata as any)?.agent;
    if (typeof owner === 'string' && owner) listener.agent = owner;
  }
  db.listeners.set(listener.id, listener);
  persist();
  broadcast({ type: 'listener-updated', listener });
  return listener;
}

export function patchListener(
  id: string,
  patch: Partial<Listener>
): Listener | null {
  const l = db.listeners.get(id);
  if (!l) return null;
  Object.assign(l, patch);
  persist();
  broadcast({ type: 'listener-updated', listener: l });
  return l;
}

export function removeListener(id: string): boolean {
  const l = db.listeners.get(id);
  if (!l) return false;
  db.listeners.delete(id);
  persist();
  broadcast({ type: 'listener-deleted', id, sessionId: l.sessionId });
  return true;
}

// Stop (but keep) every listener for a session — used when it's archived.
export function stopListenersForSession(sessionId: string): void {
  for (const l of db.listeners.values())
    if (l.sessionId === sessionId && l.status !== 'stopped')
      patchListener(l.id, { status: 'stopped' });
}

// ---- Artifacts (A1) ----

export function upsertArtifact(id: string, art: Artifact): Artifact | null {
  const s = getSession(id);
  if (!s) return null;
  s.artifacts = s.artifacts || [];
  const i = s.artifacts.findIndex((a) => a.id === art.id);
  if (i >= 0) s.artifacts[i] = art;
  else s.artifacts.push(art);
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return art;
}

export function removeArtifact(id: string, aid: string): boolean {
  const s = getSession(id);
  if (!s?.artifacts) return false;
  const i = s.artifacts.findIndex((a) => a.id === aid);
  if (i < 0) return false;
  s.artifacts.splice(i, 1);
  touch(s);
  broadcast({ type: 'session-updated', session: toWireSession(s) });
  return true;
}

// Owner lookup for the static route: which session published <aid>?
export function findArtifact(aid: string): { session: Session; artifact: Artifact } | null {
  for (const s of db.sessions.values()) {
    const a = s.artifacts?.find((x) => x.id === aid);
    if (a) return { session: s, artifact: a };
  }
  return null;
}

// ---- Tabs ----

export function normalizeTabUrl(url: string | null | undefined): TabNormResult {
  const u = String(url || '');
  let m = /linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/.exec(u);
  if (m) return { url: `/__ticket/${m[1].toUpperCase()}` };
  m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(u);
  if (m) return { url: `/__pr/${m[1]}/${m[2]}/${m[3]}`, badge: `#${m[3]}` };
  if (/(^|\.)chromatic\.com|github\.com/.test(u))
    return { url: u, external: true };
  return { url: u };
}

/** `{type:'ext', ext, tab, params}` → the url tab that actually gets stored. */
function resolveExtTab(ext: string, tabId: string, params?: Record<string, unknown>): { url: string; title: string; ext: string; tab: string } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ext)) throw new Error('tab type "ext" needs `ext` (the extension name)');
  let entry: { id: string; title: string; entry: string } | null = null;
  try {
    // Late require: state.ts is imported by the loader, so a static import here
    // would be a cycle. A missing loader simply means "no such extension".
    const mod = require('./extensions.js') as typeof import('./extensions.js');
    const e = mod.getExtension(ext);
    if (!e || e.state !== 'loaded') throw new Error(`extension "${ext}" is not loaded`);
    const tabs = e.manifest?.tabs || [];
    if (!tabs.length) throw new Error(`extension "${ext}" declares no tabs`);
    const t = tabId ? tabs.find((x) => x.id === tabId) : tabs[0];
    if (!t) throw new Error(`extension "${ext}" has no tab "${tabId}"`);
    entry = { id: t.id, title: t.title, entry: t.entry };
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
  // entry is `ui/index.html` in the manifest; the mount is rooted AT ui/.
  const rel = entry.entry.replace(/^ui\//, '');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) qs.set(k, String(v));
  const q = qs.toString();
  return { url: `/__ext/${ext}/${rel}${q ? `?${q}` : ''}`, title: entry.title, ext, tab: entry.id };
}

export function addTab(
  id: string,
  {
    type,
    title,
    url,
    format,
    body,
    badge,
    color,
    ext,
    tab: extTabId,
    params,
  }: {
    type?: string;
    title?: string;
    url?: string;
    format?: string;
    body?: string;
    badge?: string;
    color?: string;
    /** type 'ext': the extension name */
    ext?: string;
    /** type 'ext': which manifest tab (defaults to the first one) */
    tab?: string;
    /** type 'ext': query params handed to the page */
    params?: Record<string, unknown>;
  } = {}
): Tab | null {
  const s = getSession(id);
  if (!s) return null;
  // EXT: `type:'ext'` is sugar — it is normalised to a url tab pointing at the
  // /__ext mount, so nothing downstream (persistence, WS, the cockpit's url
  // renderer) needs to know a new tab kind exists.
  let extName = '';
  let extTabName = '';
  if (type === 'ext') {
    const r = resolveExtTab(String(ext || ''), extTabId ? String(extTabId) : '', params);
    type = 'url';
    url = r.url;
    if (!title) title = r.title;
    extName = r.ext;
    extTabName = r.tab;
  }
  if (type !== 'url' && type !== 'content')
    throw new Error('tab type must be "url", "content" or "ext"');

  const tab: Tab =
    type === 'content'
      ? {
          id: 'tab_' + nano(),
          type: 'content',
          title: title || 'Tab',
          format: format || 'markdown',
          body: body || '',
        }
      : {
          id: 'tab_' + nano(),
          type: 'url',
          title: title || url || 'Tab',
          url: '',
        };

  if (type === 'url') {
    const norm = normalizeTabUrl(url);
    const urlTab = tab as TabUrl;
    urlTab.url = norm.url;
    if (norm.external) urlTab.external = true;
    if (norm.badge && badge === undefined) urlTab.badge = norm.badge;
    if (color) urlTab.color = color;
    if (extName) { urlTab.ext = extName; urlTab.extTab = extTabName; }
  }

  if (badge !== undefined) tab.badge = badge;
  s.tabs.push(tab);
  s.activeTabId = tab.id;
  touch(s);
  broadcast({ type: 'tab-created', sessionId: id, tab, session: s });
  return tab;
}

export function patchTab(
  id: string,
  tabId: string,
  patch: Partial<Tab> = {}
): Tab | null {
  const s = getSession(id);
  const tab = s?.tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  for (const k of ['title', 'url', 'body', 'badge', 'color', 'format']) {
    if (k in patch) (tab as any)[k] = (patch as any)[k];
  }
  if ('url' in patch) {
    const norm = normalizeTabUrl((patch as any).url);
    (tab as any).url = norm.url;
    if (norm.external) (tab as any).external = true;
    else delete (tab as any).external;
    if (norm.badge && !('badge' in patch) && !(tab as any).badge)
      (tab as any).badge = norm.badge;
  }
  touch(s!);
  broadcast({ type: 'tab-updated', sessionId: id, tab, session: s });
  return tab;
}

export function deleteTab(id: string, tabId: string): boolean {
  const s = getSession(id);
  if (!s) return false;
  const i = s.tabs.findIndex((t) => t.id === tabId);
  if (i < 0) return false;
  if (s.tabs[i].type === 'session')
    throw new Error('cannot close the session tab');
  s.tabs.splice(i, 1);
  if (s.activeTabId === tabId)
    s.activeTabId = s.tabs.length ? s.tabs[Math.max(0, i - 1)].id : '';
  touch(s);
  broadcast({ type: 'tab-deleted', sessionId: id, tabId, session: s });
  return true;
}

export function activateTab(id: string, tabId: string): Session | null {
  const s = getSession(id);
  if (!s || (tabId !== '__changes' && !s.tabs.some((t) => t.id === tabId)))
    return null;
  s.activeTabId = tabId;
  touch(s);
  broadcast({
    type: 'tab-updated',
    sessionId: id,
    tab: s.tabs.find((t) => t.id === tabId),
    session: s,
  });
  return s;
}
