// Authenticate MCP servers from the UI. Wraps the `claude mcp {list,login,logout}`
// CLI (which owns the OAuth grants + keychain storage) so the /mcp panel can
// show each server's auth status and log in/out without dropping to a terminal.
//
// `claude mcp login <name>` opens the browser to authorize (claude.ai connectors
// grant org-side and are picked up on the next session; HTTP servers use an
// OAuth loopback). Like setup-token these are TTY programs, so they run under a
// pty relay (lib/pty-bridge.py on POSIX, winpty on Windows — see
// platform.ptyArgs). We surface the printed authorize URL as a fallback link.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ptyArgs } from './lib/platform.js';
import { broadcast } from './bus.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'lib', 'pty-bridge.py');

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
    } catch (e) {
      return resolve(`spawn failed: ${e.message}`);
    }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(out); }, timeoutMs);
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

// ---- login / logout ---------------------------------------------------------
/** @type {Map<string, any>} */
const logins = new Map();

const publicLogin = (f) => ({ name: f.name, state: f.state, url: f.url || null, error: f.error || null });
const emitLogin = (f) => broadcast({ type: 'mcp-auth', login: publicLogin(f) });

export function startLogin(name, cwd) {
  if (!name) return { name, state: 'error', url: null, error: 'no server name' };
  const prev = logins.get(name);
  if (prev && (prev.state === 'starting' || prev.state === 'awaiting')) return publicLogin(prev);

  const f = { name, state: 'starting', url: null, error: null, buf: '' };
  let child;
  try {
    // Run in the session's cwd so project-scoped .mcp.json servers (e.g.
    // linear-server) resolve — they don't exist from the daemon's own cwd.
    const claudeBin = process.env.ARIGAMI_CLAUDE_BIN || 'claude';
    const [bin, ...args] = ptyArgs(BRIDGE, [claudeBin, 'mcp', 'login', name]);
    child = spawn(bin, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], cwd: cwd || undefined });
  } catch (e) {
    f.state = 'error';
    f.error = `could not start login: ${e.message}`;
    return publicLogin(f);
  }
  f.child = child;
  logins.set(name, f);

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
    if (f.waits && !code) {
      // A loopback server that waited then exited cleanly = authorization landed.
      f.state = 'done';
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
  f.timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 5 * 60_000);
  if (f.timer.unref) f.timer.unref();
  return publicLogin(f);
}

export function loginStatus(name) {
  const f = logins.get(name);
  return f ? publicLogin(f) : { name, state: 'idle', url: null, error: null };
}

export async function logout(name, cwd) {
  if (!name) return { ok: false, error: 'no server name' };
  const out = await runClaude(['mcp', 'logout', name], 12000, cwd);
  logins.delete(name);
  invalidateLists();
  return { ok: true, output: stripAnsi(out).trim().slice(-200) };
}
