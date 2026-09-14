// Authenticate MCP servers from the UI. Wraps the `claude mcp {list,login,logout}`
// CLI (which owns the OAuth grants + keychain storage) so the /mcp panel can
// show each server's auth status and log in/out without dropping to a terminal.
//
// `claude mcp login <name> --no-browser` (Claude Code >= 2.1.191) PRINTS the
// authorize URL instead of opening a browser, then does two things at once:
// it listens on http://localhost:<random>/callback AND waits on stdin for the
// redirect URL to be pasted back. Both paths were verified in the M1 spike:
//
//   * the session Chrome runs on this same host, so when it follows the consent
//     the loopback listener completes the exchange by itself (no paste);
//   * a cockpit open on a phone can't reach that loopback — the human (or the
//     connect-mcp playbook) pastes the final `…/callback?code=…` URL back and
//     `submitRedirect()` writes it to the pty's stdin.
//
// Like setup-token these are TTY programs, so they run under a pty relay
// (lib/pty-bridge.py on POSIX, winpty on Windows — see platform.ptyArgs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { codexMcpHome } from './mcp-connections.js';
import { ptyArgs } from './lib/platform.js';
import { supervise, killTree } from './lib/children.js';
import { broadcast } from './bus.js';
import { resourceRoot } from './lib/resource-root.js';

const BRIDGE = path.join(resourceRoot(), 'server', 'lib', 'pty-bridge.py');

const stripAnsi = (s) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const URL_RE = /https?:\/\/[^\s'"]+/;

// Run a plain (non-interactive) `claude` subcommand and collect combined output.
// NOT via the pty bridge: `mcp list` renders an aligned TUI table under a pty
// (spacing done with cursor moves, not spaces), which is unparseable — on a
// normal pipe it prints clean, space-separated lines. Resolves on exit/timeout.
// `env` overrides the daemon's own environment — the per-session health probe
// (claude.js checkMcp) passes the session's account env so the check runs as
// the identity the session actually uses.
export function runClaude(args, timeoutMs = 15000, cwd, env) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      // Use the host-resolved absolute claude path (claude.js publishes it) so
      // this works from a thin-PATH launch context too; fall back to PATH.
      const bin = process.env.ARIGAMI_CLAUDE_BIN || 'claude';
      child = spawn(bin, args, { env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'], cwd: cwd || undefined });
      supervise(child, `mcp:${args[0] || 'claude'}`);
    } catch (e) {
      return resolve(`spawn failed: ${e.message}`);
    }
    const t = setTimeout(() => { killTree(child.pid); resolve(out); }, timeoutMs);
    if (t.unref) t.unref();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', () => { clearTimeout(t); resolve(out); });
    child.on('error', (e) => { clearTimeout(t); resolve(out + `\n${e.message}`); });
  });
}

// ---- list -------------------------------------------------------------------
// Cache + in-flight de-dupe keyed by cwd: the daemon's own cwd sees global +
// plugin servers; a session's cwd additionally sees that project's .mcp.json
// servers (e.g. linear-server) with their real, post-auth status.
const listCaches = new Map(); // cwdKey -> { at, data }
const listInflight = new Map(); // cwdKey -> Promise

export function parseList(text) {
  const out = [];
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const l = raw.trim();
    const mi = l.indexOf(': ');
    const si = l.lastIndexOf(' - ');
    if (mi < 0 || si < 0 || si <= mi) continue;
    const name = l.slice(0, mi).trim();
    if (!name || /checking/i.test(name)) continue;
    const endpoint = l.slice(mi + 2, si).trim();
    const statusText = l.slice(si + 3).trim();
    let status = 'unknown';
    if (/connected/i.test(statusText)) status = 'connected';
    else if (/needs auth/i.test(statusText)) status = 'needs-auth';
    else if (/pending/i.test(statusText)) status = 'pending';
    out.push({ name, endpoint, status, statusText });
  }
  return out;
}

// `claude mcp list` health-checks every server; remote claude.ai connectors are
// slow, so allow a generous timeout and cache the result. De-dupe concurrent
// calls so many panel opens don't each spawn a list.
export async function listServers(force = false, cwd = '') {
  const key = cwd || '';
  const c = listCaches.get(key);
  if (!force && c && c.data.length && Date.now() - c.at < 45_000) return c.data;
  if (listInflight.has(key)) return listInflight.get(key);
  const p = (async () => {
    try {
      const servers = parseList(await runClaude(['mcp', 'list'], 25_000, cwd || undefined));
      if (servers.length) listCaches.set(key, { at: Date.now(), data: servers });
      return servers.length ? servers : listCaches.get(key)?.data || [];
    } finally {
      listInflight.delete(key);
    }
  })();
  listInflight.set(key, p);
  return p;
}

