// claude CLI process manager: one long-lived `claude -p` per session, talking
// stream-json on both stdin and stdout. Verified against claude 2.1.175:
//   --input-format/--output-format stream-json, --include-partial-messages,
//   --verbose, --permission-mode, --session-id, --resume, --mcp-config (inline
//   JSON), and --permission-prompt-tool (accepted; hidden from --help).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isWin, which, extraBinDirs, pidAlive, HOME } from './lib/platform.js';
import { supervise, killTree } from './lib/children.js';
import { cfg, CHAT_DIR, getSession, setClaude, setBg, listSessions, untildify, setChangesExplaining, setAutoReviewing, removePendingPrompt, setSummarizing } from './state.js';
import { broadcast } from './bus.js';
import { expirePendingPermissions, expirePendingScreenRequests } from './api.js';
import { tokenForSession, quarantine, nextAvailable, getActiveId, getAccount, setActive, resolveRefreshToken } from './accounts.js';
import { refreshOne } from './oauth-login.js';
import { getMemoryBootstrap } from './memory.js';

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
// every new session fails to start. Resolve an absolute path to the CLI once at
// boot, and enrich the process PATH with the usual user bin dirs so claude and
// everything it shells out to (git/node/bun) resolve too.
const EXTRA_BINS = extraBinDirs();

function resolveClaudeBin() {
  const override = process.env.ARIGAMI_CLAUDE_BIN;
  if (override && fs.existsSync(override)) return override;
  // which() honours PATHEXT, so this finds claude.exe / claude.cmd on Windows.
  const found = which('claude', EXTRA_BINS);
  if (found) return found;
  // Last resort (POSIX only): ask the user's login shell where claude is —
  // covers version managers (nvm/asdf/volta) that only put it on PATH there.
  if (!isWin) {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const r = Bun.spawnSync([shell, '-lc', 'command -v claude'], { stdout: 'pipe', stderr: 'ignore' });
      const out = new TextDecoder().decode(r.stdout).trim().split('\n').filter(Boolean).pop();
      if (out && fs.existsSync(out)) return out;
    } catch { /* ignore */ }
  }
  return 'claude'; // let spawn try PATH resolution and surface ENOENT if truly absent
}

export const CLAUDE_BIN = resolveClaudeBin();

