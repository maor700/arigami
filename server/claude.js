// claude CLI process manager: one long-lived `claude -p` per session, talking
// stream-json on both stdin and stdout. Verified against claude 2.1.175:
//   --input-format/--output-format stream-json, --include-partial-messages,
//   --verbose, --permission-mode, --session-id, --resume, --mcp-config (inline
//   JSON), and --permission-prompt-tool (accepted; hidden from --help).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isWin, pidAlive, HOME } from './lib/platform.js';
import { resourceRoot } from './lib/resource-root.js';
import { bunExec, bunExecShell } from './lib/bun-exec.js';
import { claudeBin, EXTRA_BINS } from './lib/claude-bin.js';
import { supervise, killTree, killByTag } from './lib/children.js';
import { HOST_MARK } from './lib/session-procs.js';
import * as scratch from './lib/scratch.js';
import { cfg, CHAT_DIR, getSession, patchSession, setClaude, setBg, listSessions, untildify, setChangesExplaining, setAutoReviewing, removePendingPrompt, setSummarizing, autoPlayHold, listInbox, patchInboxItem } from './state.js';
import { broadcast } from './bus.js';
import { expirePendingPermissions, expirePendingScreenRequests, detachPendingSetupRequests } from './api.js';
import { tokenForSession, quarantine, nextAvailable, getActiveId, getAccount, setActive, resolveRefreshToken } from './accounts.js';
import { refreshOne } from './oauth-login.js';
import { getMemoryBootstrap } from './memory.js';
import { personaBlock, getAgent } from './agents.js';
import { policyFor, isRestrictive, disallowedToolsFor, hookSettings, strictMcpFor } from './agent-policy.js';
import { appendActivity, budgetState, localDay, budgetRefusal, turnBlocked } from './agent-ledger.js';
import { auth } from './auth.js';
import { ensureUserPlugin, USER_SKILLS_DIR } from './skills.js';
import { injectedServersFor } from './mcp-connections.js';
import { effectiveChain, rungOf, nextRung, rungsLeft } from './supervisor.js';
import { codexChain, codexLadder, codexCatalogIds, codexCatalogWindows, CODEX_LIMIT_RE } from './lib/codex-quota.js';
import { resolveCtxWindow } from './lib/ctx-window.js';
import { pickDriver } from './lib/screen-driver.js';
import { pickEngine, registerEngine } from './lib/engine-driver.js';
import {
  planReplay,
  shapeForCompaction,
  digestPrompt,
  fallbackDigest,
  buildPreamble,
  restoreTarget,
  renderEvents,
  estimateTokens as estimateTextTokens,
} from './lib/ladder-replay.js';
import { runClaudeOneShot, runOneShot, sessionEngine } from './lib/oneshot.js';
import { appendIncident } from './incidents.js';
import * as extensions from './extensions.js';
import { detectArchiveKind, extractArchive, formatTree } from './archive.js';

// $ARIGAMI_DIR/user-plugin — generated on demand so a fresh instance (or a
// first apply) needs no restart for sessions to see user skills.
function userPluginDir() {
  return ensureUserPlugin();
}

// EXT: $ARIGAMI_DIR/ext-plugin — the third plugin dir, generated from the
// installed extensions' docs[]. '' when nothing contributed a skill.
function extPluginDir() {
  try {
    return extensions.extPluginHasSkills() ? extensions.EXT_PLUGIN_DIR : '';
  } catch {
    return '';
  }
}

/**
 * The `--plugin-dir` arguments a spawn gets, in order: the shipped pack, the
 * user pack, and — only when it actually has a skill — the generated extension
 * pack. Exported so the plugin wiring can be asserted without spawning `claude`.
 */
export function pluginDirArgs() {
  const ext = extPluginDir();
  return ['--plugin-dir', ROOT, '--plugin-dir', userPluginDir(), ...(ext ? ['--plugin-dir', ext] : [])];
}

// Base env for every spawned `claude`, with the inherited CLAUDE_CODE_OAUTH_TOKEN
// stripped: the host chooses the auth per session from the accounts store, so a
// stray token in the environment (e.g. the old .env one) must not leak in and
// silently pin every session to one account. Sessions with no resolvable
// account fall back to Claude Code's own keychain login (token simply absent).
function baseEnv() {
  const { CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ...rest } = process.env;
  return rest;
}

// The host is often launched from a thin-PATH context (launchd, a GUI app, a
// non-login shell) where the npm/bun global bin that holds `claude` isn't on
// PATH — `spawn('claude')` then dies with `ENOENT … posix_spawn 'claude'` and
// every new session fails to start. Resolve an absolute path to the CLI (and
// keep re-resolving it — lib/claude-bin.js — so an update or reinstall is
// picked up without a restart), and enrich the process PATH with the usual
// user bin dirs so claude and everything it shells out to (git/node/bun)
// resolve too.
export const CLAUDE_BIN = claudeBin(); // boot-time answer; spawns call claudeBin() for the current one

// Enrich the server PATH once (idempotent) so every spawn — ours and claude's —
// sees the user bin dirs. claudeBin() publishes the resolved bin as
// ARIGAMI_CLAUDE_BIN so sibling spawners (mcp-auth) use the same absolute path.
{
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set(parts);
  for (const d of EXTRA_BINS) if (!seen.has(d)) { parts.push(d); seen.add(d); }
  process.env.PATH = parts.join(path.delimiter);
  if (CLAUDE_BIN === 'claude')
    console.warn('[claude] could not resolve the `claude` CLI on PATH — set ARIGAMI_CLAUDE_BIN or add it to PATH, or new sessions will fail to start');
}

// The auth env for a specific session: the token of its assigned account (or the
// active account). Returns {} when none resolves → keychain fallback.
function accountEnv(s) {
  try {
    const r = tokenForSession(s.claude?.accountId);
    return r ? { CLAUDE_CODE_OAUTH_TOKEN: r.token } : {};
  } catch {
    return {};
  }
}

const ROOT = resourceRoot();
const HOST_SERVERS = { 'arigami': bunExec('host') };
const MCP_CONFIG = JSON.stringify({ mcpServers: HOST_SERVERS });

// M1 — the `--mcp-config` payload for one session. Always the host MCP; for a
// session born from an agent, ALSO that agent's native remote-MCP grants.
//
// Those grants are registered at `local` scope in the agent's own directory, so
// they are invisible to every other session — injecting them here is what makes
// them usable, and the injected NAME must equal the grant name (`<service>--<slug>`)
// or Claude Code starts a fresh, unauthenticated OAuth flow (verified in the M1
// spike: credential lookup is by server name + URL hash). The tools therefore
// appear as `mcp__<service>--<slug>__*`, which is what an A3 allowlist matches.
//
// No `--strict-mcp-config`: it would also drop the USER's own servers (the
// WhatsApp bridge, the Composio gateway, anything they added by hand) from every
// agent session. Isolation between agents comes from the local scope above;
// A3's allowlist is what takes tools away on purpose.
// EXT: every ENABLED extension that declares tools[] also contributes an MCP
// server (`ext-<name>`) here, so its tools show up as `mcp__ext-<name>__*` in
// every session. A3's allowlist controls them through the `ext:<name>` family;
// a host with no extensions produces the exact same config it did before.
export function mcpConfigFor(s) {
  const slug = typeof s?.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null;
  let ext = {};
  try {
    ext = extensions.extServersFor(slug ? `agent:${slug}` : 'global');
  } catch {
    ext = {}; // a broken extension must never stop a session from starting
  }
  let own = {};
  if (slug) {
    try {
      own = injectedServersFor(`agent:${slug}`);
    } catch {
      own = {}; // a missing/foreign connections.json must never stop a session
    }
  }
  if (!Object.keys(ext).length && !Object.keys(own).length) return MCP_CONFIG;
  return JSON.stringify({ mcpServers: { ...HOST_SERVERS, ...ext, ...own } });
}

// engine-driver.ts's EngineDriver members for claude, pulled out of spawnProc()'s old inline argv (same flags/order).
function claudeModelArgs({ model, effort } = {}) {
  return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
}

function claudeInjectMcp(s) {
  return ['--mcp-config', mcpConfigFor(s)];
}

const claudePermissions = { kind: 'mcp-tool', tool: 'mcp__arigami__permission_prompt' };

// ---- background shells (agent `run_in_background` bashes) -------------------
// Surfaced from stream-json: a Bash tool_use with run_in_background:true, paired
// with its tool_result (which carries the shell ID + the output file path). The
// shell is a child of this session's claude proc and holds its .output file
// open, so liveness and kill both go through `lsof` on that file.

const bgList = (id) => getSession(id)?.bg || [];

function registerBg(id, { command, description, shellId, outputFile }) {
  const list = bgList(id);
  if (list.some((b) => b.id === shellId)) return;
  setBg(id, [
    ...list,
    { id: shellId, command, description: description || '', outputFile, startedAt: Date.now(), status: 'running' },
  ]);
  ensureReaper();
}

function markBg(id, shellId, status) {
  const list = bgList(id);
  if (!list.some((b) => b.id === shellId)) return;
  setBg(id, list.map((b) => (b.id === shellId ? { ...b, status, endedAt: b.endedAt || Date.now() } : b)));
}

// PIDs holding the output file open (the running shell + its current child).
// Windows has no lsof; the closest cheap equivalent is asking WMI which command
// lines mention the file — the bg shell's redirection carries it.
function writerPids(outputFile) {
  try {
    if (isWin) {
      const needle = path.basename(outputFile).replace(/'/g, "''");
      const r = Bun.spawnSync([
        'powershell', '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${needle}%'" | ` +
          `Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }`,
      ], { stdout: 'pipe', stderr: 'ignore' });
      return new TextDecoder().decode(r.stdout).split('\n').map((s) => s.trim()).filter(Boolean);
    }
    const r = Bun.spawnSync(['lsof', '-t', '--', outputFile]);
    return new TextDecoder().decode(r.stdout).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// Recently-written output means the shell is definitely still working. On
// Windows this is the primary liveness signal (WMI command-line matching is a
// best-effort fallback there), so the reaper never declares a busy job dead.
function recentlyWritten(outputFile, withinMs) {
  try {
    return Date.now() - fs.statSync(outputFile).mtimeMs < withinMs;
  } catch { return false; }
}

const bgAlive = (outputFile) =>
  isWin
    ? recentlyWritten(outputFile, 30_000) || writerPids(outputFile).length > 0
    : writerPids(outputFile).length > 0;

// Reap exited shells (lsof shows no writer) so the header count stays honest.
// Self-stops when nothing is running.
let reaper = null;
function ensureReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    let anyRunning = false;
    for (const s of listSessions({ archived: true })) {
      const list = s.bg || [];
      if (!list.length) continue;
      let changed = false;
      const next = list.map((b) => {
        if (b.status !== 'running') return b;
        if (bgAlive(b.outputFile)) { anyRunning = true; return b; }
        changed = true;
        return { ...b, status: 'exited', endedAt: Date.now() };
      });
      if (changed) setBg(s.id, next);
    }
    if (!anyRunning) { clearInterval(reaper); reaper = null; }
  }, 4000);
}

// Safety net for the session status badge: a session CANNOT be 'working' or
// 'awaiting-input' without a live claude process. Any path that stops a proc
// without resetting state (a missed `result`, a crash that skipped the close
// handler, a race on restart) leaves a stale badge. Correct only these
// unambiguously-orphaned states — never touch a session whose proc is alive, so
// a genuinely long-running turn (or one blocked on a permission prompt) is left
// exactly as-is and never gets a false 'idle'.
let stateReconciler = null;
function startStateReconciler() {
  if (stateReconciler) return;
  stateReconciler = setInterval(() => {
    for (const s of listSessions({ archived: true })) {
      const st = s.claude?.state;
      if ((st === 'working' || st === 'awaiting-input') && !isRunning(s.id)) {
        setClaude(s.id, { state: 'idle' });
      }
    }
  }, 5000);
  if (stateReconciler.unref) stateReconciler.unref();
}
startStateReconciler();