// Invalidate all list caches (call after a login/logout — or an account
// switch — changes status).
export const invalidateLists = () => listCaches.clear();

// ---- P2-4: codex's own `codex mcp login` --------------------------------------
// One host-wide CODEX_HOME (mcp-connections codexMcpHome); the server url and the file store ride on argv, so no config.toml races.

/** Pure: argv for `codex mcp <verb> <name>` with the server passed as -c overrides. */
export function codexMcpArgs(verb, name, url) {
  const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
  return ['-c', 'mcp_oauth_credentials_store="file"', ...(url ? ['-c', `mcp_servers.${key}.url=${JSON.stringify(url)}`] : []), 'mcp', verb, name];
}

const codexBin = () => process.env.ARIGAMI_CODEX_BIN || 'codex';
const loginKey = (name, engine) => (engine === 'codex' ? `codex:${name}` : name);

/** `codex mcp logout <name>` under the codex MCP home. */
export function codexLogout(name, url) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(codexBin(), codexMcpArgs('logout', name, url), { env: { ...process.env, CODEX_HOME: codexMcpHome() }, stdio: ['ignore', 'pipe', 'pipe'] });
      supervise(child, 'mcp:codex-logout');
    } catch (e) {
      return resolve({ ok: false, output: `spawn failed: ${e.message}` });
    }
    const t = setTimeout(() => { killTree(child.pid); resolve({ ok: false, output: out }); }, 15000);
    if (t.unref) t.unref();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => { clearTimeout(t); logins.delete(loginKey(name, 'codex')); resolve({ ok: code === 0, output: stripAnsi(out).trim().slice(-200) }); });
  });
}

// ---- login / logout ---------------------------------------------------------
/** @type {Map<string, any>} */
const logins = new Map();

const publicLogin = (f) => ({ name: f.name, state: f.state, url: f.url || null, error: f.error || null, ...(f.engine === 'codex' ? { engine: 'codex' } : {}) });
const emitLogin = (f) => broadcast({ type: 'mcp-auth', login: publicLogin(f) });

