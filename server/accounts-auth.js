// Guided account authentication: drive `claude setup-token` to mint a long-lived
// OAuth token WITHOUT the user copy-pasting the token by hand.
//
// setup-token needs a real TTY, so we run it under a pty relay — lib/pty-bridge.py
// (stdlib python `pty`) on POSIX, winpty on Windows, chosen by platform.ptyArgs.
// When the host is the user's own machine, setup-token opens
// the browser to a localhost-loopback redirect and its OWN loopback catches the
// auth code, exchanges it, and prints the `sk-ant-oat…` token — which we scrape
// and store. Zero paste. If the browser can't reach the host (remote/headless),
// setup-token falls back to a "paste this code" prompt; we expose that too via
// submitCode(). The token is captured server-side and never sent to the client.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ptyArgs, isWin } from './lib/platform.js';
import { supervise, killTree } from './lib/children.js';
import { addTokenAccount } from './accounts.js';
import { cfg } from './lib/config.js';
import { broadcast } from './bus.js';
import { resourceRoot } from './lib/resource-root.js';

const BRIDGE = path.join(resourceRoot(), 'server', 'lib', 'pty-bridge.py');
const TIMEOUT_MS = 5 * 60_000;

// Strip ANSI so URL/token scraping sees plain text. setup-token is a full TUI:
// besides CSI (incl. private `?`/`>`/`<` params) + OSC, it emits charset selects
// (ESC(B), save/restore cursor (ESC7/ESC8), SI/SO, and other 2-byte ESC codes.
// Miss any and leftover bytes can split a token mid-string, so strip broadly.
const stripAnsi = (s) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '') // CSI (with private/intermediate)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][0-9A-Za-z]/g, '') // charset select, e.g. ESC(B
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[=>78cDEHM]/g, '') // other 2-byte ESC codes (save/restore cursor…)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x0e\x0f]/g, ''); // SI / SO

const AUTH_URL_RE = /https:\/\/claude\.com\/[^\s\x1b'"]+oauth\/authorize\?[^\s\x1b'"]+/;

// The success banner setup-token prints right before the token. The TUI renders
// with cursor moves and NO literal spaces ("createdsuccessfully"), so match with
// \s* between words.
const SUCCESS_RE = /created\s*successfully|your\s*oauth\s*token/i;

// Capture the minted token. The prefix is NOT reliably `sk-ant-oat…` (observed
// mints start `sk-ant-at…` too), so we don't gate on prefix. Two strategies:
//
//  1. POSITIONAL (preferred): the durable token is printed right after the
//     "Your OAuth token …:" label and is terminated by the TUI's carriage
//     return. We slice the segment AFTER that label and read the first sk-ant-…
//     run, NOT stripping \r first (the \r naturally terminates the token — strip
//     it and the token merges with the following "Store this token securely…"
//     text). Whatever prefix it has, this line IS the durable token, so accept it.
//  2. FALLBACK: an explicit `sk-ant-oat…` anywhere (older/other layouts).
//
// We never grab a stray earlier token because strategy 1 is anchored to the
// success label and strategy 2 requires the unambiguous `oat` prefix.
const LABEL_RE = /your\s*oauth\s*token[^:\n]*:/i;
const scanToken = (raw) => {
  const afterLabel = raw.split(LABEL_RE)[1];
  if (afterLabel) {
    const m = afterLabel.match(/sk-ant-[0-9A-Za-z_-]{10,}/);
    if (m) return m[0];
  }
  const oat = raw.replace(/\r/g, '').match(/sk-ant-oat[0-9A-Za-z_-]{20,}/);
  return oat ? oat[0] : null;
};

// Never let a real token reach a log or the client error text.
const maskTokens = (s) => s.replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-***');

// Human-meaningful tail of the CLI output (for surfacing the real failure).
const tailLines = (s, n = 6) =>
  maskTokens(s)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' · ');

/** @type {Map<string, any>} */
const flows = new Map();