// Last <=maxBytes of a shell's output, with a live-status recheck. Returns null
// if the shell id is unknown for the session.
export function bgOutput(id, shellId, maxBytes = 96 * 1024) {
  const b = bgList(id).find((x) => x.id === shellId);
  if (!b) return null;
  let output = '';
  try {
    const stat = fs.statSync(b.outputFile);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(b.outputFile, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    output = (start > 0 ? '…(truncated)\n' : '') + buf.toString('utf8');
  } catch (e) {
    output = `(no output yet: ${e.message})`;
  }
  const alive = b.status === 'running' && bgAlive(b.outputFile);
  const status = b.status === 'running' && !alive ? 'exited' : b.status;
  return { ...b, status, output };
}

// SIGTERM the processes writing to the shell's output file (then SIGKILL any
// straggler shortly after). Targets only the file's holders — never a broad
// process-group kill that could touch the claude proc.
export function bgKill(id, shellId) {
  const b = bgList(id).find((x) => x.id === shellId);
  if (!b) return false;
  const pids = writerPids(b.outputFile).map(Number).filter(Boolean);
  if (isWin) {
    // No POSIX signals: taskkill /T takes the shell and everything it spawned.
    for (const pid of pids) {
      try { Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' }); } catch {}
    }
  } else {
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    setTimeout(() => {
      for (const pid of pids) { if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
    }, 1500);
  }
  markBg(id, shellId, 'killed');
  return true;
}

// ---- chat log: normalized events, persisted to CHAT_DIR/<id>.jsonl --------

const tails = new Map(); // sessionId → { seq, events[] } (in-memory tail for rehydration)
const TAIL_MAX = 500;
const chatFile = (id) => path.join(CHAT_DIR, `${id}.jsonl`);

function tail(id) {
  let t = tails.get(id);
  if (!t) {
    let seq = 0;
    try {
      const txt = fs.readFileSync(chatFile(id), 'utf8');
      for (let i = 0; i < txt.length; i++) if (txt[i] === '\n') seq++;
    } catch {}
    t = { seq, events: [] };
    tails.set(id, t);
  }
  return t;
}

let _evSeqGlobal = 0;
function shortId() {
  return Date.now().toString(36) + (++_evSeqGlobal).toString(36);
}

export function appendChat(id, ev) {
  const t = tail(id);
  ev = { id: ev.id || shortId(), seq: ++t.seq, ts: Date.now(), ...ev };
  t.events.push(ev);
  if (t.events.length > TAIL_MAX) t.events.shift();
  try {
    fs.mkdirSync(CHAT_DIR, { recursive: true });
    fs.appendFileSync(chatFile(id), JSON.stringify(ev) + '\n');
  } catch (e) {
    console.error('[chat] append failed:', e.message);
  }
  broadcast({ type: `chat:${id}`, event: ev });
  return ev;
}

export function getChat(id, since = 0) {
  const t = tail(id);
  const firstInMem = t.events[0]?.seq ?? Infinity;
  if (since + 1 < firstInMem && t.seq > t.events.length) {
    // tail doesn't reach back far enough — read from disk
    try {
      // One torn/corrupt line (a crash mid-append) must not hide the whole
      // transcript — skip it, keep the rest.
      return fs
        .readFileSync(chatFile(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && e.seq > since);
    } catch {}
  }
  return t.events.filter((e) => e.seq > since);
}

// CHATWS: the cockpit's page/resync loads are dominated by tool-result bodies
// (one `cat` of a big file = 600KB in a single event; a 150-event tail of a
// working session is routinely 2–9MB). The pane renders at most ~600 chars of
// a result until "more" is clicked, so the wire form only needs a prefix:
// `clipEvent` caps every long string in the event (result content, assistant
// text, tool input fields) at `max` chars and marks the event
// `{clipped:true, fullBytes}` so the client can fetch the full row on demand
// (GET …/chat?seq=N). Pure — never mutates the stored event.
// `text` (a user prompt / the assistant's prose) is READ in full in the pane,
// so it only gets a generous safety cap; `content` (tool results) and `input`
// (tool arguments) are previews behind a click and take the real cap.
const CLIP_KEYS = { content: 1, input: 1, text: 16 };
function clipValue(v, max, depth = 0) {
  if (typeof v === 'string') return v.length > max ? { v: v.slice(0, max) + '…', c: true } : { v, c: false };
  if (Array.isArray(v)) {
    let c = false;
    const out = v.map((x) => { const r = clipValue(x, max, depth + 1); c = c || r.c; return r.v; });
    return { v: c ? out : v, c };
  }
  if (v && typeof v === 'object' && depth < 4) {
    let c = false;
    const out = {};
    for (const k of Object.keys(v)) { const r = clipValue(v[k], max, depth + 1); c = c || r.c; out[k] = r.v; }
    return { v: c ? out : v, c };
  }
  return { v, c: false };
}
export function clipEvent(ev, max) {
  if (!ev || !(max > 0)) return ev;
  let clipped = false;
  let out = ev;
  for (const k of Object.keys(CLIP_KEYS)) {
    if (ev[k] == null) continue;
    const r = clipValue(ev[k], max * CLIP_KEYS[k]);
    if (r.c) {
      if (out === ev) out = { ...ev };
      out[k] = r.v;
      clipped = true;
    }
  }
  if (!clipped) return ev;
  let fullBytes = 0;
  try { fullBytes = Buffer.byteLength(JSON.stringify(ev)); } catch {}
  return { ...out, clipped: true, fullBytes };
}
export function clipEvents(events, max) {
  return max > 0 ? events.map((e) => clipEvent(e, max)) : events;
}

// One full (unclipped) event by seq — the "more" button's fetch. Tail first,
// then a disk scan (one-off, on demand — never on the page-load path).
export function getChatEvent(id, seq) {
  const t = tail(id);
  const hit = t.events.find((e) => e.seq === seq);
  if (hit) return hit;
  try {
    for (const l of fs.readFileSync(chatFile(id), 'utf8').split('\n')) {
      if (!l) continue;
      let e = null;
      try { e = JSON.parse(l); } catch { continue; }
      if (e && e.seq === seq) return e;
    }
  } catch {}
  return null;
}

// Read the last N lines from a JSONL file efficiently (reads from end of file).
function readTailLines(filePath, maxLines) {
  const CHUNK = 64 * 1024;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return [];
    const lines = [];
    let partial = '';
    let pos = size;
    while (pos > 0 && lines.length < maxLines) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      const chunk = buf.toString('utf8') + partial;
      const parts = chunk.split('\n');
      partial = parts[0]; // may be incomplete line
      for (let i = parts.length - 1; i >= 1; i--) {
        if (parts[i]) lines.unshift(parts[i]);
        if (lines.length >= maxLines) break;
      }
    }
    // If we reached the start and there's leftover, it's the first line
    if (partial && lines.length < maxLines) lines.unshift(partial);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
  finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

// Paginated: return the last `limit` events before `beforeSeq`.
// Returns { events, hasMore, oldestSeq }.
// `clip` (chars) → every event goes through clipEvent (see above); 0/absent =
// the full rows, which is what every non-cockpit caller gets.
export function getChatPage(id, { limit = 100, beforeSeq = Infinity, clip = 0 } = {}) {
  const t = tail(id);
  // If the tail buffer covers what we need, use it (fast path)
  if (beforeSeq >= Infinity && t.events.length >= limit) {
    const page = t.events.slice(-limit);
    return { events: clipEvents(page, clip), hasMore: t.events.length > limit || t.seq > t.events.length, oldestSeq: page[0]?.seq ?? 0 };
  }
  // Read only what we need from disk (from the end)
  const needed = beforeSeq < Infinity ? limit + 500 : limit + 1; // overshoot for filtering
  const raw = readTailLines(chatFile(id), needed);
  const filtered = beforeSeq < Infinity ? raw.filter((e) => e.seq < beforeSeq) : raw;
  const page = filtered.slice(-limit);
  return {
    events: clipEvents(page, clip),
    hasMore: filtered.length > limit || (raw.length >= needed),
    oldestSeq: page[0]?.seq ?? 0,
  };
}

// ---- process lifecycle -----------------------------------------------------

const procs = new Map(); // sessionId → proc record
let reqSeq = 0;

function record(id) {
  return procs.get(id) || null;
}

/** RES1 — the last user message in the transcript, replayed after a respawn. */
export function lastUserMessage(id) {
  const sent = [...(record(id)?.sent || [])].pop();
  if (sent) return sent;
  const evs = getChat(id, 0) || [];
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i].kind === 'user' && evs[i].text) return String(evs[i].text);
  return null;
}

export function isRunning(id) {
  const p = record(id);
  return !!(p && p.child.exitCode === null && !p.child.killed);
}

// Spawn (or return) the claude proc for a session. Resumes the previous claude
// conversation when we have one; otherwise pins a fresh UUID via --session-id.
export function ensureRunning(id) {
  if (isRunning(id)) return record(id);
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  if (s.archived) throw new Error(`session ${id} is archived`);
  return spawnProc(s, !!s.claude?.sessionId);
}

// A3: the `--disallowedTools` / `--settings` flags for a session born from an
// agent with a tools/domains allowlist. Whole external MCP servers no allowlist
// entry touches are denied by name (the names come from the last init report +
// the live health map — the hook catches anything that shows up later).
//
// A5 (#7): when the allowlist reaches into NO external server, the spawn also gets
// `--strict-mcp-config` — only what the host itself passes in --mcp-config is
// loaded, so the user's global servers (composio-mcp…) never reach the model at
// all. Without it their schemas were still listed (and burned tokens) even though
// every call was blocked at PreToolUse. The agent's OWN M1 grants ride in that
// same --mcp-config (mcpConfigFor), so strict never takes those away — an
// allowlist that does not name them denies them by name below, as before.
function policyArgs(s) {
  const slug = typeof s.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null;
  const policy = policyFor(slug);
  if (!isRestrictive(policy)) return [];
  const servers = new Set(Object.keys(mcpServersOf(s.id)));
  for (const sv of s.claude?.capabilities?.mcpServers || []) if (sv && typeof sv === 'object' && sv.name) servers.add(String(sv.name));
  // M1: the grants this session is spawned with, even before a first init report.
  try {
    for (const name of Object.keys(injectedServersFor(`agent:${slug}`))) servers.add(name);
  } catch {
    /* no connections.json — the hook still enforces */
  }
  // EXT: the extension servers this spawn injects. An allowlist that does not
  // name `ext:<name>` denies the whole server at layer 1, exactly like any
  // other external MCP server the agent was not granted.
  try {
    for (const name of Object.keys(extensions.extServersFor(slug ? `agent:${slug}` : 'global'))) servers.add(name);
  } catch {
    /* loader not ready — the hook still enforces */
  }
  const strict = strictMcpFor(policy);
  const denied = disallowedToolsFor(policy, [...servers]);
  const hook = bunExecShell('policy');
  return [
    ...(strict ? ['--strict-mcp-config'] : []),
    ...(denied.length ? ['--disallowedTools', denied.join(',')] : []),
    '--settings', hookSettings(hook),
  ];
}

// engine-driver.ts's buildSpawn() for claude — same [bin, args, env, cwd] spawnProc() used to build inline; sessionId arrives already resolved.
function buildClaudeSpawn(s, { resume, sessionId }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', s.claude?.permissionMode || 'bypassPermissions',
    // Model is opt-in: only pass --model when the user picked one (an alias like
    // 'opus'/'sonnet'/'haiku' or a full id). Otherwise let Claude Code's default win.
    ...claudeModelArgs({ model: s.claude?.modelChoice, effort: s.claude?.effort }),
    ...(s.claude?.autoCompactTokens ? ['--autocompact', String(s.claude.autoCompactTokens)] : []),
    ...claudeInjectMcp(s),
    ...(claudePermissions.kind === 'mcp-tool' ? ['--permission-prompt-tool', claudePermissions.tool] : []),
    // Register the bundled skill pack (skills/) as a plugin so sessions can
    // invoke them as /arigami:<skill> — they appear in the chat palette. The
    // user/bundle skills ($ARIGAMI_DIR/skills) ride along as a second plugin
    // (/arigami-user:<skill>) — see skills.ts ensureUserPlugin() — and the
    // extensions' generated docs as a third (/arigami-ext:<skill>), only when
    // one exists. See pluginDirArgs().
    ...pluginDirArgs(),
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    // A3: host-enforced tool/domain allowlist (agent-policy.ts) — real CLI
    // denials + a PreToolUse hook that asks the host before every call.
    ...policyArgs(s),
  ];
  const cwd = untildify(s.cwd) || HOME;
  const screenHandle = pickDriver().peek(s.id);
  const env = {
    ...baseEnv(),
    ...accountEnv(s),
    ARIGAMI_SESSION_ID: s.id,
    // Ownership markers (session-procs.ts): every process this session starts
    // inherits them, detached or not, so deleting the session can find it.
    ARIGAMI_HOST_ID: HOST_MARK,
    ...scratch.envFor(s.id), // TMPDIR → ~/.arigami/scratch/<id>, removed with the session
    // ARIGAMI_URL is INTERNAL: the loopback base the agent's MCP/curl calls use
    // to reach THIS host. It is never a link for a human — the host hands out
    // relative paths (ARIGAMI_PUBLIC_PATH) that resolve on any origin. See
    // server/lib/public-url.ts.
    ARIGAMI_URL: cfg.hostBase,
    ARIGAMI_PUBLIC_PATH: '/__host/',
    ...(cfg.publicUrl ? { ARIGAMI_PUBLIC_URL: cfg.publicUrl } : {}),
    // C1: per-session internal bearer token — host-mcp.js, skills' curl and
    // the review prompt authenticate with it; it dies with the session.
    ARIGAMI_TOKEN: auth.tokenForSession(s.id),
    // A1: the agent this session was born from — host-mcp.js defaults
    // memory_write/memory_search to its namespace.
    ...(typeof s.metadata?.agent === 'string' && s.metadata.agent ? { ARIGAMI_AGENT: s.metadata.agent } : {}),
    ARIGAMI_SKILLS: path.join(ROOT, 'skills'), // host skill pack for the session
    ARIGAMI_USER_SKILLS: USER_SKILLS_DIR, // user/bundle skills (override shipped by name)
    // Dispatcher: a needsServer worker gets a host-allocated port as $PORT so
    // its dev server binds the slot the host reserved (metadata.port).
    ...(s.metadata?.port ? { PORT: String(s.metadata.port) } : {}),
    // Per-session desktop (T8): set only if allocated before this spawn
    // (needs_screen:true at create_session, or a respawn after a lazy
    // allocation from an earlier request_screen/capture_screen/browser-open
    // in this session). A desktop allocated while this process is already
    // running only takes effect on its next spawn — env can't be changed
    // on a live child. spawnProc() is called synchronously from many call
    // sites, so this uses the driver's synchronous peek() rather than the
    // async childEnv() (server/lib/screen-driver.ts).
    ...(screenHandle?.display ? { DISPLAY: String(screenHandle.display) } : {}),
  };
  return { bin: claudeBin(), args, env, cwd };
}

function spawnProc(s, resume) {
  const engine = pickEngine(s);
  // 'assigned' (claude): mint the id now and pin it on argv. 'observed' (codex):
  // the CLI mints its own and announces it on the first event, so there is
  // nothing to pin — buildSpawn gets null and handleEvent stores the real id
  // (sessionId.from) when it arrives. Both cases still resume off the STORED id.
  const sessionId = resume
    ? s.claude.sessionId
    : engine.sessionId.mode === 'assigned'
      ? engine.sessionId.assign()
      : null;
  engine.prepare(s, { resume });
  const built = engine.buildSpawn(s, { resume, sessionId });
  // A cwd that isn't there makes posix_spawn fail with ENOENT naming the
  // BINARY, not the directory — "claude failed to start: ENOENT … no such
  // file or directory, posix_spawn '/…/claude'" while claude sits right
  // there, executable. That is what a cross-machine import looks like from
  // the cockpit: every restored session carries the source host's cwd
  // (/home/arigami/repos on a Linux VPS) and none of them exist here. Say
  // which directory is missing instead of sending the human after the CLI.
  if (built.cwd && !fs.existsSync(built.cwd)) {
    appendChat(s.id, {
      kind: 'error',
      text: `${engine.id} can't start: the session's folder does not exist on this machine — ${built.cwd}\nChange the session's folder (or clone the repo there) and try again.`,
    });
    setClaude(s.id, { state: 'dead' });
    return;
  }
  const child = spawn(built.bin, built.args, { cwd: built.cwd, env: built.env, stdio: ['pipe', 'pipe', 'pipe'] });
  // A session's claude spawns its own tree (MCP servers, tool shells). Put it
  // under supervision so that tree dies with the host instead of outliving it
  // holding the inherited listen socket.
  supervise(child, `session:${s.id}`);
  const agentSlug = typeof s.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null;
  if (agentSlug) refreshCapabilitiesHint(`agent:${agentSlug}`).catch(() => {}); // A2: keep the agent's line fresh for its next spawn
  const p = {
    id: s.id, // SIMPLE1: writeUserMessage reads the session's live metadata (chat mode) per turn
    capabilitiesHint: capabilitiesHint(agentSlug ? `agent:${agentSlug}` : 'global', s.engine || 'claude'), // F8: the connectable-capabilities line for the first turn (A2: per agent)
    hadToken: !!built.env.CLAUDE_CODE_OAUTH_TOKEN, // F8: spawned with an account token? (a session started BEFORE Connect Claude has none)
    agent: typeof s.metadata?.agent === 'string' ? s.metadata.agent : null, // A1: born from an agent → persona + agent memory in the first turn
    child,
    resume,
    spawnedAt: Date.now(),
    expectKill: false,
    stderr: '',
    buf: '',
    sent: [], // user messages written since spawn — replayed if a --resume spawn dies early
    preamble: '', // LADDER1: a [host] block written in front of the NEXT user message only (compacted context / interim digest)
    pendingBg: new Map(), // tool_use_id → {command,description} awaiting its bg tool_result
    hostToolIds: new Set(), // tool_use_ids of mcp__arigami__* calls — their JSON echoes are suppressed in the transcript (they manifest as UI: status badge, action card, tabs…)
    mcpToolCalls: new Map(), // tool_use_id → mcp server name, so each result feeds that server's live health
    turn: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }, // A3: token accounting of the turn in flight (agent ledger)
    lastCostUsd: 0, // A3: the CLI's cumulative total_cost_usd at the last result → per-turn delta
  };
  procs.set(s.id, p);
  if (!resume) setClaude(s.id, { sessionId });
  // A3: a session run in the agent's ledger (first spawn only — a resume is the same run).
  if (!resume && agentSlug) appendActivity(agentSlug, { kind: 'session', sessionId: s.id, model: s.claude?.modelChoice || null, detail: s.title || '' });

  child.stdout.on('data', (d) => {
    p.buf += d;
    let i;
    while ((i = p.buf.indexOf('\n')) >= 0) {
      const line = p.buf.slice(0, i);
      p.buf = p.buf.slice(i + 1);
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      try { engine.handleEvent(s.id, j); } catch (e) { console.error('[claude] event error:', e.message); }
    }
  });
  child.stderr.on('data', (d) => { p.stderr = (p.stderr + d).slice(-4000); });
  child.on('error', (e) => {
    appendChat(s.id, { kind: 'error', text: `${engine.id} failed to start: ${e.message}` });
    setClaude(s.id, { state: 'dead' });
    procs.delete(s.id);
  });
  child.on('close', (code) => {
    if (record(s.id)?.child !== child) return; // a newer proc replaced us
    procs.delete(s.id);
    const sess = getSession(s.id);
    if (!sess) return;
    // Any permission request still pending for this session is dead the
    // instant its process exits — deny it now instead of leaving the chat
    // card showing live Allow/Deny buttons for up to 10 minutes. Also mark
    // running bg shells (children of this proc) as exited.
    reapSessionOnExit(s.id, `${engine.id} process exited`);
    // a --resume that dies almost immediately usually means the claude session
    // is gone ("No conversation found") → retry once fresh, replaying messages
    if (p.resume && code !== 0 && Date.now() - p.spawnedAt < 5000 && !p.expectKill) {
      setClaude(s.id, { sessionId: null });
      try {
        const np = spawnProc(sess, false);
        const retryEngine = pickEngine(sess);
        for (const text of p.sent) retryEngine.writeMessage(np, { text: composeTurnText(np, text) });
        if (p.sent.length) np.sent.push(...p.sent);
        return;
      } catch {}
    }
    if (!p.expectKill && code !== 0) {
      appendChat(s.id, { kind: 'error', text: `${engine.id} exited (code ${code})${p.stderr ? ': ' + p.stderr.trim().slice(0, 400) : ''}` });
    }
    setClaude(s.id, { state: p.expectKill || code === 0 ? 'idle' : 'dead' });
  });

  // permissionMode is known at spawn (init would otherwise be the first source).
  mergeCaps(s.id, { permissionMode: s.claude?.permissionMode || 'bypassPermissions' });
  // A fresh proc re-establishes every MCP connection, so drop verdicts that
  // belonged to the previous proc (needs-reconnect/degraded/connected) to
  // 'pending' until a real signal lands. needs-auth is a credentials problem a
  // respawn can't fix, so it stays.
  {
    const pend = {};
    for (const [name, sv] of Object.entries(mcpServersOf(s.id))) {
      if (sv.status !== 'needs-auth') pend[name] = { status: 'pending', statusText: 'reconnecting…', source: 'spawn' };
    }
    patchMcp(s.id, pend);
  }
  // Whatever this engine has to say on stdin before the first user turn.
  // claude: the eager `initialize` handshake (below). codex: nothing at all —
  // its stdin IS the prompt, so anything written here would be read as part of
  // the user's first message. See EngineDriver.handshake.
  try { engine.handshake?.(p); } catch {}
  return p;
}

// Merge a patch into session.claude.capabilities, ignoring undefined values so
// the two sources (init event + initialize handshake) accumulate, not clobber.
const arr = (v) => (Array.isArray(v) ? v : undefined);
function mergeCaps(id, patch) {
  const prev = getSession(id)?.claude?.capabilities || {};
  const next = { ...prev };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
  setClaude(id, { capabilities: next });
}