/** @param {string} name @param {string} [cwd] @param {{browser?: boolean, env?: object, engine?: string, url?: string}} [opts] */
export function startLogin(name, cwd, opts = {}) {
  if (!name) return { name, state: 'error', url: null, error: 'no server name' };
  const key = loginKey(name, opts.engine);
  const prev = logins.get(key);
  if (prev && (prev.state === 'starting' || prev.state === 'awaiting')) return publicLogin(prev);

  const f = { name, engine: opts.engine === 'codex' ? 'codex' : 'claude', state: 'starting', url: null, error: null, buf: '' };
  let child;
  if (f.engine === 'codex') {
    try {
      const home = codexMcpHome();
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const [bin, ...args] = ptyArgs(BRIDGE, [codexBin(), ...codexMcpArgs('login', name, opts.url)]);
      // BROWSER=true: codex must print the URL, never try to open one on the host.
      child = spawn(bin, args, { env: { ...process.env, CODEX_HOME: home, BROWSER: 'true', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], cwd: home });
      supervise(child, `mcp-login:codex:${name}`);
    } catch (e) {
      f.state = 'error';
      f.error = `could not start codex login: ${e.message}`;
      return publicLogin(f);
    }
  }
  if (!child) try {
    // Run in the session's cwd so project-scoped .mcp.json servers (e.g. an
    // agent's local-scope grants) resolve — they don't exist from the daemon's
    // own cwd. `--no-browser` keeps the URL on stdout and stdin open for the
    // paste-back; a headless daemon has no browser to open anyway.
    const claudeBin = process.env.ARIGAMI_CLAUDE_BIN || 'claude';
    const [bin, ...args] = ptyArgs(BRIDGE, [claudeBin, 'mcp', 'login', name, ...(opts.browser ? [] : ['--no-browser'])]);
    child = spawn(bin, args, { env: { ...process.env, ...(opts.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], cwd: cwd || undefined });
    // The pty relay wraps the real `claude mcp login` — supervise the wrapper so
    // the relay AND the claude under it go together.
    supervise(child, `mcp-login:${name}`);
  } catch (e) {
    f.state = 'error';
    f.error = `could not start login: ${e.message}`;
    return publicLogin(f);
  }
  f.child = child;
  logins.set(key, f);

  const onText = (d) => {
    f.buf += d;
    const clean = stripAnsi(f.buf);
    if (!f.url) {
      const m = clean.match(URL_RE);
      if (m) { f.url = m[0]; f.state = 'awaiting'; emitLogin(f); }
    }
    // HTTP MCP servers hold the process open on a loopback ("Waiting for
    // authorization"); claude.ai connectors print the URL and exit immediately.
    if (/waiting for authorization/i.test(clean)) f.waits = true;
    if (/(authenticated|success|authorized|logged in|✔)/i.test(clean) && f.state !== 'done') {
      f.state = 'done';
      emitLogin(f);
    }
  };
  child.stdout.on('data', (d) => onText(d.toString()));
  child.stderr.on('data', (d) => onText(d.toString()));
  child.on('close', (code) => {
    invalidateLists(); // status likely changed
    if (f.state === 'done' || f.state === 'error') return;
    if (f.engine === 'codex' && code) {
      f.state = 'error';
      f.error = stripAnsi(f.buf).split('\n').map((l) => l.trim()).filter((l) => l && !/^WARNING:/.test(l)).slice(-1)[0] || 'codex mcp login failed';
    } else if (f.waits && !code) {
      // A loopback server that waited then exited cleanly = authorization landed.
      f.state = 'done';
    } else if (code && f.pasted) {
      // M1: we handed a redirect URL over and `claude` still exited non-zero —
      // the exchange was rejected (stale code, wrong `state`, revoked consent).
      // Without this the generic "printed a URL, so keep waiting" branch below
      // would leave the card spinning on a login that is already dead.
      f.state = 'error';
      f.error = stripAnsi(f.buf).split('\n').map((s) => s.trim()).filter(Boolean).slice(-1)[0] || 'the redirect URL was rejected';
    } else if (f.url) {
      // Connector that printed a URL and exited: go authorize in the browser.
      f.state = 'awaiting';
    } else if (code) {
      f.state = 'error';
      f.error = stripAnsi(f.buf).split('\n').map((s) => s.trim()).filter(Boolean).slice(-2).join(' ') || 'login failed';
    } else {
      f.state = 'done';
    }
    emitLogin(f);
  });
  f.timer = setTimeout(() => killTree(child.pid), 5 * 60_000);
  if (f.timer.unref) f.timer.unref();
  return publicLogin(f);
}

export function loginStatus(name, engine) {
  const f = logins.get(loginKey(name, engine));
  return f ? publicLogin(f) : { name, state: 'idle', url: null, error: null };
}

export async function logout(name, cwd) {
  if (!name) return { ok: false, error: 'no server name' };
  const out = await runClaude(['mcp', 'logout', name], 12000, cwd);
  logins.delete(name);
  invalidateLists();
  return { ok: true, output: stripAnsi(out).trim().slice(-200) };
}

/**
 * M1 — paste the redirect URL back to a login that is waiting on stdin
 * (`Or paste the redirect URL here:`). Used when the consent happened in a
 * browser that cannot reach this host's loopback (cockpit on a phone), or by
 * the connect-mcp playbook after reading the final URL out of the session
 * Chrome. Accepts a full `…/callback?code=…` URL; a bare code is rejected
 * because `claude` wants the whole URL (it re-checks `state`).
 */
export function submitRedirect(name, url) {
  const f = logins.get(name);
  if (!f || !f.child || f.child.killed) return { ok: false, ...loginStatus(name), error: 'no login in progress' };
  const u = String(url || '').trim();
  if (!/^https?:\/\/[^\s]+[?&]code=[^&\s]+/.test(u)) return { ok: false, ...publicLogin(f), error: 'paste the full redirect URL (…/callback?code=…)' };
  try {
    f.child.stdin.write(u + '\n');
  } catch (e) {
    return { ok: false, ...publicLogin(f), error: `could not hand the URL to the login: ${e.message}` };
  }
  f.pasted = true;
  return { ok: true, ...publicLogin(f) };
}

/** P2-4: codex reads no stdin for the redirect — forward the pasted loopback callback to its listener ourselves. */
export async function submitCodexRedirect(name, url) {
  const f = logins.get(loginKey(name, 'codex'));
  if (!f || !f.child || f.child.killed) return { ok: false, ...loginStatus(name, 'codex'), error: 'no login in progress' };
  let target;
  try { target = new URL(String(url || '').trim()); } catch { return { ok: false, ...publicLogin(f), error: 'paste the full redirect URL (…/callback?code=…)' }; }
  if (!/^(127\.0\.0\.1|localhost)$/.test(target.hostname) || !target.searchParams.get('code'))
    return { ok: false, ...publicLogin(f), error: 'expected the loopback callback (127.0.0.1:<port>/callback/…?code=…)' };
  try {
    const res = await fetch(target.toString(), { signal: AbortSignal.timeout(30_000), redirect: 'manual' });
    f.pasted = true;
    return res.status < 400 ? { ok: true, ...publicLogin(f) } : { ok: false, ...publicLogin(f), error: `codex refused the callback (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, ...publicLogin(f), error: `could not reach codex's login listener: ${e.message}` };
  }
}

/** Give up on a login in progress (the human closed the card). */
export function cancelLogin(name, engine) {
  const f = logins.get(loginKey(name, engine));
  if (f?.child) killTree(f.child.pid);
  logins.delete(loginKey(name, engine));
  return { name, state: 'idle', url: null, error: null };
}

// ---- server registration ----------------------------------------------------
// `claude mcp add` is the only writer of ~/.claude.json's mcpServers we use, so
// the CLI stays the single owner of that file. Scope matters (M1):
//   user  — the host's own connections: every session sees them, as today.
//   local — an agent's: keyed by `cwd` ($ARIGAMI_DIR/agents/<slug>), so ANOTHER
//           agent's session never sees the grant; the owner's sessions get it
//           injected explicitly with --mcp-config under the same name.

/**
 * `claude mcp add --transport http <name> <url>` — idempotent (re-add replaces).
 * @param {string} name @param {string} url
 * @param {{scope?: 'user'|'local'|'project', cwd?: string}} [opts]
 */
export async function addServer(name, url, { scope = 'user', cwd } = {}) {
  if (!name || !url) return { ok: false, error: 'name and url are required' };
  await runClaude(['mcp', 'remove', name, '-s', scope], 10_000, cwd); // replace, never duplicate
  const out = stripAnsi(await runClaude(['mcp', 'add', '--transport', 'http', name, url, '-s', scope], 20_000, cwd)).trim();
  invalidateLists();
  return { ok: /added/i.test(out), output: out.slice(-300) };
}

/**
 * `claude mcp add-json <name> '{"type":"http","url":…,"headers":{…}}'` — the
 * bearer path (GitHub's PAT server). The token is passed to the CLI and lives
 * in Claude Code's own config afterwards; the host never writes it to a file
 * of its own and never logs it.
 */
/**
 * @param {string} name @param {string} url @param {string} header @param {string} token
 * @param {{scope?: 'user'|'local'|'project', cwd?: string}} [opts]
 */
export async function addServerWithHeader(name, url, header, token, { scope = 'user', cwd } = {}) {
  if (!name || !url || !token) return { ok: false, error: 'name, url and token are required' };
  await runClaude(['mcp', 'remove', name, '-s', scope], 10_000, cwd);
  const json = JSON.stringify({ type: 'http', url, headers: { [header || 'Authorization']: token } });
  const out = stripAnsi(await runClaude(['mcp', 'add-json', name, json, '-s', scope], 20_000, cwd)).trim();
  invalidateLists();
  return { ok: /added/i.test(out), output: out.replace(token, '<token>').slice(-300) };
}

/** @param {string} name @param {{scope?: 'user'|'local'|'project', cwd?: string}} [opts] */
export async function removeServer(name, { scope = 'user', cwd } = {}) {
  const out = stripAnsi(await runClaude(['mcp', 'remove', name, '-s', scope], 12_000, cwd)).trim();
  invalidateLists();
  return { ok: true, output: out.slice(-200) };
}

/** `claude mcp get <name>` → {name, status, url}. status: connected | needs-auth | unknown | absent. */
export async function getServer(name, cwd) {
  const text = stripAnsi(await runClaude(['mcp', 'get', name], 20_000, cwd));
  if (/no mcp server found|not found/i.test(text)) return { name, status: 'absent', url: null, output: text.trim().slice(-200) };
  const url = text.match(/^\s*URL:\s*(\S+)/m)?.[1] || null;
  const statusText = text.match(/^\s*Status:\s*(.+)$/m)?.[1]?.trim() || '';
  const status = /connected/i.test(statusText) ? 'connected' : /needs authentication/i.test(statusText) ? 'needs-auth' : 'unknown';
  return { name, status, url, statusText };
}