// Enrich the server PATH once (idempotent) so every spawn — ours and claude's —
// sees the user bin dirs. Publish the resolved bin so sibling spawners
// (mcp-auth) use the same absolute path.
{
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set(parts);
  for (const d of EXTRA_BINS) if (!seen.has(d)) { parts.push(d); seen.add(d); }
  process.env.PATH = parts.join(path.delimiter);
  if (CLAUDE_BIN !== 'claude') process.env.ARIGAMI_CLAUDE_BIN = CLAUDE_BIN;
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_CONFIG = JSON.stringify({
  mcpServers: { 'arigami': { command: 'bun', args: [path.join(ROOT, 'mcp', 'host-mcp.js')] } },
});

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
      return fs
        .readFileSync(chatFile(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.seq > since);
    } catch {}
  }
  return t.events.filter((e) => e.seq > since);
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
export function getChatPage(id, { limit = 100, beforeSeq = Infinity } = {}) {
  const t = tail(id);
  // If the tail buffer covers what we need, use it (fast path)
  if (beforeSeq >= Infinity && t.events.length >= limit) {
    const page = t.events.slice(-limit);
    return { events: page, hasMore: t.events.length > limit || t.seq > t.events.length, oldestSeq: page[0]?.seq ?? 0 };
  }
  // Read only what we need from disk (from the end)
  const needed = beforeSeq < Infinity ? limit + 500 : limit + 1; // overshoot for filtering
  const raw = readTailLines(chatFile(id), needed);
  const filtered = beforeSeq < Infinity ? raw.filter((e) => e.seq < beforeSeq) : raw;
  const page = filtered.slice(-limit);
  return {
    events: page,
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

function spawnProc(s, resume) {
  const claudeSid = resume ? s.claude.sessionId : randomUUID();
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', s.claude?.permissionMode || 'bypassPermissions',
    // Model is opt-in: only pass --model when the user picked one (an alias like
    // 'opus'/'sonnet'/'haiku' or a full id). Otherwise let Claude Code's default win.
    ...(s.claude?.modelChoice ? ['--model', s.claude.modelChoice] : []),
    ...(s.claude?.effort ? ['--effort', s.claude.effort] : []),
    ...(s.claude?.autoCompactTokens ? ['--autocompact', String(s.claude.autoCompactTokens)] : []),
    '--mcp-config', MCP_CONFIG,
    '--permission-prompt-tool', 'mcp__arigami__permission_prompt',
    // Register the bundled skill pack (skills/) as a plugin so sessions can
    // invoke them as /arigami:<skill> — they appear in the chat palette.
    '--plugin-dir', ROOT,
    ...(resume ? ['--resume', claudeSid] : ['--session-id', claudeSid]),
  ];
  const cwd = untildify(s.cwd) || HOME;
  const child = spawn(CLAUDE_BIN, args, {
    cwd,
    env: {
      ...baseEnv(),
      ...accountEnv(s),
      ARIGAMI_SESSION_ID: s.id,
      ARIGAMI_URL: `http://localhost:${cfg.port}`,
      ARIGAMI_SKILLS: path.join(ROOT, 'skills'), // host skill pack for the session
      // Dispatcher: a needsServer worker gets a host-allocated port as $PORT so
      // its dev server binds the slot the host reserved (metadata.port).
      ...(s.metadata?.port ? { PORT: String(s.metadata.port) } : {}),
      // Per-session desktop (T8): set only if allocated before this spawn
      // (needs_screen:true at create_session, or a respawn after a lazy
      // allocation from an earlier request_screen/capture_screen/browser-open
      // in this session). A desktop allocated while this process is already
      // running only takes effect on its next spawn — env can't be changed
      // on a live child.
      ...(s.metadata?.screen?.display ? { DISPLAY: s.metadata.screen.display } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // A session's claude spawns its own tree (MCP servers, tool shells). Put it
  // under supervision so that tree dies with the host instead of outliving it
  // holding the inherited listen socket.
  supervise(child, `session:${s.id}`);
  const p = {
    child,
    resume,
    spawnedAt: Date.now(),
    expectKill: false,
    stderr: '',
    buf: '',
    sent: [], // user messages written since spawn — replayed if a --resume spawn dies early
    pendingBg: new Map(), // tool_use_id → {command,description} awaiting its bg tool_result
    hostToolIds: new Set(), // tool_use_ids of mcp__arigami__* calls — their JSON echoes are suppressed in the transcript (they manifest as UI: status badge, action card, tabs…)
    mcpToolCalls: new Map(), // tool_use_id → mcp server name, so each result feeds that server's live health
  };
  procs.set(s.id, p);
  if (!resume) setClaude(s.id, { sessionId: claudeSid });

  child.stdout.on('data', (d) => {
    p.buf += d;
    let i;
    while ((i = p.buf.indexOf('\n')) >= 0) {
      const line = p.buf.slice(0, i);
      p.buf = p.buf.slice(i + 1);
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      try { handleEvent(s.id, j); } catch (e) { console.error('[claude] event error:', e.message); }
    }
  });
  child.stderr.on('data', (d) => { p.stderr = (p.stderr + d).slice(-4000); });
  child.on('error', (e) => {
    appendChat(s.id, { kind: 'error', text: `claude failed to start: ${e.message}` });
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
    reapSessionOnExit(s.id, 'claude process exited');
    // a --resume that dies almost immediately usually means the claude session
    // is gone ("No conversation found") → retry once fresh, replaying messages
    if (p.resume && code !== 0 && Date.now() - p.spawnedAt < 5000 && !p.expectKill) {
      setClaude(s.id, { sessionId: null });
      try {
        const np = spawnProc(sess, false);
        for (const text of p.sent) writeUserMessage(np, text);
        if (p.sent.length) np.sent.push(...p.sent);
        return;
      } catch {}
    }
    if (!p.expectKill && code !== 0) {
      appendChat(s.id, { kind: 'error', text: `claude exited (code ${code})${p.stderr ? ': ' + p.stderr.trim().slice(0, 400) : ''}` });
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
  // Eagerly handshake so the cockpit can show commands/agents/models the moment
  // the proc is up — the `init` system event (mcp/tools/skills) only fires on the
  // first turn, but `initialize` replies immediately and costs no turn.
  try {
    child.stdin.write(
      JSON.stringify({ type: 'control_request', request_id: `req_${++reqSeq}`, request: { subtype: 'initialize' } }) + '\n'
    );
  } catch {}
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

function noteMcpResult(id, server, block) {
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

// Context window per model. Opus 4.8 ships a 1M window by default; sonnet/haiku
// are 200k. An explicit `[1m]` tag always wins.
function ctxWindowFor(model = '') {
  const m = String(model).toLowerCase();
  if (m.includes('[1m]')) return 1_000_000;
  if (m.includes('opus')) return 1_000_000;
  if (m.includes('fable') || m.includes('mythos')) return 1_000_000;
  return 200_000;
}

// Each assistant message echoes the token accounting for the request that
// produced it. cache_read + cache_creation + input ≈ the prompt currently
// occupying the model's context window (output isn't part of the next turn's
// context). We surface it as claude.usage so the UI can show a live context %.
function updateUsage(id, u) {
  if (!u) return;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreation = u.cache_creation_input_tokens || 0;
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const ctxTokens = cacheRead + cacheCreation + input;
  if (ctxTokens <= 0) return; // skip empty/partial usage blocks
  let ctxWindow = ctxWindowFor(getSession(id)?.claude?.model);
  // A prompt can never exceed its real window — if the measured tokens beat our
  // guess, the guess is wrong (unrecognized model id): step up to the 1M tier.
  if (ctxTokens > ctxWindow) ctxWindow = 1_000_000;
  const ctxPct = Math.min(100, Math.round((ctxTokens / ctxWindow) * 100));
  setClaude(id, {
    usage: { ctxTokens, ctxWindow, ctxPct, breakdown: { cacheRead, cacheCreation, input, output } },
  });
}

// ---- auto-switch on account limit -------------------------------------------
// When a turn ends with a subscription limit error, quarantine the account that
// hit it until its reset, switch the session to the next available pooled
// account (resume preserves the conversation), and replay the failed message so
// the turn actually completes. This is the "auto switch when hit the limit" the
// accounts feature was built for.
const LIMIT_RE = /hit your (?:session|usage|weekly) limit|usage limit reached|rate limit|exceeded your.{0,20}limit|out of (?:usage|credits)/i;
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

function tryAutoSwitch(id, text) {
  if (switchingSessions.has(id)) return;
  const s = getSession(id);
  const curId = s?.claude?.accountId || getActiveId();
  const resetAt = parseResetAt(text);
  try { quarantine(curId, resetAt); } catch {}
  const next = nextAvailable(curId);
  if (!next) {
    appendChat(id, {
      kind: 'error',
      text: 'All accounts have hit their limit. Add another account, or wait for one to reset.',
    });
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
const AUTH_RE = /unauthorized|revoked|invalid[_ ](?:api key|token|grant)|token.{0,20}expired|authentication_error|please (?:log ?in|authenticate) again/i;
const authRecovering = new Set(); // guards against re-entrant recovery per session

async function tryAuthRecover(id, text) {
  if (authRecovering.has(id)) return;
  const s = getSession(id);
  const accountId = s?.claude?.accountId || getActiveId();
  if (!resolveRefreshToken(accountId)) {
    appendChat(id, {
      kind: 'error',
      text: 'Authentication error, and this account has no refresh token to recover automatically — please re-authenticate it.',
    });
    return;
  }
  authRecovering.add(id);
  const lastMsg = [...(record(id)?.sent || [])].pop();
  try {
    const ok = await refreshOne(accountId);
    if (!ok) {
      appendChat(id, { kind: 'error', text: 'Authentication error — token refresh failed. Please re-authenticate this account.' });
      return;
    }
    appendChat(id, { kind: 'system', text: '⟳ authentication expired — refreshed the token and restarted the session' });
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
        appendChat(id, {
          kind: j.is_error ? 'error' : 'result',
          text,
          isError: !!j.is_error,
          durationMs: j.duration_ms,
          costUsd: j.total_cost_usd,
          numTurns: j.num_turns,
        });
        // Subscription limit hit → quarantine this account and retry on another.
        if (j.is_error && LIMIT_RE.test(text)) tryAutoSwitch(id, text);
        // Auth token expired/revoked → refresh it and respawn on the same account.
        else if (j.is_error && AUTH_RE.test(text)) tryAuthRecover(id, text);
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
const UPLOADS_DIR = path.join(path.dirname(CHAT_DIR), 'uploads');

function saveAttachments(id, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  const dir = path.join(UPLOADS_DIR, id);
  const out = [];
  for (const a of attachments) {
    if (!a?.name || !a?.dataBase64) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(a.name).replace(/[^\w.-]+/g, '_').slice(-90);
      const file = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(file, Buffer.from(a.dataBase64, 'base64'));
      out.push({ name: a.name, path: file, type: a.type || '', isImage: /^image\//.test(a.type || ''), dataBase64: a.dataBase64 });
    } catch (e) {
      console.error('[attach] save failed:', e.message);
    }
  }
  return out;
}

// Memory M1.3: inject the USER.md+MEMORY.md snapshot into a session's very
// first turn only (fresh claude session, nothing sent yet on this proc) — never
// mid-conversation, so the prompt-cache prefix stays stable. A --resume proc
// already has this in its history from the original spawn.
function memoryBootstrapPrefix() {
  const { userMd, memoryMd } = getMemoryBootstrap();
  if (!userMd.trim() && !memoryMd.trim()) return '';
  let block = "<system-reminder>\nArigami memory snapshot (owned by the host — this instance's own memory, not Claude Code's per-project memory). Frozen at session start; call memory_search for anything not shown here.\n";
  if (userMd.trim()) block += `\n## USER.md\n${userMd.trim()}\n`;
  if (memoryMd.trim()) block += `\n## MEMORY.md\n${memoryMd.trim()}\n`;
  block += '</system-reminder>\n\n';
  return block;
}

function writeUserMessage(p, text, attachments = []) {
  const content = [];
  let txt = text || '';
  if (!p.resume && !p.sent.length) txt = memoryBootstrapPrefix() + txt;
  if (attachments.length) {
    const list = attachments.map((a) => `- ${a.name} → ${a.path}${a.isImage ? ' (image)' : ''}`).join('\n');
    txt += (txt ? '\n\n' : '') + `📎 Attached ${attachments.length} file(s) — read them as needed:\n${list}`;
  }
  if (txt) content.push({ type: 'text', text: txt });
  for (const a of attachments) {
    if (a.isImage && a.dataBase64) content.push({ type: 'image', source: { type: 'base64', media_type: a.type, data: a.dataBase64 } });
  }
  if (!content.length) content.push({ type: 'text', text: '(empty message)' });
  p.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
}

export function sendMessage(id, text, attachments = []) {
  const p = ensureRunning(id); // respawns with --resume after an exit
  const saved = saveAttachments(id, attachments);
  appendChat(id, {
    kind: 'user',
    text,
    ...(saved.length ? { attachments: saved.map((a) => ({ name: a.name, isImage: a.isImage })) } : {}),
  });
  setClaude(id, { state: 'working' });
  writeUserMessage(p, text, saved);
  p.sent.push(text);
  return true;
}

// Answer a client-side tool_use (e.g. AskUserQuestion) with a tool_result so the
// blocked turn resumes on the SAME turn, immediately. AskUserQuestion emits a
// tool_use and blocks awaiting a tool_result for that id (default timeout ~60s);
// a plain user message written meanwhile is queued by the CLI until that timeout
// — the "stuck on working" stall. The tool_result envelope is the standard
// Messages-API shape the CLI already accepts on stdin.
export function answerToolResult(id, toolUseId, content, isError = false) {
  if (!toolUseId) return false;
  const wasRunning = isRunning(id);
  const p = ensureRunning(id); // respawns with --resume after an exit
  if (!wasRunning) {
    // The proc that owned this tool_use already exited (its own ~60s block
    // timeout, or the user was slow) — a tool_result keyed to a toolUseId the
    // fresh --resume never asked for is silently dropped, leaving 'working'
    // stuck forever (the state reconciler only fixes 'working' when the proc
    // ISN'T running, which isn't the case right after a respawn). Deliver the
    // answer as a normal turn instead — also makes it replay-safe under the
    // early-death retry below, which only replays sendMessage's p.sent log.
    return sendMessage(id, content);
  }
  const block = { type: 'tool_result', tool_use_id: toolUseId, content: String(content ?? '') };
  if (isError) block.is_error = true;
  p.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [block] } }) + '\n');
  setClaude(id, { state: 'working' });
  return true;
}

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

// Auto-play the next queued prompt when a turn ends — but only when it's
// REASONABLE: autoPlay on, session still idle after the settle delay (the user
// may have typed something new meanwhile), and nothing waiting on a human
// (pending permission request or a sticky action bar).
function scheduleAutoPlay(id) {
  const s = getSession(id);
  if (!s?.promptAutoPlay || !(s.pendingPrompts || []).length) return;
  const t = setTimeout(() => {
    try {
      const cur = getSession(id);
      if (!cur?.promptAutoPlay || !(cur.pendingPrompts || []).length) return;
      // Not idle = a new turn started, or a permission request is pending
      // (that flips state to 'awaiting-input').
      if (cur.claude?.state !== 'idle') return;
      if (cur.action) return; // sticky action bar → a human decision is pending
      playPendingPrompt(id, null, { auto: true });
    } catch (e) {
      console.error('[prompts] auto-play failed:', e?.message || e);
    }
  }, 800);
  if (t.unref) t.unref();
}

// Independent, read-only one-shot Claude runs (explain / auto-review). These do
// NOT touch the session's conversation or its main claude proc — they spawn a
// throwaway `claude -p` in the session's worktree with ARIGAMI_SESSION_ID set,
// so the MCP tools write results straight to that session's Changes tab. The
// session's chat, turn, and working state are untouched. Fire-and-forget.
const headless = new Set();
function runHeadless(s, prompt, onExit) {
  const cwd = untildify(s.metadata?.worktree || s.cwd) || HOME;
  const child = spawn(
    CLAUDE_BIN,
    [
      '-p', prompt,
      '--permission-mode', 'bypassPermissions', // one-shot, no prompts; prompt enforces read-only
      '--model', 'sonnet', // fast/cheap for these read-only utility runs (don't inherit the user's Opus default)
      '--mcp-config', MCP_CONFIG,
      '--strict-mcp-config', // ONLY the arigami MCP — skip the user's global servers (fast, focused)
      '--plugin-dir', ROOT, // registers the host skill pack (explain-changes etc.)
    ],
    {
      cwd,
      env: {
        ...baseEnv(),
        ...accountEnv(s),
        ARIGAMI_SESSION_ID: s.id, // MCP tools target THIS session's Changes tab
        ARIGAMI_URL: `http://localhost:${cfg.port}`,
        ARIGAMI_SKILLS: path.join(ROOT, 'skills'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  supervise(child, 'headless');
  headless.add(child);
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  child.on('error', (e) => { console.error('[headless] spawn failed:', e.message); headless.delete(child); try { onExit?.(1); } catch {} });
  child.on('close', (code) => {
    headless.delete(child);
    if (code) console.error(`[headless] exited ${code}${err ? ': ' + err.trim().slice(0, 300) : ''}`);
    try { onExit?.(code || 0); } catch {}
  });
  if (child.unref) child.unref();
  return child;
}

// Shell snippet that reads the right diff for the mode. PR = working tree vs the
// merge-base with the default branch; uncommitted = working tree vs HEAD.
const diffCmds = (mode) =>
  mode === 'pr'
    ? 'BASE=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD origin/master 2>/dev/null || echo HEAD); ' +
      'git diff --stat "$BASE"; git diff "$BASE"; git ls-files --others --exclude-standard'
    : 'git status --porcelain=v1; git diff HEAD; git ls-files --others --exclude-standard';

// Explain the session's changes in the Changes tab — an independent, read-only
// one-shot run. Self-contained prompt (does not depend on discovering a plugin
// skill) that REQUIRES the MCP write as its only deliverable. mode: 'uncommitted'|'pr'.
export function explainChanges(id, mode) {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  const baseNote =
    mode === 'pr'
      ? 'Pass base="<the BASE ref/sha you diffed against>" so the tab opens on the PR comparison.'
      : 'Use base="HEAD" (uncommitted changes).';
  setChangesExplaining(id, mode); // live "explaining…" state for the Changes tab
  // Safety net: clear the running flag even if the proc is killed/hangs.
  const clear = () => setChangesExplaining(id, null);
  const guard = setTimeout(clear, 5 * 60 * 1000);
  runHeadless(
    s,
    `Explain this git worktree's changes for the host "Changes" tab. Work in the current directory. READ-ONLY — never modify, stage, commit, or push.\n\n` +
      `1. Read the changes by running:\n   ${diffCmds(mode)}\n   Open untracked/new files to see what they add.\n` +
      `2. For each changed file, write 1–3 sentences: what changed and why.\n` +
      `3. Group related files into cross-file "features" (title, summary, the files it touches, optional details).\n` +
      `4. You MUST finish by calling the tool mcp__arigami__set_changes_explanation with arguments ` +
      `{ language: "<the language the user converses in, e.g. \\"English\\" or \\"Hebrew\\">", base, files: [{path, summary}], features: [{title, summary, files, details}] }. ${baseNote}\n` +
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
  setAutoReviewing(id, mode); // live "reviewing…" state for the Changes tab
  const clear = () => setAutoReviewing(id, null);
  const guard = setTimeout(clear, 5 * 60 * 1000);
  runHeadless(
    s,
    `Review this git worktree's changes as a careful senior engineer. Work in the current directory. READ-ONLY — never modify, stage, commit, or push.\n\n` +
      `1. Read the changes by running:\n   ${diffCmds(mode)}\n` +
      `2. Find real problems only: bugs, edge cases, regressions, security/perf issues. Skip style nits.\n` +
      `3. You MUST finish by POSTing your findings (this is the ONLY deliverable). For each finding give the file path and, when it maps to a specific changed line, the NEW-file line number so it can attach inline:\n` +
      `   curl -s -X POST "$ARIGAMI_URL/__api/sessions/$ARIGAMI_SESSION_ID/review/suggestions" -H 'content-type: application/json' -d '{"comments":[{"path":"<file>","line":<new-file line number, optional>,"body":"<the issue + a concrete suggested fix>"}]}'\n` +
      `Include one object per finding. If the changes look clean, POST a single comment with the worst-case path saying they look good. Do not skip the curl.`,
    () => { clearTimeout(guard); clear(); }
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

// stream-json interrupt (SIGINT-equivalent): control_request over stdin
export function interrupt(id) {
  const p = record(id);
  if (!isRunning(id)) return false;
  try {
    p.child.stdin.write(
      JSON.stringify({ type: 'control_request', request_id: `req_${++reqSeq}`, request: { subtype: 'interrupt' } }) + '\n'
    );
  } catch {
    try { p.child.kill('SIGINT'); } catch {}
  }
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
  return restartWith(id, { permissionMode: mode });
}

// `model` is a `claude --model` value — an alias ('opus'|'sonnet'|'haiku') or a
// full model id. '' or 'default' clears it back to the Claude Code default
// (no --model flag). Stored as `modelChoice` so it persists across respawns; the
// reported `model` field reflects what the running session actually resolved to.
export function setModel(id, model) {
  const choice = !model || model === 'default' ? null : String(model);
  return restartWith(id, { modelChoice: choice });
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// `effort` maps 1:1 to `claude --effort <level>`. '' or 'default' clears it
// back to the CLI's own default (no --effort flag).
export function setEffort(id, effort) {
  const level = !effort || effort === 'default' ? null : String(effort);
  if (level && !EFFORT_LEVELS.includes(level)) throw new Error(`invalid effort level: ${level}`);
  return restartWith(id, { effort: level });
}

// Auto-compact threshold as a % of the session's current model context window,
// applied as a real `claude --autocompact <tokens>` spawn flag (not a message
// injected into the conversation, which the CLI may or may not treat as a real
// slash command over stream-json stdin). null/0 disables it.
export function setAutoCompact(id, pct) {
  const p = pct == null ? null : Math.min(95, Math.max(50, Number(pct) || 0));
  if (!p) return restartWith(id, { autoCompactPct: null, autoCompactTokens: null });
  const s = getSession(id);
  const tokens = Math.round(ctxWindowFor(s?.claude?.model) * (p / 100));
  return restartWith(id, { autoCompactPct: p, autoCompactTokens: tokens });
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
  setClaude(id, { state: 'restarting' });
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
  setClaude(id, { state: 'restarting' });
  return getSession(id)?.claude;
}

export function killAll() {
  for (const id of [...procs.keys()]) kill(id);
  for (const c of [...headless]) stopChild(c);
}