// ---- MCP server health -------------------------------------------------------
// session.claude.mcp.servers[name] = { status, statusText, at, source } — the
// live truth the /mcp panel renders. capabilities.mcpServers is a snapshot the
// init event takes once per proc (first turn only) and never revisits, so it
// keeps reporting "connected" long after connections drop — most visibly after
// an account switch, where claude.ai connector grants (which are per-account)
// silently vanish. This map is instead driven by every REAL signal available:
// the init event, live mcp__<server>__* tool results, `claude mcp list` probes
// run under the session's own account env, and explicit invalidation when the
// session's account changes.

const mcpServersOf = (id) => getSession(id)?.claude?.mcp?.servers || {};

// Merge a map of name → health-patch in ONE setClaude (one broadcast).
function patchMcp(id, serverPatches, extra = {}) {
  const s = getSession(id);
  if (!s || (!Object.keys(serverPatches).length && !Object.keys(extra).length)) return;
  const prev = s.claude?.mcp || { servers: {} };
  const servers = { ...prev.servers };
  const now = Date.now();
  for (const [name, patch] of Object.entries(serverPatches)) {
    servers[name] = { ...servers[name], ...patch, at: now };
  }
  setClaude(id, { mcp: { ...prev, ...extra, servers } });
}

function seedMcpFromInit(id, list) {
  if (!Array.isArray(list)) return;
  const patch = {};
  for (const sv of list) {
    if (!sv?.name) continue;
    patch[sv.name] = { status: sv.status || 'unknown', statusText: sv.status || '', source: 'init' };
  }
  patchMcp(id, patch);
}

// Tool ids look like mcp__<server>__<tool>, with the server name sanitized
// (spaces/dots → underscores). Both halves can contain underscores, so match
// the sanitized KNOWN names first and only then fall back to the first '__'.
const saneMcpName = (n) => String(n).replace(/[^A-Za-z0-9_-]/g, '_');
function mcpServerForTool(id, toolName) {
  const rest = toolName.slice('mcp__'.length);
  const caps = getSession(id)?.claude?.capabilities?.mcpServers;
  const known = new Set([
    ...Object.keys(mcpServersOf(id)),
    ...(Array.isArray(caps) ? caps.map((sv) => sv?.name).filter(Boolean) : []),
  ]);
  for (const name of known) if (rest.startsWith(saneMcpName(name) + '__')) return name;
  const i = rest.indexOf('__');
  return i > 0 ? rest.slice(0, i) : null;
}

// A live tool result is the strongest health signal there is: a non-error
// result proves the server answered; an error matching a transport/auth
// failure proves it didn't. Tool-level errors (bad arguments etc.) prove
// nothing about the connection and leave the verdict alone.
const MCP_DOWN_RE =
  /not connected|connection (?:closed|refused|reset|failed|error)|transport|disconnected|no such tool|tool .{0,60}not (?:found|available)|econnrefused|econnreset|epipe|socket hang up|unauthorized|401|403|forbidden|invalid[_ ](?:token|grant)|authentication|needs? (?:re-?)?auth/i;

// Exported for the codex driver (server/codex.ts): its stream carries the same
// live-tool-result health signal in a different shape.
export function noteMcpResult(id, server, block) {
  const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
  if (!block.is_error) {
    patchMcp(id, { [server]: { status: 'connected', statusText: 'verified by live tool call', source: 'traffic' } });
  } else if (MCP_DOWN_RE.test(text)) {
    patchMcp(id, { [server]: { status: 'degraded', statusText: `tool call failed: ${text.trim().slice(0, 140)}`, source: 'traffic' } });
  }
}

// Account-switch invalidation: every verdict recorded under the old identity is
// now unverifiable, so flip previously-healthy servers to needs-reconnect until
// a real signal (respawn's init, a probe, a live call) proves otherwise.
// needs-auth stays — a reconnect can't mint credentials.
/**
 * RES1 — take a dead MCP server out of play for one session and tell the model,
 * instead of letting every call to it fail the turn. Nothing is respawned: the
 * server stays in the CLI's config, but the session knows not to reach for it.
 */
export function disableMcpServer(id, name, why = 'server is down') {
  if (!mcpServersOf(id)[name]) return false;
  patchMcp(id, { [name]: { status: 'degraded', statusText: `disabled by the supervisor — ${why}`, source: 'supervisor', disabled: true } });
  appendChat(id, {
    kind: 'system',
    text: `⤷ the "${name}" MCP server is down (${why}) — disabled for this session. Don't call its tools; use another route, or say why you can't continue without it.`,
  });
  return true;
}

export function markMcpStale(id, reason = 'account switched') {
  const patch = {};
  for (const [name, sv] of Object.entries(mcpServersOf(id))) {
    if (sv.status === 'needs-auth' || sv.status === 'needs-reconnect') continue;
    patch[name] = { status: 'needs-reconnect', statusText: `${reason} — reconnect to re-establish`, source: 'stale' };
  }
  if (Object.keys(patch).length) patchMcp(id, patch);
}

// Active probe: `claude mcp list` health-checks every server it can see. Run in
// the session's cwd (project .mcp.json servers resolve) WITH the session's
// account env — the daemon-level /mcp/servers list runs on the daemon's own
// login, which is exactly the stale-identity trap this exists to avoid.
// claude.ai connectors don't show up in `mcp list`; their health comes from the
// init/traffic signals above. Cached briefly + in-flight-deduped per session,
// mirroring mcp-auth's listServers.
const mcpProbes = new Map(); // sessionId → in-flight promise
const MCP_PROBE_TTL = 45_000;

export async function checkMcp(id, force = false) {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  const cur = s.claude?.mcp;
  if (!force && cur?.checkedAt && Date.now() - cur.checkedAt < MCP_PROBE_TTL) return cur;
  if (mcpProbes.has(id)) return mcpProbes.get(id);
  const p = (async () => {
    try {
      const { runClaude, parseList } = await import('./mcp-auth.js');
      const cwd = untildify(s.metadata?.worktree || s.cwd) || HOME;
      const out = await runClaude(['mcp', 'list'], 25_000, cwd, { ...baseEnv(), ...accountEnv(s) });
      const patch = {};
      for (const sv of parseList(out)) {
        patch[sv.name] = { status: sv.status, statusText: sv.statusText, source: 'probe' };
      }
      patchMcp(id, patch, { checkedAt: Date.now() });
      return getSession(id)?.claude?.mcp || null;
    } finally {
      mcpProbes.delete(id);
    }
  })();
  mcpProbes.set(id, p);
  return p;
}

// ---- stream-json → normalized chat events ----------------------------------
// Normalized kinds: user | assistant-text | tool-use | tool-result | thinking
//                   | result | error (+ permission-request/answer from api.js)

// Each assistant message echoes the token accounting for the request that
// produced it. cache_read + cache_creation + input ≈ the prompt currently
// occupying the model's context window (output isn't part of the next turn's
// context). We surface it as claude.usage so the UI can show a live context %.
// Exported for the codex driver, which maps codex's usage field names onto
// claude's before calling this (server/codex.ts).
// `catalog`: codex's model rows, so its window comes from models_cache.json (lib/ctx-window.ts).
/** @param {string} id @param {any} u @param {import('./lib/ctx-window.js').CatalogWindow[] | null} [catalog] */
export function updateUsage(id, u, catalog = null) {
  if (!u) return;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreation = u.cache_creation_input_tokens || 0;
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const ctxTokens = cacheRead + cacheCreation + input;
  if (ctxTokens <= 0) return; // skip empty/partial usage blocks
  const resolved = resolveCtxWindow(getSession(id)?.claude?.model, catalog);
  let ctxWindow = resolved.window;
  let ctxAssumed = resolved.assumed;
  // A prompt can never exceed its real window — if the measured tokens beat our
  // resolved window, the resolution was wrong (or genuinely unknown): step up
  // to the 1M tier and keep it flagged assumed since we still don't know the
  // model's real ceiling, just that it's bigger than we thought.
  if (ctxTokens > ctxWindow) { ctxWindow = 1_000_000; ctxAssumed = true; }
  const ctxPct = Math.min(100, Math.round((ctxTokens / ctxWindow) * 100));
  setClaude(id, {
    usage: { ctxTokens, ctxWindow, ctxPct, ctxAssumed, breakdown: { cacheRead, cacheCreation, input, output } },
  });
}

// ---- A3: agent ledger + daily budget ----------------------------------------
// Every assistant message of a turn adds its usage to the proc's running tally;
// the `result` event closes the turn: one 'turn' line in the agent's
// activity.jsonl (tokens + cost delta), then the budget check — exceeded → one
// final warning into the session (once per local day) and a 'budget' line.
export function noteTurnUsage(id, u) {
  const p = record(id);
  if (!p?.agent || !u) return;
  p.turn.input += u.input_tokens || 0;
  p.turn.output += u.output_tokens || 0;
  p.turn.cacheCreation += u.cache_creation_input_tokens || 0;
  p.turn.cacheRead += u.cache_read_input_tokens || 0;
}

export function recordTurn(id, j) {
  const p = record(id);
  if (!p?.agent) return;
  const b = p.turn;
  const tokens = b.input + b.output + b.cacheCreation + b.cacheRead;
  // total_cost_usd null = the engine reports no cost (codex): recorded as null, not $0.
  const uncosted = j.total_cost_usd === null;
  const total = Number(j.total_cost_usd) || 0;
  const costUsd = total >= p.lastCostUsd ? total - p.lastCostUsd : total;
  p.lastCostUsd = total;
  p.turn = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  if (tokens > 0 || costUsd > 0)
    appendActivity(p.agent, { kind: 'turn', sessionId: id, tokens, breakdown: b, costUsd: uncosted ? null : Math.round(costUsd * 1e6) / 1e6, model: getSession(id)?.claude?.model || null, durationMs: j.duration_ms });
  try {
    const st = budgetState(p.agent);
    const day = localDay();
    if (st?.exceeded && p.budgetWarnedDay !== day) {
      p.budgetWarnedDay = day;
      const name = getAgent(p.agent)?.name || p.agent;
      const line = budgetRefusal(st, name);
      appendActivity(p.agent, { kind: 'budget', sessionId: id, detail: line, tokens: st.usedTokens });
      appendChat(id, { kind: 'error', text: `[host] ${line}`, isError: true, budget: true });
      // One final turn so the model can wrap up; after it the host refuses every
      // further turn of this agent (budgetRefusalFor) and every new session.
      sendMessage(id, `[host] FINAL WARNING — ${line}. This is your LAST turn today: finish now — write a short status (set_status_summary / memory) and stop. Further messages will be refused until local midnight.`, [], { system: true });
    }
  } catch (e) {
    console.error('[ledger] budget check failed:', e?.message || e);
  }
}

// ---- auto-switch on account limit -------------------------------------------
// When a turn ends with a subscription limit error, quarantine the account that
// hit it until its reset, switch the session to the next available pooled
// account (resume preserves the conversation), and replay the failed message so
// the turn actually completes. This is the "auto switch when hit the limit" the
// accounts feature was built for.
const LIMIT_RE = /hit your (?:session|usage|weekly) limit|usage limit reached|rate limit|exceeded your.{0,20}limit|out of (?:usage|credits)/i;
// B34: Claude Code's error_during_execution diagnostic (`[ede_diagnostic] result_type=… stop_reason=…`).
export const EDE_DIAGNOSTIC_RE = /^\s*\[ede_diagnostic\]/;
const INTERRUPT_WINDOW_MS = 30_000;

/**
 * B34 — the chat event for a `result` that is only Claude Code's
 * `[ede_diagnostic] result_type=… stop_reason=…` line (error_during_execution),
 * or null when the result is a normal one and the caller should render it as
 * usual. Within INTERRUPT_WINDOW_MS of a host-sent interrupt it is the stop
 * itself → a system line (never an error row: nothing failed, and the
 * supervisor must not treat it as one). Otherwise an error row that says what
 * happened in words, with the raw diagnostic in `detail`.
 */
export function resultChatEvent(j, { interruptedAt = 0, now = Date.now() } = {}) {
  const text = j?.result || (j?.errors || []).join('; ') || '';
  if (!j?.is_error || !EDE_DIAGNOSTIC_RE.test(text)) return null;
  const interrupted = !!interruptedAt && now - interruptedAt < INTERRUPT_WINDOW_MS;
  const meta = { detail: text, durationMs: j.duration_ms, costUsd: j.total_cost_usd, numTurns: j.num_turns };
  return interrupted
    ? { kind: 'system', text: '⏹ interrupted', ...meta }
    : { kind: 'error', text: 'The turn ended unexpectedly (error_during_execution).', isError: true, ...meta };
}
// RES1 — the other way a model stops being usable: the CLI/API says the model
// itself is gone or saturated. Same remedy as an exhausted account pool (drop a
// rung of the model chain), so it shares the limit path below.
const MODEL_UNAVAILABLE_RE =
  /model[^.\n]{0,40}(?:is\s+)?(?:not available|unavailable|not found|overloaded)|overloaded_error|do(?:es)? not have access to (?:the )?model|invalid[_ ]model/i;
const switchingSessions = new Set(); // guards against re-entrant switching per session

// Parse "resets 3:20pm (Asia/Jerusalem)" → a future ISO timestamp (server-local
// tz, which is what the CLI prints). Falls back to +1h so a parse miss still
// quarantines the maxed account for a while instead of not at all.
function parseResetAt(text) {
  const fallback = () => new Date(Date.now() + 60 * 60_000).toISOString();
  const m = /reset[s]?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text || '');
  if (!m) return fallback();
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return fallback();
  const d = new Date();
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // already passed today → tomorrow
  return d.toISOString();
}

// RES1 — one line in $ARIGAMI_DIR/incidents.jsonl per automatic recovery, so
// Settings → Host → Health can answer "what did the host do while I slept".
// Never allowed to fail the recovery it is describing.
function recordIncident(id, action, detail = {}, outcome = 'ok', reason = 'quota') {
  try {
    // appendIncident broadcasts {type:'incident'} itself (incidents.ts) — one
    // neck, so an extension hook never sees the same incident twice.
    appendIncident({ sessionId: id, action, health: 'BLOCKED_SYSTEM', reason, outcome, detail });
    // An escalation here is the same event the supervisor records for the ones it
    // handles: stamp it on the session so it shows red on the rail and lands in
    // the "waiting for you" queue instead of quietly looking idle.
    if (outcome === 'escalated')
      patchSession(id, { metadata: { supervisor: { escalated: true, at: new Date().toISOString(), reason, after: detail.after || null } } });
  } catch {}
}

// ---- RES1: the model ladder -------------------------------------------------
// "Fable ran out but the weaker models still have quota — keep going." Every
// session has a chain (session override → its agent's → cfg.modelChain →
// supervisor.DEFAULT_MODEL_CHAIN) whose TOP rung is the model the human actually
// picked. When the account pool can no longer route around a limit we drop ONE
// rung and replay the failed turn; the supervisor climbs back to the top rung
// once the quota reset time passes (server/supervisor-loop.ts, 'model-restore').

/** The effective chain for a session, top rung first. */
export function chainFor(id) {
  const s = getSession(id);
  const slug = typeof s?.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null;
  const agent = slug ? getAgent(slug) : null;
  return effectiveChain({
    sessionChain: s?.claude?.modelChain,
    agentChain: agent?.modelChain,
    configChain: cfg.modelChain,
    // The top rung is the model the session is MEANT to run on. While it is
    // downgraded that is `modelDowngradedFrom`, not the weaker rung it is on —
    // reading modelChoice here would re-root the chain at every downgrade and
    // make "restore to the top" restore to the model we just dropped to.
    modelChoice: s?.claude?.modelDowngradedFrom || s?.claude?.modelChoice || agent?.model || cfg.defaultModel || null,
  });
}

/** Where the session sits in its chain right now + how far it can still fall. */
// The RES1 ladder, account switch and auth refresh are claude-shaped; a codex session never enters them.
export const isCodexSession = (id) => getSession(id)?.engine === 'codex';
/** P3-1: a codex session on the app-server driver (approvals, compaction, live turns). */
export const isCodexAppSession = (id) => {
  try { return isCodexSession(id) && pickEngine(getSession(id)).permissions.kind === 'rpc-request'; } catch { return false; }
};

/** P2-6: a codex session's chain — codex model ids from cfg.codexModelChain, filtered to the active account's catalog. */
export function codexChainFor(id) {
  const s = getSession(id);
  const slug = typeof s?.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null;
  const agent = slug ? getAgent(slug) : null;
  const own = agent?.engine === 'codex' ? agent : null;
  return codexChain({
    sessionChain: s?.claude?.modelChain,
    agentChain: own?.modelChain,
    configChain: cfg.codexModelChain,
    catalog: codexCatalogIds(),
    modelChoice: s?.claude?.modelDowngradedFrom || s?.claude?.modelChoice || own?.model || null,
  });
}