// SIGTERM lets pty-bridge.py run its handler (which kills the grandchild
// `claude setup-token`); a short SIGKILL fallback covers a wedged bridge.
function killBridge(f) {
  if (!f.child || f.killed) return;
  f.killed = true;
  // Windows has no signals for the bridge to relay: winpty would die and leave
  // `claude setup-token` running underneath it, so take the tree instead.
  if (isWin) { killTree(f.child.pid); return; }
  try { f.child.kill('SIGTERM'); } catch {}
  const t = setTimeout(() => { try { f.child.kill('SIGKILL'); } catch {} }, 1500);
  if (t.unref) t.unref();
}

function publicView(f) {
  return {
    id: f.id,
    state: f.state, // 'starting' | 'awaiting' | 'needs-code' | 'done' | 'error' | 'cancelled'
    url: f.url || null, // fallback authorize URL (browser usually opens on its own)
    needsCode: f.state === 'needs-code',
    error: f.error || null,
    account: f.account || null, // redacted account once created
  };
}

function emit(f) {
  broadcast({ type: 'account-auth', flow: publicView(f) });
}

export function startAuth({ label } = {}) {
  const id = 'auth_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  let child;
  try {
    const claudeBin = process.env.ARIGAMI_CLAUDE_BIN || 'claude';
    const [bin, ...args] = ptyArgs(BRIDGE, [claudeBin, 'setup-token']);
    child = spawn(bin, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    supervise(child, 'setup-token');
  } catch (e) {
    const f = { id, state: 'error', error: `could not start the pty bridge: ${e.message}` };
    return publicView(f);
  }

  const f = { id, child, buf: '', state: 'starting', url: null, error: null, account: null, label: (label || '').trim() };
  flows.set(id, f);

  const onText = (chunk) => {
    f.buf += chunk;
    const clean = stripAnsi(f.buf);
    if (!f.url) {
      const m = clean.match(AUTH_URL_RE);
      if (m) {
        f.url = m[0];
        if (f.state === 'starting') f.state = 'awaiting';
        emit(f);
      }
    }
    if (f.state !== 'done' && /paste\s+code\s+here/i.test(clean)) {
      if (f.state !== 'needs-code') {
        f.state = 'needs-code';
        emit(f);
      }
    }
    const tok = scanToken(clean);
    if (tok && f.state !== 'done') finish(f, tok);
  };

  child.stdout.on('data', (d) => onText(d.toString()));
  child.stderr.on('data', (d) => { f.stderr = ((f.stderr || '') + d).slice(-4000); });
  child.on('error', (e) => fail(f, e.message));
  child.on('close', () => {
    if (f.state === 'done' || f.state === 'cancelled' || f.state === 'error') return;
    const clean = stripAnsi(f.buf);
    // Last-chance scan: the token may have landed in the final chunk before exit.
    const tok = scanToken(clean);
    if (tok) return finish(f, tok);
    // Dump the masked CLI output so we can see WHY it exited (token-free).
    try {
      const dir = cfg.logsDir || cfg.stateDir || '.';
      fs.mkdirSync(dir, { recursive: true });
      // SAFE diagnostic: reveal only the candidate token's PREFIX + length so we
      // can tell why scanToken rejected it (wrong prefix? too short?) without
      // leaking the secret. Uses the loose maskTokens-style match on \r-stripped text.
      const flat = clean.replace(/\r/g, '');
      const cand = flat.match(/sk-ant-[A-Za-z0-9_-]{10,}/);
      const diag = cand
        ? `CANDIDATE prefix=${cand[0].slice(0, 12)} len=${cand[0].length} success=${SUCCESS_RE.test(flat)}`
        : 'NO sk-ant candidate found';
      fs.appendFileSync(path.join(dir, 'auth-debug.log'), `\n=== ${new Date().toISOString()} ${f.id} ===\n${diag}\n${maskTokens(clean)}\n`);
    } catch {}
    const why = tailLines(clean) || f.stderr?.trim();
    fail(f, why ? `setup-token exited: ${why}` : 'setup-token exited before returning a token');
  });

  f.timer = setTimeout(() => fail(f, 'timed out waiting for authorization'), TIMEOUT_MS);
  if (f.timer.unref) f.timer.unref();
  return publicView(f);
}

async function finish(f, token) {
  if (f.finishing || f.state === 'done') return; // validation is async — don't double-enter
  f.finishing = true;
  clearTimeout(f.timer);
  killBridge(f);
  // Validate BEFORE saving: setup-tokens supersede each other for the same
  // identity, so a token captured from an earlier run can already be dead by the
  // time we store it — which then silently makes sessions fall back to the
  // keychain login (looks like "new session uses the old account"). Reject a
  // dead token here instead of storing a broken account. 'unknown' (network
  // blip) is treated as OK — better to save than to lose a good token.
  let validity = 'unknown';
  try {
    const m = await import('./usage.js');
    validity = await m.validateToken(token);
  } catch {}
  if (validity === 'invalid') {
    // Safe diagnostic. Besides the captured prefix+len, dump the RAW pre-strip
    // buffer STRUCTURE around "sk-ant" — control/ESC bytes shown as \xNN, actual
    // token alphanumerics masked to 'X'. This reveals whether a char (e.g. the
    // leading 'o' of oat01) is lost in the terminal stream or in stripAnsi,
    // without leaking the secret.
    try {
      const dir = cfg.logsDir || cfg.stateDir || '.';
      fs.mkdirSync(dir, { recursive: true });
      const raw = String(f.buf || '');
      const i = raw.indexOf('sk-ant');
      const region = i >= 0 ? raw.slice(Math.max(0, i - 24), i + 130) : raw.slice(-160);
      // Control bytes → \xNN. Keep the first 16 visible chars (the non-secret
      // prefix zone: "sk-ant-oat01-.." vs "sk-ant-at01-.."); mask alnums after.
      let vis = 0;
      let struct = '';
      for (const ch of region) {
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) { struct += '\\x' + code.toString(16).padStart(2, '0'); continue; }
        vis++;
        struct += vis <= 16 ? ch : (/[A-Za-z0-9]/.test(ch) ? 'X' : ch);
      }
      fs.appendFileSync(
        path.join(dir, 'auth-debug.log'),
        `\n=== ${new Date().toISOString()} ${f.id} INVALID-TOKEN ===\ncaptured prefix=${String(token).slice(0, 12)} len=${String(token).length}\nRAW-STRUCT: ${struct}\n`,
      );
    } catch {}
    f.state = 'error';
    f.error = 'the token setup-token returned did not authenticate — creating a new token supersedes older ones for the same account. Sign out of extra Claude sessions, or retry once.';
    emit(f);
    scheduleCleanup(f);
    return;
  }
  f.state = 'done';
  try {
    f.account = addTokenAccount({ label: f.label || 'Account', token, trusted: true });
    // Fill usage/identity right away so the new account isn't blank in the UI.
    import('./usage.js').then((m) => m.refreshAccount(f.account.id)).catch(() => {});
  } catch (e) {
    f.state = 'error';
    f.error = `authenticated but could not save the account: ${e.message}`;
  }
  emit(f);
  scheduleCleanup(f);
}

function fail(f, error) {
  if (f.state === 'done' || f.state === 'cancelled') return;
  f.state = 'error';
  f.error = error || 'authentication failed';
  clearTimeout(f.timer);
  killBridge(f);
  emit(f);
  scheduleCleanup(f);
}

function scheduleCleanup(f) {
  const t = setTimeout(() => flows.delete(f.id), 60_000);
  if (t.unref) t.unref();
}

export function authStatus(id) {
  const f = flows.get(id);
  return f ? publicView(f) : { id, state: 'error', error: 'unknown auth flow', url: null, needsCode: false, account: null };
}

// Fallback path: feed the code the user copied from the browser to setup-token.
export function submitCode(id, code) {
  const f = flows.get(id);
  if (!f) return { ok: false, error: 'unknown auth flow' };
  if (f.state === 'done') return { ok: true };
  try {
    f.child.stdin.write(String(code).trim() + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function cancelAuth(id) {
  const f = flows.get(id);
  if (!f) return { ok: true };
  f.state = 'cancelled';
  clearTimeout(f.timer);
  killBridge(f);
  scheduleCleanup(f);
  return { ok: true };
}