export function ladderState(id) {
  const s = getSession(id);
  if (s?.engine === 'codex') return codexLadder(codexChainFor(id), s.claude);
  const chain = chainFor(id);
  const stored = Number.isFinite(s?.claude?.modelRung) ? Number(s.claude.modelRung) : rungOf(chain, s?.claude?.modelChoice);
  const rung = stored > 0 ? Math.min(stored, chain.length - 1) : 0;
  return { chain, rung, model: chain[rung] || null, rungsLeft: rungsLeft(chain, rung), restoreAt: s?.claude?.modelRestoreAt || null };
}

const ladderCooldown = new Set(); // guards against a downgrade cascade per session

/**
 * Drop one rung, announce it in the chat, and replay the turn that failed.
 *   {ok:true, model}          — we moved down and the turn is being replayed
 *   {ok:false, reason:'bottom'} — no rung left; the ONE limit case a human owns
 *   {ok:false, reason:'cooling'|'failed'} — a downgrade is already in flight
 */
/** @param {string} id @param {{resetAt?: string|null, why?: string}} [opts] */
export function downgradeModel(id, { resetAt = null, why = 'quota' } = {}) {
  if (isCodexSession(id)) return { ok: false, reason: 'engine' };
  const { chain, rung } = ladderState(id);
  const nxt = nextRung(chain, rung);
  if (!nxt) return { ok: false, reason: 'bottom' };
  // One rung per cooldown window: the replayed turn below can fail the same way,
  // and without this the session would walk the whole chain in a second.
  if (ladderCooldown.has(id)) return { ok: false, reason: 'cooling' };
  ladderCooldown.add(id);
  const cd = setTimeout(() => ladderCooldown.delete(id), 30_000);
  if (cd.unref) cd.unref();
  const from = chain[rung] || getSession(id)?.claude?.modelChoice || 'default';
  const lastMsg = [...(record(id)?.sent || [])].pop();
  // When the CLI never told us when the quota resets, arm the climb back after
  // cfg.supervisor.modelBackoffMin instead of never — a downgrade that can't
  // expire would quietly pin the session to the weakest model forever.
  const restoreAt =
    resetAt || new Date(Date.now() + Math.max(0.01, cfg.supervisor?.modelBackoffMin ?? 60) * 60_000).toISOString();
  const patch = {
    modelChoice: nxt.model,
    modelRung: nxt.rung,
    modelRestoreAt: restoreAt,
    modelDowngradedFrom: chain[0] || from,
    ...autoCompactFor(id, nxt.model),
  };
  // LADDER1: does the conversation even FIT the weaker rung? A 1M-window
  // conversation `--resume`d into a 200k model is over the limit before its
  // first turn — the "context dies in a second" incident. Judge it against the
  // TARGET model's window, not the current one.
  const plan = planReplay({ estTokens: conversationTokens(id), targetWindow: resolveCtxWindow(nxt.model).window, headroom: ladderHeadroom() });
  const resetsLine = ` · ${from}'s quota resets ${localTime(restoreAt)}`;
  if (plan.mode === 'compact') {
    appendChat(id, {
      kind: 'system',
      text:
        `⤷ ${from} is out of quota (${why}) — switched to ${nxt.model} and continuing${resetsLine}. ` +
        `The conversation (~${Math.round(plan.estTokens / 1000)}k tokens) does not fit ${nxt.model}'s ${Math.round(plan.targetWindow / 1000)}k window — compacting it first…`,
    });
    // The summarizer runs on the TARGET rung (it has quota; the current one does
    // not) — async, so the caller (a stream-json event handler) is not blocked.
    // The cooldown is held until the respawn lands, so nothing else walks the
    // ladder meanwhile.
    clearTimeout(cd);
    compactAndRespawn(id, { from, to: nxt.model, plan, patch, lastMsg })
      .catch((e) => {
        console.error('[ladder] compaction failed:', e?.message || e);
        appendChat(id, { kind: 'error', text: `⤷ compacting the conversation for ${nxt.model} failed: ${String(e?.message || e).slice(0, 200)}` });
      })
      .finally(() => {
        const t = setTimeout(() => ladderCooldown.delete(id), 30_000);
        if (t.unref) t.unref();
      });
    return { ok: true, model: nxt.model, from, compacting: true };
  }
  appendChat(id, {
    kind: 'system',
    text: `⤷ ${from} is out of quota (${why}) — switched to ${nxt.model} and continuing${resetsLine}`,
  });
  try {
    restartWith(id, {
      ...patch,
      ladderReplay: { mode: 'full', at: new Date().toISOString(), from, to: nxt.model, estTokens: plan.estTokens, targetWindow: plan.targetWindow },
    });
  } catch {
    ladderCooldown.delete(id);
    return { ok: false, reason: 'failed' };
  }
  // Replay the failed turn on the weaker model once the resumed proc is up.
  const t = setTimeout(() => {
    try { if (lastMsg) sendMessage(id, lastMsg); } catch {}
  }, 900);
  if (t.unref) t.unref();
  return { ok: true, model: nxt.model, from };
}

// ---- LADDER1: compact-before-replay ------------------------------------------

/** The replay may use at most this share of the target window (cfg.supervisor.ladderHeadroom, default 0.7). */
function ladderHeadroom() {
  const h = Number(cfg.supervisor?.ladderHeadroom);
  return Number.isFinite(h) && h > 0 && h <= 1 ? h : 0.7;
}
function ladderTailTurns() {
  const n = Number(cfg.supervisor?.ladderTailTurns);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 6;
}
const COMPACT_TIMEOUT_MS = 150_000;

/** "18:50" in the host's local time — what the human reads in the receipt. */
function localTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return String(iso || '');
  }
}

/**
 * How many tokens the live conversation occupies. The measured figure — the
 * last assistant message's cache_read+cache_creation+input (updateUsage) — is
 * the truth when we have it; a fresh or never-answered session falls back to a
 * chars/4 estimate over the chat log.
 */
export function conversationTokens(id) {
  const s = getSession(id);
  const measured = Number(s?.claude?.usage?.ctxTokens);
  if (Number.isFinite(measured) && measured > 0) return measured;
  const evs = getChat(id, 0) || [];
  return estimateTextTokens(renderEvents(evs, Number.MAX_SAFE_INTEGER).text);
}

/** Keep a configured auto-compact % meaningful on the new rung's window. */
function autoCompactFor(id, model) {
  const pct = getSession(id)?.claude?.autoCompactPct;
  if (!pct) return {};
  return { autoCompactTokens: Math.round(resolveCtxWindow(model, isCodexSession(id) ? codexCatalogWindows() : null).window * (pct / 100)) };
}

/**
 * Stop the live proc, persist `patch`, and start a FRESH claude conversation
 * (no --resume) whose first user message is preceded by `preamble`. The
 * previous conversation id is untouched on disk — the climb back resumes it.
 */
function respawnFresh(id, patch, preamble) {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  const p = record(id);
  if (p) {
    p.expectKill = true;
    try { p.child.stdin.end(); } catch {}
    stopChild(p.child);
    procs.delete(id);
    reapSessionOnExit(id, 'session restarted');
  }
  setClaude(id, { ...patch, sessionId: null });
  const np = spawnProc(getSession(id), false);
  np.preamble = preamble || '';
  setClaude(id, { state: 'idle' });
  return np;
}

async function compactAndRespawn(id, { from, to, plan, patch, lastMsg }) {
  const s = getSession(id);
  if (!s) return;
  const originalSessionId = s.claude?.sessionId || null;
  const events = getChat(id, 0) || [];
  const shape = shapeForCompaction(events, plan.targetWindow, { tailTurns: ladderTailTurns() });
  let digest = '';
  let digestKind = 'llm';
  if (shape.digestSource.trim()) {
    try {
      const token = accountEnv(s).CLAUDE_CODE_OAUTH_TOKEN;
      digest = await runClaudeOneShot(digestPrompt(shape.digestSource, { from, to }), {
        model: to, // the rung that still has quota — never the exhausted one
        cwd: untildify(s.metadata?.worktree || s.cwd) || HOME,
        timeoutMs: COMPACT_TIMEOUT_MS,
        tag: 'ladder-compact',
        ...(token ? { token } : {}),
      });
      if (!digest || !digest.trim()) throw new Error('empty digest');
    } catch (e) {
      console.error('[ladder] summarizer failed, using the mechanical digest:', e?.message || e);
      digest = fallbackDigest(shape.head);
      digestKind = 'fallback';
    }
  } else {
    digest = '(the whole conversation is in the verbatim tail below)';
  }
  if (!getSession(id)) return; // deleted meanwhile
  const preamble = buildPreamble({
    from,
    to,
    digest,
    tailText: shape.tailText,
    tailTurns: shape.tailTurns,
    estTokens: plan.estTokens,
    targetWindow: plan.targetWindow,
    imagesStripped: shape.imagesStripped,
    omittedFromDigest: shape.omittedFromDigest,
    resetAtLocal: patch.modelRestoreAt ? localTime(patch.modelRestoreAt) : null,
  });
  const np = respawnFresh(
    id,
    {
      ...patch,
      ladderReplay: {
        mode: 'compact',
        at: new Date().toISOString(),
        from,
        to,
        estTokens: plan.estTokens,
        targetWindow: plan.targetWindow,
        originalSessionId,
        compactSessionId: null, // filled in below once spawnProc pinned it
        tailTurns: shape.tailTurns,
        imagesStripped: shape.imagesStripped,
        digest: digestKind,
      },
    },
    preamble
  );
  const compactSessionId = getSession(id)?.claude?.sessionId || null;
  setClaude(id, { ladderReplay: { ...getSession(id)?.claude?.ladderReplay, compactSessionId } });
  appendChat(id, {
    kind: 'system',
    text:
      `⤷ context compacted for ${to}: a ${digestKind === 'llm' ? 'digest' : 'plain digest (summarizer unavailable)'} of the older conversation + the last ${shape.tailTurns} turn${shape.tailTurns === 1 ? '' : 's'} verbatim` +
      (shape.imagesStripped ? `, ${shape.imagesStripped} image${shape.imagesStripped === 1 ? '' : 's'} dropped` : '') +
      `. The full history is restored when ${from} comes back.`,
  });
  recordIncident(id, 'context-compact', { from, to, estTokens: plan.estTokens, targetWindow: plan.targetWindow, tailTurns: shape.tailTurns, imagesStripped: shape.imagesStripped, digest: digestKind, originalSessionId, compactSessionId }, 'ok', 'conversation larger than the target window');
  // Replay the failed turn once the fresh proc is up (the preamble rides in
  // front of it). With nothing in flight the preamble waits for the next message.
  if (lastMsg && np) {
    const t = setTimeout(() => {
      try { sendMessage(id, lastMsg); } catch {}
    }, 900);
    if (t.unref) t.unref();
  }
}

/**
 * Climb back to the top rung (the supervisor calls this once the quota reset,
 * or the human does by hand via the model picker's "back on <model>").
 * RES2: the supervisor now defers the automatic call until the session is idle
 * (server/supervisor.ts decide()), and the human only ever clicks this while
 * idle too — so in the overwhelming common case there is no in-flight turn to
 * lose, and nothing should be replayed (`record(id).sent` never clears, so its
 * last entry is often a message from a turn that already finished cleanly;
 * blindly replaying it would resend a stale duplicate). Only when the session
 * is ACTUALLY mid-turn at the moment we abort it — the race the idle-gate is
 * meant to close, closed here as a second line of defense — do we capture and
 * replay, exactly like downgradeModel/tryAutoSwitch.
 */
export function restoreModel(id) {
  if (isCodexSession(id)) return restoreCodexModel(id);
  const { chain, rung } = ladderState(id);
  if (rung <= 0) return null;
  const top = chain[0];
  const s0 = getSession(id);
  const wasWorking = s0?.claude?.state === 'working';
  const lastMsg = wasWorking ? [...(record(id)?.sent || [])].pop() : null;
  const cur = s0?.claude?.modelChoice || chain[rung] || 'the weaker model';
  // LADDER1: a downgrade that had to COMPACT the conversation left the full
  // history untouched under its original conversation id. Now that the top
  // rung is back, resume THAT — the digest was a stop-gap, not the history —
  // as long as it still fits the top rung's window. What happened meanwhile on
  // the weaker rung rides along as a short interim note.
  const note = s0?.claude?.ladderReplay || null;
  const target = restoreTarget(note, resolveCtxWindow(top).window, ladderHeadroom());
  const patch = { modelChoice: top, modelRung: 0, modelRestoreAt: null, modelDowngradedFrom: null, ...autoCompactFor(id, top) };
  if (target.resume === 'original') {
    const interim = interimDigest(id, note.at);
    appendChat(id, { kind: 'system', text: `⤷ quota reset — back on ${top}, with the full conversation history (the ${cur} digest is retired)` });
    restartWith(id, {
      ...patch,
      sessionId: note.originalSessionId,
      ladderReplay: { mode: 'full-restore', at: new Date().toISOString(), from: cur, to: top, estTokens: note.estTokens, targetWindow: resolveCtxWindow(top).window, originalSessionId: note.originalSessionId, compactSessionId: note.compactSessionId || null },
    });
    const np = record(id);
    if (np && interim) np.preamble = interim;
    recordIncident(id, 'context-restore', { from: cur, to: top, originalSessionId: note.originalSessionId, reason: target.reason }, 'ok', 'quota reset');
  } else {
    appendChat(id, { kind: 'system', text: `⤷ quota reset — back on ${top}` });
    restartWith(id, {
      ...patch,
      ...(note && note.mode === 'compact'
        ? { ladderReplay: { ...note, mode: 'compact-restore', at: new Date().toISOString() } }
        : {}),
    });
  }
  if (!lastMsg) return top;
  // Replay the turn that was actually interrupted, once the resumed proc is up.
  const t = setTimeout(() => {
    try { sendMessage(id, lastMsg); } catch {}
  }, 900);
  if (t.unref) t.unref();
  return top;
}

// ---- P2-6: the codex model ladder (P3-2: app-server compacts before the replay; exec cannot) ----
const codexLadderCooldown = new Set();

/** Drop a codex session one rung and replay `lastMsg`; same result shape as downgradeModel. */
/** @param {string} id @param {{resetAt?: string|null, why?: string, lastMsg?: string|null}} [opts] */
export function downgradeCodexModel(id, { resetAt = null, why = 'all Codex accounts limited', lastMsg = null } = {}) {
  if (!isCodexSession(id)) return { ok: false, reason: 'engine' };
  const { chain, rung } = ladderState(id);
  const nxt = nextRung(chain, rung);
  if (!nxt) return { ok: false, reason: 'bottom' };
  if (codexLadderCooldown.has(id)) return { ok: false, reason: 'cooling' };
  codexLadderCooldown.add(id);
  const cd = setTimeout(() => codexLadderCooldown.delete(id), 30_000);
  if (cd.unref) cd.unref();
  const from = chain[rung] || getSession(id)?.claude?.modelChoice || 'default';
  const msg = lastMsg ?? lastUserMessage(id);
  const restoreAt = resetAt || new Date(Date.now() + Math.max(0.01, cfg.supervisor?.modelBackoffMin ?? 60) * 60_000).toISOString();
  const patch = { modelChoice: nxt.model, modelRung: nxt.rung, modelRestoreAt: restoreAt, modelDowngradedFrom: chain[0] || from, ...autoCompactFor(id, nxt.model) };
  // P3-2: app-server compacts the thread itself when the conversation does not fit the weaker rung.
  const plan = isCodexAppSession(id) ? planReplay({ estTokens: conversationTokens(id), targetWindow: resolveCtxWindow(nxt.model, codexCatalogWindows()).window, headroom: ladderHeadroom() }) : null;
  const compact = plan?.mode === 'compact';
  appendChat(id, {
    kind: 'system',
    text: `⤷ ${from} is out of quota (${why}) — switched to ${nxt.model} and continuing · quota resets ${localTime(restoreAt)}` +
      (compact ? ` · the conversation (~${Math.round(plan.estTokens / 1000)}k tokens) does not fit ${nxt.model} — compacting it first…` : ''),
  });
  try {
    restartWith(id, { ...patch, ...(plan ? { ladderReplay: { mode: compact ? 'compact' : 'full', at: new Date().toISOString(), from, to: nxt.model, estTokens: plan.estTokens, targetWindow: plan.targetWindow } } : {}) });
  } catch {
    codexLadderCooldown.delete(id);
    return { ok: false, reason: 'failed' };
  }
  if (compact) {
    import('./codex-app.js')
      .then((m) => {
        m.requestCompaction(id, `${from} → ${nxt.model}`, () => { try { if (msg) sendMessage(id, msg); } catch {} });
        recordIncident(id, 'context-compact', { from, to: nxt.model, estTokens: plan.estTokens, targetWindow: plan.targetWindow, digest: 'codex' }, 'ok', 'conversation larger than the target window');
      })
      .catch(() => {});
    return { ok: true, model: nxt.model, from, compacting: true };
  }
  const t = setTimeout(() => { try { if (msg) sendMessage(id, msg); } catch {} }, 900);
  if (t.unref) t.unref();
  return { ok: true, model: nxt.model, from };
}

/** Climb a codex session back to its top rung; no replay unless a turn was in flight. */
export function restoreCodexModel(id) {
  const { chain, rung } = ladderState(id);
  if (rung <= 0) return null;
  const top = chain[0];
  const lastMsg = getSession(id)?.claude?.state === 'working' ? lastUserMessage(id) : null;
  appendChat(id, { kind: 'system', text: `⤷ quota reset — back on ${top}` });
  restartWith(id, { modelChoice: top, modelRung: 0, modelRestoreAt: null, modelDowngradedFrom: null });
  if (lastMsg) {
    const t = setTimeout(() => { try { sendMessage(id, lastMsg); } catch {} }, 900);
    if (t.unref) t.unref();
  }
  return top;
}

/** P2-6 incidents from codex-recovery.ts, same neck as the claude ones. */
export const recordCodexIncident = (id, action, detail, outcome = 'ok', reason = 'quota') => recordIncident(id, action, detail, outcome, reason);

/**
 * RES1 — the error family of the session's LAST turn, for the supervisor's
 * health model. Reads the transcript tail backwards and stops at the first
 * terminal signal: a successful result (or a newer user message) means the
 * session recovered and there is nothing to classify.
 */
/**
 * RES1 — the chat seq of the last real TURN signal (a user message or a finished
 * result). The supervisor uses it as "did anything actually move", which
 * session.updatedAt cannot answer: the supervisor's own receipts and metadata
 * writes bump updatedAt, so an escalated session would look like it had
 * recovered on the very next tick.
 */
export function lastTurnSeq(id) {
  const evs = getChat(id, 0) || [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const k = evs[i].kind;
    if (k === 'user' || k === 'result') return evs[i].seq || 0;
  }
  return 0;
}

export function lastTurnError(id) {
  const evs = getChat(id, 0) || [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.kind === 'result' && !e.isError) return null;
    if (e.kind === 'user') return null;
    if (e.kind === 'error' || (e.kind === 'result' && e.isError)) {
      const t = String(e.text || '');
      if (AUTH_RE.test(t)) return 'auth';
      // A model that cannot run right now is remedied exactly like an exhausted
      // account pool — one rung down the chain.
      if (getSession(id)?.engine === 'codex') { if (CODEX_LIMIT_RE.test(t)) return 'limit'; }
      else if (LIMIT_RE.test(t) || MODEL_UNAVAILABLE_RE.test(t)) return 'limit';
      if (/(?:claude|codex) (?:exited|failed to start)/i.test(t)) return 'proc-dead';
      return 'other';
    }
  }
  return null;
}

function tryAutoSwitch(id, text) {
  if (switchingSessions.has(id) || isCodexSession(id)) return;
  const s = getSession(id);
  const curId = s?.claude?.accountId || getActiveId();
  const resetAt = parseResetAt(text);
  try { quarantine(curId, resetAt); } catch {}
  const next = nextAvailable(curId);
  if (!next) {
    // RES1: the account pool is exhausted — before giving up, drop a rung of the
    // model chain. Only the BOTTOM rung with no quota left is a human's problem.
    const stepped = downgradeModel(id, { resetAt, why: 'all accounts limited' });
    if (stepped.ok) {
      recordIncident(id, 'model-down', { from: stepped.from, to: stepped.model, resetAt }, 'ok', 'all accounts limited');
      return;
    }
    if (stepped.reason !== 'bottom') return; // a downgrade is already in flight
    appendChat(id, {
      kind: 'error',
      text: 'All accounts have hit their limit and the model ladder is at its bottom rung. Add another account, or wait for one to reset.',
    });
    recordIncident(id, 'escalate', { after: 'model-ladder', resetAt }, 'escalated', 'bottom rung, no quota left');
    return;
  }
  switchingSessions.add(id);
  const cur = getAccount(curId);
  const lastMsg = [...(record(id)?.sent || [])].pop();
  appendChat(id, {
    // NB: was 'result' — ResultLine ignores event.text for non-error results
    // and always renders a generic "✓ Done", so this message was never
    // actually visible. 'system' is a plain info-styled line that shows it.
    kind: 'system',
    text: `⤷ ${cur?.label || 'account'} hit its limit — switched to “${next.label}” and retrying…`,
  });
  // Make the working account the new default so subsequent NEW sessions don't
  // start on the quarantined one and immediately hit the wall again.
  try { setActive(next.id); } catch {}
  try {
    setAccount(id, next.id); // restart with --resume on the new token
  } catch {
    switchingSessions.delete(id);
    return;
  }
  recordIncident(id, 'account-switch', { from: cur?.label || curId, to: next.label, resetAt }, 'ok', 'account limit');
  // Replay the failed turn on the fresh account once the resumed proc is up.
  const t = setTimeout(() => {
    try { if (lastMsg) sendMessage(id, lastMsg); } catch {} finally { switchingSessions.delete(id); }
  }, 900);
  if (t.unref) t.unref();
}

// ---- auto-recover on an expired/revoked auth token --------------------------
// A session's `claude` child gets its OAuth access token baked into its env
// ONCE, at spawn (accountEnv → tokenForSession). The background refresher in
// oauth-login.js keeps the STORED token fresh, but can never reach an
// already-running child — env vars are immutable post-spawn. A session that
// outlives one token lifetime starts failing auth on every turn until
// something respawns it. Detected the same way tryAutoSwitch detects a
// subscription-limit hit: from the structured `result` event's error text.
// F8: also the CLI's own "Not logged in · Please run /login" — the human cannot
// run /login in the cockpit; the answer is a `claude` Setup card.
export const AUTH_RE = /unauthorized|revoked|invalid[_ ](?:api key|token|grant)|token.{0,20}expired|authentication_error|please (?:log ?in|authenticate) again|not logged in|please run \/login/i;
const authRecovering = new Set(); // guards against re-entrant recovery per session

async function openClaudeSetupCard(id, why) {
  const [api, caps] = await Promise.all([import('./api.js'), import('./capabilities.js')]);
  const cap = caps.getCapability('claude');
  if (!cap) return;
  api.openSetupCard(id, cap, why, 'manual', 'not signed in');
}

/**
 * RES1 — the same auth recovery the `result` handler runs, exposed so the
 * supervisor can drive it for a session that is already sitting dead (the event
 * that would have triggered it is long gone). Resolves true when a refresh +
 * respawn actually happened.
 */
export async function recoverAuth(id) {
  if (isCodexSession(id)) return false;
  const before = getSession(id)?.claude?.state;
  await tryAuthRecover(id, 'unauthorized');
  return getSession(id)?.claude?.state !== before || isRunning(id);
}

async function tryAuthRecover(id, text) {
  if (authRecovering.has(id) || isCodexSession(id)) return;
  const s = getSession(id);
  const accountId = s?.claude?.accountId || getActiveId();
  // F8: the session was spawned before a Claude account existed (fresh
  // install: "New session" first, Connect Claude second) and an account
  // resolves NOW → just respawn with it and replay the turn.
  const p = record(id);
  if (p && !p.hadToken && accountEnv(s).CLAUDE_CODE_OAUTH_TOKEN) {
    authRecovering.add(id);
    const lastMsg = [...(p.sent || [])].pop();
    appendChat(id, { kind: 'system', text: '⟳ Claude account connected — restarted the session with it' });
    restart(id, { silent: true });
    const t = setTimeout(() => { try { if (lastMsg) sendMessage(id, lastMsg); } catch {} }, 900);
    if (t.unref) t.unref();
    setTimeout(() => authRecovering.delete(id), 5000);
    return;
  }
  if (!resolveRefreshToken(accountId)) {
    // Nothing to refresh: open the Connect-Claude card right here in the chat
    // (paste the code / a token) instead of a dead-end error.
    openClaudeSetupCard(id, 'this session\'s Claude account is not signed in — connect one to continue').catch(() => {});
    return;
  }
  authRecovering.add(id);
  const lastMsg = [...(record(id)?.sent || [])].pop();
  try {
    const ok = await refreshOne(accountId);
    if (!ok) {
      appendChat(id, { kind: 'error', text: 'Authentication error — token refresh failed. Please re-authenticate this account.' });
      recordIncident(id, 'refresh-auth', { accountId }, 'failed', 'token expired');
      return;
    }
    appendChat(id, { kind: 'system', text: '⟳ authentication expired — refreshed the token and restarted the session' });
    recordIncident(id, 'refresh-auth', { accountId }, 'ok', 'token expired');
    restart(id, { silent: true }); // respawns, re-reading the just-refreshed token
    // Replay the failed turn once the resumed proc is up.
    const t = setTimeout(() => {
      try { if (lastMsg) sendMessage(id, lastMsg); } catch {}
    }, 900);
    if (t.unref) t.unref();
  } finally {
    // Small cooldown so a token that fails again immediately after refresh
    // doesn't spin this in a tight loop.
    setTimeout(() => authRecovering.delete(id), 5000);
  }
}

function handleEvent(id, j) {
  switch (j.type) {
    case 'system':
      // The init event reports mcp_servers / tools / skills — but only fires on
      // the first turn. We merge it with the eager `initialize` handshake
      // (control_response below), which provides commands/agents/models/account
      // at spawn. Together they back the slash-command palette + capabilities panel.
      if (j.subtype === 'init') {
        setClaude(id, {
          ...(j.session_id ? { sessionId: j.session_id } : {}),
          ...(j.model ? { model: j.model } : {}),
        });
        mergeCaps(id, {
          version: j.claude_code_version,
          model: j.model,
          permissionMode: j.permissionMode,
          apiKeySource: j.apiKeySource,
          mcpServers: arr(j.mcp_servers),
          tools: arr(j.tools),
          skills: arr(j.skills),
        });
        // Fresh per-proc connection report → re-seed the live health map (this
        // is what clears 'pending'/'needs-reconnect' after a restart).
        seedMcpFromInit(id, arr(j.mcp_servers));
      }
      break;
    case 'control_response': {
      // Eager `initialize` handshake reply: rich command list (with
      // descriptions + arg hints), subagents, models, and the account.
      // It's also the "proc is up" signal a restart waits on.
      if (getSession(id)?.claude?.state === 'restarting') setClaude(id, { state: 'idle' });
      const r = j.response?.response;
      if (r && Array.isArray(r.commands)) {
        mergeCaps(id, {
          commands: r.commands.map((c) => ({
            name: c.name,
            description: c.description || '',
            argumentHint: c.argumentHint || '',
          })),
          agents: arr(r.agents),
          models: arr(r.models),
          account: r.account || undefined,
        });
      }
      break;
    }
    case 'assistant':
      updateUsage(id, j.message?.usage);
      noteTurnUsage(id, j.message?.usage);
      for (const block of j.message?.content || []) {
        if (block.type === 'text' && block.text) {
          appendChat(id, { kind: 'assistant-text', text: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          appendChat(id, { kind: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use') {
          // arigami cockpit tools (permission_prompt, request_action/review,
          // set_status/title/progress, open_tab, …) drive the UI directly —
          // they surface as a permission card, a sticky action bar, a status
          // badge, a tab, etc. Echoing the raw call + its result as JSON bubbles
          // shows the same thing twice and clutters ("jams") the transcript, so
          // suppress both here (remember the id to also drop the tool_result).
          // Every mcp__* call (including suppressed arigami ones) feeds the
          // live MCP health map: its paired result proves the server up or down.
          if (typeof block.name === 'string' && block.name.startsWith('mcp__')) {
            const server = mcpServerForTool(id, block.name);
            if (server) record(id)?.mcpToolCalls.set(block.id, server);
          }
          if (typeof block.name === 'string' && block.name.startsWith('mcp__arigami__')) {
            record(id)?.hostToolIds.add(block.id);
            continue;
          }
          appendChat(id, { kind: 'tool-use', toolUseId: block.id, name: block.name, input: block.input });
          if (block.name === 'Bash' && block.input?.run_in_background === true) {
            record(id)?.pendingBg.set(block.id, {
              command: block.input.command || '',
              description: block.input.description || '',
            });
          } else if (block.name === 'KillShell') {
            const sh = block.input?.shell_id || block.input?.bash_id;
            if (sh) markBg(id, sh, 'killed');
          }
        }
      }
      break;
    case 'user': // tool results echo back as user messages
      for (const block of j.message?.content || []) {
        if (block.type === 'tool_result') {
          // MCP health first — even results we suppress below carry the signal.
          const mcpServer = record(id)?.mcpToolCalls.get(block.tool_use_id);
          if (mcpServer) {
            record(id).mcpToolCalls.delete(block.tool_use_id);
            noteMcpResult(id, mcpServer, block);
          }
          // Drop the result echo for a suppressed arigami cockpit tool_use —
          // it's the paired JSON (often a large capabilities/session blob) for a
          // call we already hid; the UI effect already happened.
          const hostIds = record(id)?.hostToolIds;
          if (hostIds?.has(block.tool_use_id)) {
            hostIds.delete(block.tool_use_id);
            continue;
          }
          appendChat(id, {
            kind: 'tool-result',
            toolUseId: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : block.content ?? '',
            isError: !!block.is_error,
          });
          // bg Bash: pair the result (shell ID + output path) with its tool_use
          const pend = record(id)?.pendingBg.get(block.tool_use_id);
          if (pend) {
            record(id).pendingBg.delete(block.tool_use_id);
            const c = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            const idm = /ID:\s*([A-Za-z0-9_-]+)/.exec(c);
            // POSIX `/tmp/x.output` or Windows `C:\Users\…\x.output`.
            const pm = /written to:\s*((?:[A-Za-z]:[\\/]|\/)\S+?\.output)/.exec(c);
            if (idm && pm) {
              registerBg(id, { command: pend.command, description: pend.description, shellId: idm[1], outputFile: pm[1] });
            }
          }
        }
      }
      break;
    case 'stream_event': {
      // live typing: broadcast text deltas but never persist them (the full
      // assistant-text event lands when the message completes)
      const ev = j.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        broadcast({ type: `chat:${id}`, event: { kind: 'assistant-text', partial: true, text: ev.delta.text } });
      }
      break;
    }
    case 'result':
      if (j.session_id) setClaude(id, { sessionId: j.session_id, state: 'idle' });
      else setClaude(id, { state: 'idle' });
      // The turn finished — deliver any listener wakes that were queued while the
      // session was busy. Dynamic import breaks the claude ⇄ listeners cycle.
      import('./listeners.js').then((m) => m.onSessionIdle(id)).catch(() => {});
      // A pending "restart when idle" (host-control.ts) advances here too.
      import('./host-control.js').then((m) => m.restarts.onSessionIdle()).catch(() => {});
      {
        const text = j.result || (j.errors || []).join('; ') || '';
        // B34: `[ede_diagnostic] …` is Claude Code's internal note on an
        // error_during_execution result — raw telemetry, not a message. After
        // an interrupt WE sent (Esc) it is just the stop: a quiet system line
        // and no recovery branch (nothing failed). See resultChatEvent().
        {
          const p = record(id);
          const ede = resultChatEvent(j, { interruptedAt: p?.interruptedAt || 0 });
          if (ede) {
            if (p) p.interruptedAt = 0;
            appendChat(id, ede);
            recordTurn(id, j);
            break;
          }
        }
        appendChat(id, {
          kind: j.is_error ? 'error' : 'result',
          text,
          isError: !!j.is_error,
          durationMs: j.duration_ms,
          costUsd: j.total_cost_usd,
          numTurns: j.num_turns,
        });
        recordTurn(id, j); // A3: agent ledger + daily budget
        // Subscription limit hit → quarantine this account and retry on another.
        if (j.is_error && LIMIT_RE.test(text)) tryAutoSwitch(id, text);
        // Auth token expired/revoked → refresh it and respawn on the same account.
        else if (j.is_error && AUTH_RE.test(text)) tryAuthRecover(id, text);
        // RES1: the model itself is unavailable/overloaded — no account switch
        // can fix that, so go straight down one rung of the model chain.
        else if (j.is_error && MODEL_UNAVAILABLE_RE.test(text)) {
          // No reset time to parse here — an unavailable/overloaded model says
          // nothing about quota. Fall back to cfg.supervisor.modelBackoffMin.
          const stepped = downgradeModel(id, { resetAt: null, why: 'model unavailable' });
          if (stepped.ok) recordIncident(id, 'model-down', { from: stepped.from, to: stepped.model, cause: 'unavailable' }, 'ok', 'model unavailable');
          else if (stepped.reason === 'bottom') recordIncident(id, 'escalate', { after: 'model-ladder', cause: 'unavailable' }, 'escalated', 'model unavailable, bottom rung');
        }
        // Queued prompts: with auto-play on, a finished turn plays the next one.
        if (!j.is_error) scheduleAutoPlay(id);
        // Auto status-summary: fold the just-finished turn into the brief (cheap
        // — only the delta since the last summary). Skips if a run is in flight.
        if (!j.is_error) {
          const cur = getSession(id);
          if (cur?.statusSummary?.autoUpdate && !cur.summarizing) {
            try { summarizeSession(id, { full: false }); } catch (e) { console.error('[summary] auto failed:', e?.message || e); }
          }
        }
      }
      break;
  }
}

// ---- I/O ---------------------------------------------------------------------

// Attachments are saved under ~/.arigami/uploads/<sessionId>/ (outside the
// worktree, so they never show up in git/the Changes tab) and referenced by
// absolute path so the agent can Read them; images are also embedded as image
// blocks so the model sees them immediately.
export const UPLOADS_DIR = path.join(path.dirname(CHAT_DIR), 'uploads');
export const UPLOAD_SPOOL_DIR = path.join(UPLOADS_DIR, '.tmp');

// ZIP: a .zip/.tar/.tar.gz attachment used to leave the model with one opaque
// path — it had to Read (or shell out to unzip) the blob itself before it saw
// what was inside. Detect by magic bytes (never the extension alone), extract
// next to the original file, and write a manifest sidecar so a pre-uploaded
// (streamed) archive and an inline base64 one build the exact same summary.
function extractIfArchive(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const kind = detectArchiveKind(buf);
  if (!kind) return null;
  const destDir = `${file}.d`;
  const base = {
    kind,
    dir: destDir,
    entryCount: 0,
    entriesTotal: 0,
    totalSize: 0,
    truncated: false,
    tree: [],
    rejected: [],
    rejectedCount: 0,
  };
  try {
    const manifest = extractArchive(buf, destDir, kind);
    const info = {
      ...base,
      entryCount: manifest.entryCount,
      entriesTotal: manifest.entriesTotal,
      totalSize: manifest.totalSize,
      truncated: manifest.truncated,
      tree: formatTree(manifest, 40),
      rejected: manifest.rejected.slice(0, 20),
      rejectedCount: manifest.rejectedTotal,
    };
    fs.writeFileSync(`${file}.manifest.json`, JSON.stringify(info));
    return info;
  } catch (e) {
    console.error('[attach] archive extraction failed:', e.message);
    return { ...base, dir: null, error: e.message };
  }
}

function saveAttachments(id, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  const dir = path.join(UPLOADS_DIR, id);
  const out = [];
  for (const a of attachments) {
    if (!a?.name) continue;
    try {
      if (a.dataBase64) {
        fs.mkdirSync(dir, { recursive: true });
        const safe = String(a.name).replace(/[^\w.-]+/g, '_').slice(-90);
        const file = path.join(dir, `${Date.now()}-${safe}`);
        fs.writeFileSync(file, Buffer.from(a.dataBase64, 'base64'));
        const archive = extractIfArchive(file);
        out.push({
          name: a.name,
          path: file,
          type: a.type || '',
          isImage: /^image\//.test(a.type || ''),
          dataBase64: a.dataBase64,
          ...(archive ? { archive } : {}),
        });
      } else if (typeof a.path === 'string') {
        // Pre-uploaded via the streamed endpoint (POST .../attachments) — only
        // trust a path that endpoint itself produced, inside this session's
        // own upload dir; anything else is silently dropped.
        const real = path.resolve(a.path);
        if (real !== dir && !real.startsWith(dir + path.sep)) {
          console.error('[attach] rejected out-of-tree path:', a.path);
          continue;
        }
        if (!fs.existsSync(real)) continue;
        let archive = null;
        const manifestFile = `${real}.manifest.json`;
        if (fs.existsSync(manifestFile)) {
          try {
            archive = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
          } catch { /* ignore a corrupt sidecar — describe the file plainly */ }
        }
        out.push({
          name: a.name,
          path: real,
          type: a.type || '',
          isImage: /^image\//.test(a.type || ''),
          ...(archive ? { archive } : {}),
        });
      }
    } catch (e) {
      console.error('[attach] save failed:', e.message);
    }
  }
  return out;
}

const humanSize = (n) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

/** One list line per attachment — a rich, indented block for archives, a plain path for everything else. */
export function describeAttachment(a) {
  if (!a.archive) return `- ${a.name} → ${a.path}${a.isImage ? ' (image)' : ''}`;
  const ar = a.archive;
  if (ar.error) return `- 📦 ${a.name} → extraction failed: ${ar.error} (original kept at ${a.path})`;
  const countStr = ar.entriesTotal && ar.entriesTotal !== ar.entryCount ? `${ar.entryCount} of ${ar.entriesTotal} entries` : `${ar.entryCount} entries`;
  let block = `- 📦 ${a.name} → extracted to ${ar.dir} (${countStr}, ${humanSize(ar.totalSize)})`;
  if (ar.tree.length) block += `\n  tree:\n` + ar.tree.map((l) => `  ${l}`).join('\n');
  if (ar.rejectedCount) {
    const shown = ar.rejected.slice(0, 10).map((r) => `${r.name} (${r.reason})`).join(', ');
    const extra = ar.rejectedCount > 10 ? `, +${ar.rejectedCount - 10} more` : '';
    block += `\n  ⚠ ${ar.rejectedCount} entr${ar.rejectedCount === 1 ? 'y' : 'ies'} rejected: ${shown}${extra}`;
  }
  if (ar.truncated) block += `\n  (extraction stopped early — the archive exceeded the size/entry-count cap)`;
  return block;
}

/**
 * A raw upload spooled by the streamed endpoint (server/api.ts POST
 * .../attachments) — moved into this session's uploads dir, extracted if it's
 * an archive, and described the same way an inline attachment would be.
 */
export function receiveStreamedAttachment(id, tmpFile, name, type) {
  const dir = path.join(UPLOADS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'file').replace(/[^\w.-]+/g, '_').slice(-90);
  const file = path.join(dir, `${Date.now()}-${safe}`);
  try {
    fs.renameSync(tmpFile, file);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(tmpFile, file);
    fs.rmSync(tmpFile, { force: true });
  }
  const size = fs.statSync(file).size;
  const archive = extractIfArchive(file);
  return {
    name: name || safe,
    path: file,
    type: type || '',
    size,
    isImage: /^image\//.test(type || ''),
    ...(archive ? { archive } : {}),
  };
}

// ZIP2: a chip removed from the composer before sending (retracted drag, or a
// duplicate the dedup guard would otherwise re-spool) still has its bytes
// sitting in this session's uploads dir — same out-of-tree guard as
// saveAttachments() above, so this can only ever delete inside UPLOADS_DIR/<id>/.
export function removeStreamedAttachment(id, filePath) {
  const dir = path.join(UPLOADS_DIR, id);
  const real = path.resolve(String(filePath || ''));
  if (real !== dir && !real.startsWith(dir + path.sep)) return false;
  let removed = false;
  for (const p of [real, `${real}.d`, `${real}.manifest.json`]) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        removed = true;
      }
    } catch (e) {
      console.error('[attach] remove failed:', e.message);
    }
  }
  return removed;
}

// Memory M1.3: inject the USER.md+MEMORY.md snapshot into a session's very
// first turn only (fresh claude session, nothing sent yet on this proc) — never
// mid-conversation, so the prompt-cache prefix stays stable. A --resume proc
// already has this in its history from the original spawn.
// A3: how to SHOW things to the human. Sessions are reached from laptops,
// phones and tailnets alike — a `http://localhost:…` link only works on the
// host box. Goes in the first turn only (same prompt-cache reasoning as memory).
export const URL_GUIDANCE =
  '<system-reminder>\n' +
  'Arigami links: to show the human anything, call publish_artifact (static file/dir → /__artifacts/<id>/) or ' +
  'open_tab (a LIVE dev server — pass http://localhost:$PORT, the host proxies it into a cockpit tab). ' +
  'Never write http://localhost:… URLs in replies, reports, pushes or messages: the human may be on a phone or ' +
  'another machine. The host returns host-RELATIVE paths (/__host/?session=…, /__artifacts/…) — pass them on as-is. ' +
  '$ARIGAMI_URL is an internal base for your own API calls only, not a link for people. ' +
  'Need a port for a dev server? call allocate_port (or set_metadata({patch:{needs_server:true}})) and use $PORT / the returned port.\n' +
  '</system-reminder>\n\n';

// F8: who the agent is and what it can do — so the first answer introduces
// Arigami (browser, WhatsApp, mail, sessions, triggers…) in the human's
// language instead of "I am Claude, I write code". The connectable list is
// probed at spawn (capabilitiesHint) and names the capabilities that are NOT
// connected yet, so the agent knows they exist and asks (request_setup)
// rather than answering "I have no access to WhatsApp".
export function identityReminder(hint) {
  return (
    '<system-reminder>\n' +
    'You are the agent inside Arigami — the human\'s self-hosted cockpit (this session is one of its sessions). ' +
    'Introduce yourself as Arigami\'s agent, not by the name of the CLI/model behind you ("Claude", "Codex"); ' +
    'answer in the language the human writes in. ' +
    'What you can do here: browse and screenshot websites on this session\'s own desktop (open the browser, capture_screen, publish_artifact); ' +
    'read and send WhatsApp (the `whatsapp` tool); read mail/calendar/drive and other providers through Composio once connected; ' +
    'work on git repos (clone into the workspace, worktrees, review, merge); spawn child sessions for parallel work; ' +
    'react to triggers (WhatsApp/Slack/Linear/webhooks/cron) via register_listener; keep a memory across sessions; ' +
    'and hand the desktop over to the human (request_screen) for logins. ' +
    'When the human greets you or asks what you can do, give a short, concrete menu of these (3 suggested actions), in their language.\n' +
    (hint ? `\n${hint}\n` : '') +
    // EXT: the third channel by which a session learns an extension exists
    // ("that there is") — the skill description says WHEN, the tool schemas say
    // HOW. Empty string when nothing is installed, so nothing changes.
    (extSummary() ? `\n${extSummary()}\n` : '') +
    '</system-reminder>\n\n'
  );
}

function extSummary() {
  try {
    return extensions.summaryLine();
  } catch {
    return '';
  }
}

// The "connectable" line is probed in the background (capability checks are
// async — Composio, files, processes) and cached, so the first user message
// — often written in the same tick as the spawn — never waits on it.
// A2: cached PER OWNER — a session born from an agent sees the agent's own
// connections (identity / composio resolved agent-first, "(shared)" when it
// fell back). The global line refreshes every minute; an agent's line is
// refreshed in the background whenever one of its sessions spawns.
const capabilitiesHintCache = new Map(); // owner → {connected, missing}
let capabilitiesHintCacheGlobal = null;
/** The line for one engine: `claude` and `codex` are engine logins, so a session only sees its own. */
function formatCapabilitiesHint(owner, entry, engine = 'claude') {
  if (!entry) return '';
  const other = engine === 'codex' ? 'claude' : 'codex';
  const connected = entry.connected.filter((id) => id !== other);
  const missing = entry.missing.filter((id) => id !== other);
  return (
    (connected.length ? `Connected now${owner !== 'global' ? ` for ${owner}` : ''}: ${connected.join(', ')}. ` : '') +
    (missing.length
      ? `Capabilities available to connect just-in-time (a tool returns {needs_setup} → call request_setup({capability, why}); the human gets a card in the chat): ${missing.join(', ')}.`
      : '')
  );
}
export async function refreshCapabilitiesHint(owner = 'global', engine = 'claude') {
  try {
    const caps = await import('./capabilities.js');
    const { capabilities } = await caps.capabilitiesStatus({}, owner);
    const missing = capabilities.filter((c) => !c.ok && c.id !== 'telemetry' && c.id !== 'push' && c.id !== 'remote').map((c) => c.id);
    const connected = capabilities.filter((c) => c.ok).map((c) => (c.ownable && owner !== 'global' && c.resolvedFrom === 'global' ? `${c.id} (shared)` : c.id));
    capabilitiesHintCache.set(owner, { connected, missing });
    if (owner === 'global') capabilitiesHintCacheGlobal = { connected, missing };
  } catch (e) {
    console.error('[claude] capabilities hint:', e.message);
  }
  return formatCapabilitiesHint(owner, capabilitiesHintCache.get(owner), engine);
}
/** The first-turn line for an owner — the agent's own if probed already, else the global one. */
export const capabilitiesHint = (owner = 'global', engine = 'claude') =>
  capabilitiesHintCache.has(owner) ? formatCapabilitiesHint(owner, capabilitiesHintCache.get(owner), engine) : formatCapabilitiesHint('global', capabilitiesHintCacheGlobal, engine);
refreshCapabilitiesHint().catch(() => {});
{
  const t = setInterval(() => refreshCapabilitiesHint().catch(() => {}), 60_000);
  if (t.unref) t.unref();
}

function memoryBootstrapPrefix(p) {
  const identity = identityReminder(p?.capabilitiesHint || '');
  // A1: a session born from an agent gets the agent's persona block and boots
  // with USER.md + the AGENT's MEMORY.md (its namespace), not the shared one.
  const persona = p?.agent ? personaBlock(p.agent) : '';
  const { userMd, memoryMd, agentMd } = getMemoryBootstrap(p?.agent || null);
  if (!userMd.trim() && !memoryMd.trim() && !(agentMd || '').trim()) return URL_GUIDANCE + identity + persona;
  let block = "<system-reminder>\nArigami memory snapshot (owned by the host — this instance's own memory, not your agent CLI's own per-project memory). Frozen at session start; call memory_search for anything not shown here.\n";
  if (userMd.trim()) block += `\n## USER.md\n${userMd.trim()}\n`;
  if (memoryMd.trim()) block += `\n## MEMORY.md\n${memoryMd.trim()}\n`;
  if ((agentMd || '').trim()) block += `\n## MEMORY.md (agent ${p.agent})\n${agentMd.trim()}\n`;
  block += '</system-reminder>\n\n';
  return URL_GUIDANCE + identity + persona + block;
}

// SIMPLE1: the "Simple" chat view. While a session is in Simple mode the human
// only sees the assistant's prose (tool activity is folded behind a counter),
// so the model has to actually answer like a person: a line or two. USER.md
// carries the same preference globally; this is the hard per-session rule.
// Re-read from session metadata on EVERY turn (not the spawn-time snapshot) so
// flipping the toggle takes effect on the next message without a restart.
export const SIMPLE_MODE_REMINDER =
  '<system-reminder>\n' +
  'Simple chat mode is ON for this session: the human switched the cockpit to the "Simple" view, where only ' +
  'your prose reaches them — tool calls, edits, bash output and thinking are folded away behind a counter. ' +
  'Hard rule for what you write to the human in this chat: at most two sentences by default — the outcome and the one ' +
  'thing that matters. Details only when asked. No headers, tables, bullet lists, code dumps or step-by-step narration ' +
  'of what you did. Bad news is said first and plainly. This is a per-session rule and overrides longer-form formatting ' +
  'guidance from anywhere else. It limits only what you write to the human — not your tool use or the work itself.\n' +
  '</system-reminder>\n\n';

export function chatModePrefix(metadata) {
  return metadata && metadata.chatMode === 'simple' ? SIMPLE_MODE_REMINDER : '';
}

// Engine-agnostic turn-text assembly (persona/memory bootstrap, LADDER1 preamble, Simple-mode reminder), run once before the engine's own writeMessage().
// Exported: server/codex.ts calls it too — the text is composed once, engine-agnostically, and only then encoded into each CLI's wire format.
export function composeTurnText(p, text) {
  let txt = text || '';
  if (!p.resume && !p.sent.length) txt = memoryBootstrapPrefix(p) + txt;
  // LADDER1: one-shot preamble in front of the next message only, never persisted in the chat log.
  if (p.preamble) {
    txt = p.preamble + txt;
    p.preamble = '';
  }
  txt = chatModePrefix(getSession(p.id)?.metadata) + txt;
  return txt;
}

// engine-driver.ts's writeMessage() for claude — text is already composed; this just encodes attachments + the stdin envelope.
function writeUserMessage(p, { text, attachments = [] }) {
  const content = [];
  let txt = text || '';
  if (attachments.length) {
    const list = attachments.map(describeAttachment).join('\n');
    txt += (txt ? '\n\n' : '') + `📎 Attached ${attachments.length} file(s) — read them as needed:\n${list}`;
  }
  if (txt) content.push({ type: 'text', text: txt });
  for (const a of attachments) {
    if (a.isImage && a.dataBase64) content.push({ type: 'image', source: { type: 'base64', media_type: a.type, data: a.dataBase64 } });
  }
  if (!content.length) content.push({ type: 'text', text: '(empty message)' });
  p.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
}

// engine-driver.ts's handshake() for claude — the eager `initialize` control
// request. The cockpit can show commands/agents/models the moment the proc is
// up (the `init` system event, which carries mcp/tools/skills, only fires on
// the first turn), and its `control_response` reply is also the "proc is up"
// signal restart() waits on. Costs no turn.
function claudeHandshake(p) {
  p.child.stdin.write(
    JSON.stringify({ type: 'control_request', request_id: `req_${++reqSeq}`, request: { subtype: 'initialize' } }) + '\n'
  );
}

// engine-driver.ts's interrupt() for claude — Esc, as a control request. The
// SIGINT fallback stays for a stdin that is already gone.
function claudeInterrupt(p) {
  try {
    p.child.stdin.write(
      JSON.stringify({ type: 'control_request', request_id: `req_${++reqSeq}`, request: { subtype: 'interrupt' } }) + '\n'
    );
  } catch {
    try { p.child.kill('SIGINT'); } catch {}
  }
}

/**
 * A5 (#5) — the daily cap has to STOP spend, not only gate new sessions: a spent
 * agent kept running because messages kept landing in its existing chat. After the
 * one final warning every further turn is refused with the same 429 line, until
 * local midnight. `system:true` (the warning itself, host notices) bypasses it.
 */
export function budgetRefusalFor(id) {
  const slug = getSession(id)?.metadata?.agent;
  if (typeof slug !== 'string' || !slug) return null;
  const st = turnBlocked(slug);
  if (!st) return null;
  const name = getAgent(slug)?.name || slug;
  const err = new Error(budgetRefusal(st, name));
  err.status = 429;
  err.budget = { ...st, name };
  return err;
}

export function sendMessage(id, text, attachments = [], { system = false } = {}) {
  if (!system) {
    const refusal = budgetRefusalFor(id);
    if (refusal) throw refusal;
  }
  const p = ensureRunning(id); // respawns with --resume after an exit
  const saved = saveAttachments(id, attachments);
  appendChat(id, {
    kind: 'user',
    text,
    ...(saved.length
      ? {
          attachments: saved.map((a) => ({
            name: a.name,
            isImage: a.isImage,
            ...(a.archive
              ? {
                  archive: {
                    kind: a.archive.kind,
                    entryCount: a.archive.entryCount,
                    entriesTotal: a.archive.entriesTotal,
                    rejectedCount: a.archive.rejectedCount,
                    rejected: a.archive.rejected,
                    error: a.archive.error,
                    dir: a.archive.dir,
                  },
                }
              : {}),
          })),
        }
      : {}),
  });
  setClaude(id, { state: 'working' });
  pickEngine(getSession(id)).writeMessage(p, { text: composeTurnText(p, text), attachments: saved });
  p.sent.push(text);
  return true;
}

// CHAT1: the old answerToolResult (a tool_result written onto stdin for an
// AskUserQuestion) is gone — while the tool waits on the permission prompt the
// CLI reads any stdin user message as a new turn, cancels the pending tool and
// drops the answer. The card is answered through the permission result now
// (server/api.ts answerQuestion), or as a plain message when nothing is pending.

// ---- pending prompts (queued while busy) -------------------------------------
// Playing a queued prompt wraps it so the agent KNOWS it was queued — sometimes
// the conversation is mid-question and blindly starting new work is wrong, so
// the wrapper explicitly delegates that judgment to the agent.
function playWrapper(text, remaining, auto, interrupted = false) {
  const head = auto
    ? '[Queued prompt — auto-played now that your previous turn finished]'
    : interrupted
      ? '[Queued prompt — the user chose to start it NOW, so your in-flight turn was interrupted to make room. Briefly note anything the interrupted work left unfinished, then do this.]'
      : '[Queued prompt — the user chose to start it now]';
  const tail = [
    remaining > 0
      ? `\n\n(${remaining} more queued prompt${remaining > 1 ? 's' : ''} are waiting after this one.)`
      : '',
    auto
      ? '\n\nIf the conversation state makes starting this unwise right now — e.g. you just asked the user a question and are waiting for their answer — reply briefly that you are deferring it and why, instead of starting.'
      : '',
  ].join('');
  return `${head}\n\n${text}${tail}`;
}

// Dequeue + send one pending prompt. `promptId` omitted → the first in line.
export function playPendingPrompt(id, promptId, { auto = false } = {}) {
  const s = getSession(id);
  if (!s) return false;
  const list = s.pendingPrompts || [];
  const target = promptId ? list.find((p) => p.id === promptId) : list[0];
  if (!target) return false;
  removePendingPrompt(id, target.id);
  const remaining = (getSession(id)?.pendingPrompts || []).length;
  // Forcing play mid-turn must actually start NOW: a user message written while
  // the CLI is busy is queued until the current turn ends — it shows up in the
  // chat but the agent keeps working the previous task. Interrupt first, give
  // the CLI a beat to cancel, then send. (Auto-play only fires when idle.)
  if (!auto && s.claude?.state === 'working' && isRunning(id)) {
    interrupt(id);
    const t = setTimeout(() => {
      try {
        sendMessage(id, playWrapper(target.text, remaining, auto, true));
      } catch (e) {
        console.error('[prompts] forced play failed:', e?.message || e);
      }
    }, 400);
    if (t.unref) t.unref();
    return true;
  }
  sendMessage(id, playWrapper(target.text, remaining, auto));
  return true;
}

// How long to wait before an auto-play actually fires: the user may type
// something new in that window, and a turn-end is immediately followed by other
// state churn. Long enough to settle, short enough that the queue feels live.
const AUTOPLAY_SETTLE_MS = 800;

// What a fired settle timer does. Indirected so tests can exercise the queue
// logic (guards + timing) without spawning a claude process.
let autoPlayer = (id) => playPendingPrompt(id, null, { auto: true });
export function __setAutoPlayer(fn) {
  autoPlayer = fn || ((id) => playPendingPrompt(id, null, { auto: true }));
}

// Auto-play the next queued prompt — but only when it's REASONABLE: autoPlay on,
// session still idle after the settle delay (the user may have typed something
// new meanwhile), and nothing waiting on a human (pending permission request or
// a sticky action bar). state.autoPlayHold() owns that rule; the same answer is
// what the cockpit shows next to the switch.
//
// A turn-end is NOT the only moment a queue can start moving — a prompt added to
// an already-idle session, the switch flipped on while idle, an answered action
// card, or a host restart with a queue on disk are all "kicks" too. Every one of
// them calls kickAutoPlay(); before that, only the turn-end did, which is why a
// queue could sit there forever on a session that wasn't working (the bug).
export function kickAutoPlay(id) {
  scheduleAutoPlay(id);
}

// Boot: sessions come back from state.json as idle, and a queue that was waiting
// for a turn that will now never end would otherwise never move.
export function kickAutoPlayAll() {
  let n = 0;
  for (const s of listSessions({ archived: false })) {
    if (s.promptAutoPlay && (s.pendingPrompts || []).length) {
      kickAutoPlay(s.id);
      n++;
    }
  }
  return n;
}

function scheduleAutoPlay(id) {
  const s = getSession(id);
  if (!s?.promptAutoPlay || !(s.pendingPrompts || []).length) return;
  const t = setTimeout(() => {
    try {
      const cur = getSession(id);
      if (!cur?.promptAutoPlay || !(cur.pendingPrompts || []).length) return;
      // Held: not idle (a new turn started, or a permission request flipped the
      // state to 'awaiting-input'), or a sticky action bar awaits a human.
      if (autoPlayHold(cur)) return;
      autoPlayer(id);
    } catch (e) {
      console.error('[prompts] auto-play failed:', e?.message || e);
    }
  }, AUTOPLAY_SETTLE_MS);
  if (t.unref) t.unref();
}

// Independent, read-only one-shot runs (explain / auto-review / summary) on the
// SESSION's engine. They do NOT touch the session's conversation or its main
// proc — a throwaway one-shot in the session's worktree with ARIGAMI_SESSION_ID
// set, so the MCP tools write results straight to that session's Changes tab.
// Fire-and-forget.
function runHeadless(s, prompt, onExit, { effort } = {}) {
  const engine = sessionEngine(s);
  const env = {
    ARIGAMI_SESSION_ID: s.id, // MCP tools target THIS session's Changes tab
    // Ownership markers (session-procs.ts): every process this session starts
    // inherits them, detached or not, so deleting the session can find it.
    ARIGAMI_HOST_ID: HOST_MARK,
    ...scratch.envFor(s.id), // TMPDIR → ~/.arigami/scratch/<id>, removed with the session
    ARIGAMI_URL: cfg.hostBase, // internal host→self base only
    ARIGAMI_PUBLIC_PATH: '/__host/',
    ARIGAMI_TOKEN: auth.tokenForSession(s.id),
    ARIGAMI_SKILLS: path.join(ROOT, 'skills'),
    ARIGAMI_USER_SKILLS: USER_SKILLS_DIR,
  };
  runOneShot(prompt, {
    engine,
    account: s.claude?.accountId || null,
    cwd: untildify(s.metadata?.worktree || s.cwd) || HOME,
    tag: 'headless',
    timeoutMs: 5 * 60 * 1000,
    effort,
    env,
    // ONLY the arigami MCP — skip the user's global servers (fast, focused); codex MCP children need the identity explicitly
    mcpServers: engine === 'codex' ? { arigami: { ...HOST_SERVERS.arigami, env } } : HOST_SERVERS,
    pluginDirs: [ROOT, userPluginDir()], // host skill pack + user/bundle skills
  }).then(
    () => { try { onExit?.(0); } catch {} },
    (e) => { console.error(`[headless] ${engine} failed:`, e?.message || e); try { onExit?.(1); } catch {} }
  );
}

// Shell snippet that reads the right diff for the mode. PR = working tree vs the
// merge-base with the default branch; work = working tree vs the merge-base with
// the session's stamped metadata.base (a LOCAL ref — never origin/<base>, which
// may be behind); uncommitted = working tree vs HEAD.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const diffCmds = (mode, base) =>
  mode === 'pr'
    ? 'BASE=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD origin/master 2>/dev/null || echo HEAD); ' +
      'git diff --stat "$BASE"; git diff "$BASE"; git ls-files --others --exclude-standard'
    : mode === 'work' && base
      ? `BASE=$(git merge-base HEAD ${shq(base)} 2>/dev/null || echo HEAD); ` +
        'git diff --stat "$BASE"; git diff "$BASE"; git ls-files --others --exclude-standard'
      : 'git status --porcelain=v1; git diff HEAD; git ls-files --others --exclude-standard';

// Explain the session's changes in the Changes tab — an independent, read-only
// one-shot run. Self-contained prompt (does not depend on discovering a plugin
// skill) that REQUIRES the MCP write as its only deliverable. mode: 'uncommitted'|'pr'|'work'.
export function explainChanges(id, mode) {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  const base = mode === 'work' ? s.metadata?.base || null : null;
  const baseNote =
    mode === 'pr'
      ? 'Pass base="<the BASE ref/sha you diffed against>" and mode="pr" so the tab opens on the PR comparison.'
      : mode === 'work'
        ? `Pass base=${JSON.stringify(base || '<this branch\'s base>')} and mode="work" so the tab opens on this session's own-work comparison.`
        : 'Use base="HEAD" (uncommitted changes) and mode="uncommitted".';
  setChangesExplaining(id, mode); // live "explaining…" state for the Changes tab
  // Safety net: clear the running flag even if the proc is killed/hangs.
  const clear = () => setChangesExplaining(id, null);
  const guard = setTimeout(clear, 5 * 60 * 1000);
  runHeadless(
    s,
    `Explain this git worktree's changes for the host "Changes" tab. Work in the current directory. READ-ONLY — never modify, stage, commit, or push.\n\n` +
      `1. Read the changes by running:\n   ${diffCmds(mode, base)}\n   Open untracked/new files to see what they add.\n` +
      `2. For each changed file, write 1–3 sentences: what changed and why.\n` +
      `3. Group related files into cross-file "features" (title, summary, the files it touches, optional details).\n` +
      `4. You MUST finish by calling the tool mcp__arigami__set_changes_explanation with arguments ` +
      `{ language: "<the language the user converses in, e.g. \\"English\\" or \\"Hebrew\\">", base, mode, files: [{path, summary}], features: [{title, summary, files, details}] }. ${baseNote}\n` +
      `This tool call is the ONLY deliverable — the explanation does not exist until it succeeds. If the diff is empty, call it with empty files and features, then stop.`,
    () => { clearTimeout(guard); clear(); }
  );
  return { ok: true, mode };
}

// Auto-review the session's changes — independent read-only run that posts
// findings as suggested review comments to the Changes tab. mode mirrors above.
export function reviewChanges(id, mode) {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  const base = mode === 'work' ? s.metadata?.base || null : null;
  setAutoReviewing(id, mode); // live "reviewing…" state for the Changes tab
  const clear = () => setAutoReviewing(id, null);
  const guard = setTimeout(clear, 5 * 60 * 1000);
  runHeadless(
    s,
    `Review this git worktree's changes as a careful senior engineer. Work in the current directory. READ-ONLY — never modify, stage, commit, or push.\n\n` +
      `1. Read the changes by running:\n   ${diffCmds(mode, base)}\n` +
      `2. Find real problems only: bugs, edge cases, regressions, security/perf issues. Skip style nits.\n` +
      `3. You MUST finish by POSTing your findings (this is the ONLY deliverable). For each finding give the file path and, when it maps to a specific changed line, the NEW-file line number so it can attach inline:\n` +
      `   curl -s -X POST "$ARIGAMI_URL/__api/sessions/$ARIGAMI_SESSION_ID/review/suggestions" -H "Authorization: Bearer $ARIGAMI_TOKEN" -H 'content-type: application/json' -d '{"comments":[{"path":"<file>","line":<new-file line number, optional>,"body":"<the issue + a concrete suggested fix>"}]}'\n` +
      `Include one object per finding. If the changes look clean, POST a single comment with the worst-case path saying they look good. Do not skip the curl.`,
    () => { clearTimeout(guard); clear(); },
    { effort: 'medium' }
  );
  return { ok: true, mode };
}

// Render a cheap, readable transcript slice for the summarizer: user prompts +
// assistant prose only (tool calls/results/thinking dropped — they're noise for
// a status brief and the token cost we're trying to avoid). Bounded, and only
// events after `sinceSeq` so a fold reads just the delta. Returns the text plus
// the last seq it covered (the next fold cursor).
function renderTranscript(id, sinceSeq = 0, maxChars = 24000) {
  const evs = getChat(id, sinceSeq);
  const lines = [];
  let lastSeq = sinceSeq;
  for (const e of evs) {
    lastSeq = e.seq ?? lastSeq;
    const t = (e.text || '').trim();
    if (!t) continue;
    if (e.kind === 'user') lines.push(`USER: ${t}`);
    else if (e.kind === 'assistant-text' || e.kind === 'assistant') lines.push(`ASSISTANT: ${t}`);
  }
  let text = lines.join('\n\n');
  if (text.length > maxChars) text = '…(earlier trimmed)…\n\n' + text.slice(-maxChars);
  return { text, lastSeq, count: evs.length };
}

// Manually-enabled status summary. A cheap headless run reads ONLY the transcript
// delta since the last summary (or the whole thing on first run / full refresh),
// folds it into the previous brief, and delivers via set_status_summary. Cost is
// bounded by the delta, not the conversation length. full=true forces a fresh
// read of the entire transcript.
export function summarizeSession(id, { full = false } = {}) {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  if (s.summarizing) return { ok: true, skipped: 'in-flight' };
  const prev = s.statusSummary;
  const sinceSeq = full || !prev ? 0 : prev.atSeq || 0;
  const { text: transcript, lastSeq, count } = renderTranscript(id, sinceSeq);
  // Nothing new to fold — leave the existing summary as-is.
  if (!full && prev && count === 0) return { ok: true, skipped: 'no-delta' };

  setSummarizing(id, true);
  const clear = () => setSummarizing(id, false);
  const guard = setTimeout(clear, 4 * 60 * 1000);

  const foldNote =
    prev && !full
      ? `You are UPDATING an existing status brief. Here it is:\n\n<<<PREVIOUS SUMMARY\n${prev.text}\nPREVIOUS SUMMARY>>>\n\nBelow is ONLY what happened since. Fold it in — keep what still holds, revise what changed, drop what's resolved. Do not re-derive the whole history.\n\n`
      : '';
  // Language preference: 'en' forces English; 'auto' (default) follows the
  // conversation and keeps a non-English summary in-script (minimal Latin).
  const langLine =
    s.statusSummary?.lang === 'en'
      ? `Write the ENTIRE summary (and the tldr) in English, regardless of the conversation's language. `
      : s.statusSummary?.lang === 'he'
      ? `Write the ENTIRE summary (and the tldr) in Hebrew, in Hebrew SCRIPT, regardless of the conversation's language — Latin script ONLY for exact identifiers that must be copied verbatim (ticket & PR numbers, file/branch names, code symbols, URLs). `
      : `Write in the language the conversation is in, and CRITICALLY in that language's SCRIPT. If it is not English (e.g. Hebrew), Latin-script words break the ` +
        `right-to-left flow and become unreadable — so write EVERYTHING in Hebrew letters: use a real Hebrew word for ordinary dev terms (review→סקירה, reviewer→מבקר, listener→מאזין, ` +
        `merge→מיזוג, tests→בדיקות, bug→באג, CI→בדיקות אוטומטיות, approval→אישור), and for a loan word with no natural translation, TRANSLITERATE it into Hebrew letters rather than leaving it in Latin. ` +
        `Keep Latin script ONLY for exact identifiers that must be copied verbatim: ticket & PR numbers (ENG-321, PR #442), file/branch names, code symbols, and URLs. Nothing else in Latin. `;
  const prompt =
    `You are writing a concise STATUS BRIEF of a coding session for its operator, so they can re-orient at a glance. ` +
    langLine +
    `Do NOT run any tools except the final delivery tool. READ-ONLY.\n\n` +
    foldNote +
    `<<<TRANSCRIPT\n${transcript || '(no conversation yet)'}\nTRANSCRIPT>>>\n\n` +
    `Produce a short brief (a few lines, not a wall of text) covering: the task, what's been done so far, the current state (PRs / reviews / blockers / what's waiting), and a final line **"What now?"** with the concrete next action (which may be "nothing — waiting for X"). ` +
    `ALSO produce a "tldr": a 2–3 line ultra-condensed version of the brief (plain text, no markdown) for a hover tooltip — the task + where it stands + the next action, nothing more. ` +
    `Finish by calling the tool mcp__arigami__set_status_summary with { text: "<the brief as markdown>", tldr: "<the 2–3 line plain-text summary>", at_seq: ${lastSeq} }. ` +
    `That tool call is the ONLY deliverable — the summary does not exist until it succeeds.`;

  runHeadless(s, prompt, () => { clearTimeout(guard); clear(); });
  return { ok: true, full, sinceSeq };
}

// ---- inbox enrichment --------------------------------------------------------
//
// One headless run per session that reads the pending inbox items and drafts,
// for each: what the person is actually saying, whether they are right, what to
// change, and the exact text of a reply.
//
// READ-ONLY by construction, and said three ways in the prompt, because this is
// the one place the agent reads other people's messages and could plausibly
// conclude that answering them is the job. It drafts; the operator submits.
//
// Engine-agnostic: runHeadless() resolves the session's engine, so Codex and
// Claude get the same prompt through their own drivers.
const enrichRuns = new Set();

export function enrichInbox(id, { force = false } = {}) {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  if (enrichRuns.has(id)) return { ok: true, skipped: 'in-flight' };
  // `signal` is the gate: CI notices and "LGTM" are not worth a model run and
  // render raw, with an "explain it" button that passes force.
  const todo = listInbox(id).filter((i) => !i.settled && !i.enrichment && (force || i.signal));
  if (!todo.length) return { ok: true, skipped: 'nothing-to-do' };

  for (const i of todo) patchInboxItem(id, i.id, { enriching: true });
  enrichRuns.add(id);
  const clear = () => {
    enrichRuns.delete(id);
    for (const i of todo) {
      const cur = listInbox(id).find((x) => x.id === i.id);
      if (cur?.enriching) patchInboxItem(id, i.id, { enriching: false });
    }
  };
  // A run that dies without calling back would leave every item spinning
  // forever; five minutes matches the one-shot ceiling elsewhere.
  const guard = setTimeout(clear, 5 * 60 * 1000);

  const rendered = todo
    .map((i, n) => {
      const c = i.context || {};
      const ctx =
        c.kind === 'code'
          ? `\nCODE IT POINTS AT (${c.path}${c.lines ? ` ${c.lines}` : ''}):\n${c.hunk}`
          : c.kind === 'text'
            ? `\nTEXT IT POINTS AT:\n${c.body}`
            : c.kind === 'thread'
              ? `\nTHREAD:\n${(c.messages || []).map((m) => `${m.author}: ${m.text}`).join('\n')}`
              : '';
      return `### ITEM ${n + 1} · id=${i.id}\nFROM: ${i.source.author} on ${i.source.provider} (${i.source.kind})\nSAID:\n${i.body}${ctx}`;
    })
    .join('\n\n');

  runHeadless(
    s,
    `${todo.length} message(s) came in from people about this work. For each one, explain it to the operator and draft what to do. READ-ONLY: read whatever code you need to judge the comment, but do NOT edit files, commit, push, or reply to anyone anywhere. You have no permission to contact a human — the operator reviews your drafts and sends them.\n\n` +
      `${rendered}\n\n` +
      `For EACH item produce:\n` +
      `- "explanation": what the person is actually saying and whether they are right, in 1-2 sentences. Write it to the OPERATOR, not to the commenter. Plain, direct, no bullet points, no preamble, no flattery. Check the code before agreeing or disagreeing.\n` +
      `- "fix": if code should change, one or two sentences saying what - otherwise null.\n` +
      `- "reply": the exact text to send back, if a reply is warranted - otherwise null. One or two sentences, the way a person types to a colleague. No emojis, no "thanks for the review", no restating their comment back at them. If you disagree, say so plainly and briefly.\n` +
      `- "reply_dir": "ltr" or "rtl" for that reply's script.\n` +
      `- "explanation_dir": same, for the explanation.\n\n` +
      `LANGUAGE: choose per item. Anything that lands in GitHub or Linear is English. A private Slack message follows the language of that conversation. The explanation follows the language the operator converses in. Nothing here is fixed - you decide from context.\n\n` +
      `Deliver by POSTing (this is the ONLY deliverable):\n` +
      `curl -s -X POST "$ARIGAMI_URL/__api/sessions/$ARIGAMI_SESSION_ID/inbox/enrich" -H "Authorization: Bearer $ARIGAMI_TOKEN" -H 'content-type: application/json' -d '{"items":[{"id":"<item id>","explanation":"...","explanation_dir":"ltr","fix":null,"reply":"...","reply_dir":"ltr"}]}'\n` +
      `One object per item, using the exact ids above. Do not skip the curl.`,
    () => { clearTimeout(guard); clear(); }
  );
  return { ok: true, count: todo.length };
}

// stream-json interrupt (SIGINT-equivalent): control_request over stdin
export function interrupt(id) {
  const p = record(id);
  if (!isRunning(id)) return false;
  p.interruptedAt = Date.now(); // B34: the next error_during_execution result is this stop, not a failure
  // How you stop a turn is the engine's own protocol — claude has a real
  // `control_request/interrupt` on stdin, codex `exec` has only a signal (its
  // stdin is already at EOF while the turn runs, so a write there is a silent
  // no-op, not a fallback). See EngineDriver.interrupt.
  try { pickEngine(getSession(id)).interrupt?.(p); } catch {}
  // Reflect the stop immediately — the user asked to stop, so drop the 'working'
  // badge now instead of relying on a trailing `result` that may not arrive on
  // an interrupt. A `result` that does land just re-sets idle (no-op).
  setClaude(id, { state: 'idle' });
  return true;
}

// Cleanup that must happen whenever a session's proc stops. Called from the
// child 'close' handler for natural exits, and directly from kill()/restartWith()
// for deliberate stops — because those delete the proc record BEFORE the child's
// close event fires, so the close handler's `record(id).child !== child` guard
// short-circuits and this cleanup would otherwise never run (leaving stale
// Allow/Deny cards live for 10 minutes and bg shells shown as running).
function reapSessionOnExit(id, reason) {
  expirePendingPermissions(id, reason);
  expirePendingScreenRequests(id, reason);
  detachPendingSetupRequests(id, reason); // F6: cards stay open across a restart
  const sess = getSession(id);
  if (sess && (sess.bg || []).some((b) => b.status === 'running')) {
    setBg(id, sess.bg.map((b) => (b.status === 'running' ? { ...b, status: 'exited', endedAt: Date.now() } : b)));
  }
}

// Stop a claude child AND everything it spawned. A bare child.kill() is a
// decapitation on Windows: TerminateProcess takes claude.exe and leaves its MCP
// servers running — orphaned, out of reach of taskkill /T (which only walks live
// parent links), and still holding the listen socket they inherited from us.
function stopChild(child) {
  if (child) killTree(child.pid);
}

export function kill(id) {
  const p = record(id);
  if (!p) return false;
  p.expectKill = true;
  try { p.child.stdin.end(); } catch {}
  stopChild(p.child);
  procs.delete(id);
  reapSessionOnExit(id, 'session stopped');
  setClaude(id, { state: 'idle' });
  return true;
}

// Apply a spawn-time setting (permission mode / model) to a session and make it
// take effect NOW: persist it, then if a proc is live, stop it cleanly and
// respawn with --resume so the SAME conversation continues under the new setting.
// With no live proc (or no sessionId yet) the change just lands on the next spawn.
function restartWith(id, patch) {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  setClaude(id, patch);
  if (isRunning(id)) {
    const p = record(id);
    if (p) {
      p.expectKill = true; // don't surface this stop as an error / dead state
      try { p.child.stdin.end(); } catch {}
      stopChild(p.child);
      procs.delete(id);
      // The old proc's pending permission requests can't be answered anymore;
      // deny them now so they don't linger against the soon-to-be-new proc.
      reapSessionOnExit(id, 'session restarted');
    }
    const fresh = getSession(id);
    spawnProc(fresh, !!fresh.claude?.sessionId); // --resume if we have a session id
    // The restart aborted whatever turn was running; the resumed proc has no
    // turn in flight. Reset to idle so a mid-turn model/account switch doesn't
    // leave a stale 'working' badge. (Auto-switch re-sends its message right
    // after, which flips it back to 'working'.)
    setClaude(id, { state: 'idle' });
  }
  return getSession(id)?.claude;
}

export function setPermissionMode(id, mode) {
  // Codex app-server sends approvalPolicy per turn — no respawn.
  if (isCodexAppSession(id)) { setClaude(id, { permissionMode: mode }); mergeCaps(id, { permissionMode: mode }); return getSession(id)?.claude; }
  return restartWith(id, { permissionMode: mode });
}

// `model` is a `claude --model` value — an alias ('opus'|'sonnet'|'haiku') or a
// full model id. '' or 'default' clears it back to the Claude Code default
// (no --model flag). Stored as `modelChoice` so it persists across respawns; the
// reported `model` field reflects what the running session actually resolved to.
export function setModel(id, model, { chain } = {}) {
  const choice = !model || model === 'default' ? null : String(model);
  // RES1: an explicit pick is the new TOP rung — reset the ladder so a session
  // the supervisor had downgraded doesn't climb back over the human's choice.
  return restartWith(id, {
    modelChoice: choice,
    modelRung: 0,
    modelRestoreAt: null,
    modelDowngradedFrom: null,
    ...(chain !== undefined ? { modelChain: Array.isArray(chain) && chain.length ? chain.map(String) : null } : {}),
  });
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// `effort` maps 1:1 to `claude --effort <level>`. '' or 'default' clears it
// back to the CLI's own default (no --effort flag).
export function setEffort(id, effort) {
  const level = !effort || effort === 'default' ? null : String(effort);
  const s = getSession(id);
  const allowed = s ? pickEngine(s).effortLevels(s) : EFFORT_LEVELS;
  if (level && !allowed.includes(level))
    throw new Error(`invalid effort level for ${s?.claude?.modelChoice || s?.engine || 'claude'}: ${level} (allowed: ${allowed.join(', ')})`);
  return restartWith(id, { effort: level });
}

// Auto-compact threshold as a % of the session's current model context window,
// applied as a real `claude --autocompact <tokens>` spawn flag (not a message
// injected into the conversation, which the CLI may or may not treat as a real
// slash command over stream-json stdin). null/0 disables it.
export function setAutoCompact(id, pct) {
  if (isCodexSession(id) && !isCodexAppSession(id)) throw new Error('auto-compact is not available on codex exec sessions');
  const p = pct == null ? null : Math.min(95, Math.max(50, Number(pct) || 0));
  // P3-2: codex app-server watches thread/tokenUsage itself — no respawn needed.
  const apply = isCodexAppSession(id) ? (patch) => { setClaude(id, patch); return getSession(id)?.claude; } : (patch) => restartWith(id, patch);
  if (!p) return apply({ autoCompactPct: null, autoCompactTokens: null });
  const s = getSession(id);
  const window = s?.claude?.usage?.ctxWindow && isCodexSession(id) ? s.claude.usage.ctxWindow : resolveCtxWindow(s?.claude?.model).window;
  const tokens = Math.round(window * (p / 100));
  return apply({ autoCompactPct: p, autoCompactTokens: tokens });
}

// Switch which account a session runs on. Restarts the session with --resume, so
// the conversation survives — only the auth token changes. `accountId` null =
// use the active account. Used by the manual switcher and by auto-switch.
export function setAccount(id, accountId) {
  // The identity every MCP verdict was recorded under just changed — invalidate
  // them first. A running session respawns right below (flipping the stale
  // marks to 'pending' → verified by the new proc); a stopped one honestly
  // shows needs-reconnect until its next spawn.
  markMcpStale(id, 'account switched');
  return restartWith(id, { accountId: accountId || null });
}

// Restart the session's claude process in place: stop it (if live) and respawn
// with --resume, so the SAME conversation continues — worktree, branch, metadata,
// chat and tabs all survive. Main use: re-establish MCP server connections
// (Linear/Notion/Figma) that dropped mid-session. Unlike restartWith this also
// spawns when no proc is live (idle/dead), so it doubles as a manual revive.
// An engine with no handshake (codex) has no "proc is up" reply to wait on —
// it is usable the moment it spawns, so a restart must land on 'idle' instead
// of leaving the cockpit stuck on 'restarting' forever. See EngineDriver.handshake.
function readyOnSpawn(s) {
  try { return typeof pickEngine(s).handshake !== 'function'; } catch { return false; }
}

export function restart(id, { silent = false } = {}) {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  if (s.archived) throw new Error(`session ${id} is archived`);
  // Visible in the transcript so a restart is never silently invisible to the
  // user. Callers that already append a more specific message (e.g.
  // tryAuthRecover) pass silent:true to avoid a redundant second line.
  if (!silent) appendChat(id, { kind: 'system', text: '⟳ session restarted' });
  if (isRunning(id)) restartWith(id, {});
  else spawnProc(s, !!s.claude?.sessionId); // --resume if we have a session id
  // Progress signal for the cockpit: 'restarting' until the new proc's eager
  // initialize handshake replies (control_response flips it back to idle).
  // A proc that dies instead resolves via the close handler (idle/dead).
  setClaude(id, { state: readyOnSpawn(s) ? 'idle' : 'restarting' });
  return getSession(id)?.claude;
}

// Drop the conversation and start fresh in the SAME session slot: stop the
// live proc (if any) and respawn WITHOUT --resume, so spawnProc pins a brand
// new claude session id. Worktree, branch, metadata, chat log and tabs all
// survive — only the claude conversation itself resets. This is the real
// mechanism behind "/clear": spawning fresh already does exactly that, no CLI
// flag or message-injection needed.
export function clearConversation(id) {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  if (s.archived) throw new Error(`session ${id} is archived`);
  appendChat(id, { kind: 'system', text: '⟳ conversation cleared — starting fresh' });
  setClaude(id, { sessionId: null }); // drop the --resume pointer
  if (isRunning(id)) {
    const p = record(id);
    if (p) {
      p.expectKill = true; // don't surface this stop as an error / dead state
      try { p.child.stdin.end(); } catch {}
      stopChild(p.child);
      procs.delete(id);
      reapSessionOnExit(id, 'conversation cleared');
    }
  }
  spawnProc(getSession(id), false); // fresh session id, no --resume
  setClaude(id, { state: readyOnSpawn(s) ? 'idle' : 'restarting' });
  return getSession(id)?.claude;
}

export function killAll() {
  for (const id of [...procs.keys()]) kill(id);
  // The one-shot headless runs (explain / auto-review / status summary) are
  // supervised under the `headless` tag rather than held in a local set — this
  // line used to read a `headless` binding that was never defined anywhere in
  // this module, so killAll() threw ReferenceError. It is called from
  // shutdown(), so EVERY graceful stop aborted right here: the WhatsApp bridge
  // was left running, the host lock was never released, and the process hung
  // "alive but not responding" instead of exiting.
  try {
    killByTag('headless');
  } catch (e) {
    console.error('[claude] could not stop headless runs:', e?.message);
  }
}

// LADDER1: what happened on the weaker rung while the full history was parked —
// the chat events since the compaction, rendered plainly and capped, so the
// restored top-rung conversation is not blind to the interim turns. Mechanical
// on purpose (no LLM call on the climb back — it is a discretionary move).
function interimDigest(id, sinceIso) {
  const since = Date.parse(sinceIso || '') || 0;
  const evs = (getChat(id, 0) || []).filter((e) => {
    const t = typeof e.ts === 'number' ? e.ts : Date.parse(e.ts || '') || 0; // appendChat stamps ts = Date.now()
    return since ? t >= since : true;
  });
  const meaningful = evs.filter((e) => e.kind === 'user' || e.kind === 'assistant-text' || e.kind === 'tool-use' || e.kind === 'error');
  if (!meaningful.length) return '';
  const { text, omitted } = renderEvents(meaningful, 12_000);
  return (
    `[host — full history restored] Your model's quota reset, so this conversation resumes with its FULL history. ` +
    `Meanwhile the session kept working on a smaller model with a compacted context; here is what happened there` +
    (omitted ? ` (${omitted} events omitted)` : '') +
    `:\n=== INTERIM TURNS ===\n${text}\n=== END OF INTERIM ===\n\n`
  );
}

// Claude's EngineDriver — registered here (not exported) so engine-driver.ts never imports this file back.
/** @type {import('./lib/engine-driver.js').EngineDriver} */
const claudeDriver = {
  id: 'claude',
  prepare() {},
  buildSpawn: buildClaudeSpawn,
  handleEvent,
  writeMessage: writeUserMessage,
  handshake: claudeHandshake,
  interrupt: claudeInterrupt,
  sessionId: { mode: 'assigned', assign: () => randomUUID() },
  permissions: claudePermissions,
  injectMcp: claudeInjectMcp,
  modelArgs: claudeModelArgs,
  effortLevels: () => EFFORT_LEVELS,
};
registerEngine(claudeDriver);
