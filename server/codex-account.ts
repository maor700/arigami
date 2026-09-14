// Codex (OpenAI) accounts — the provider module behind `provider: 'codex'` in
// server/accounts.js: how a login is MINTED, how it is VALIDATED, and how its
// identity and quota are READ. The claude twins are server/oauth-login.js
// (mint) and server/usage.js (read); this file is what a third provider would
// copy.
//
// Minting. Two ways in, both driven by the codex CLI itself so the auth.json
// format stays whatever the installed codex expects:
//   - browser : `codex login` prints an authorize URL and serves the OAuth
//               callback on 127.0.0.1:1455; the human signs in, the callback
//               lands (or is pasted back and forwarded — see LOOPBACK below),
//               the process exits 0 and auth.json appears in $CODEX_HOME.
//   - paste   : `codex login --with-api-key` reads the key from stdin and
//               writes auth.json. It does NOT validate the key (a bogus key is
//               "Successfully logged in" — measured), so validateApiKey() asks
//               the OpenAI API first.
// Each flow runs in its own pending $CODEX_HOME under codex-accounts/; on
// success accounts.js adopts the directory as the account's home.
//
// Reading. `codex app-server` (JSON-RPC over stdio) answers `account/read`
// (email, plan) and `account/rateLimits/read` (used %, window, reset) without
// spending a turn — the same numbers the TUI's /status shows. One short-lived
// app-server process per probe, under the account's own $CODEX_HOME.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { supervise, killTree } from './lib/children.js';
import { ptyArgs, isWin } from './lib/platform.js';
import { resourceRoot } from './lib/resource-root.js';
import { broadcast } from './bus.js';
import { addCodexAccount, codexHomeOfAccount, getAccount, CODEX_ACCOUNTS_DIR } from './accounts.js';

const codexBin = (): string => process.env.ARIGAMI_CODEX_BIN || 'codex';
// `codex login --device-auth` block-buffers stdout when it is not a terminal:
// the URL and code only reach a pipe when the process EXITS (measured — 20s of
// nothing after the first warning line). Under a pty they arrive in 0.1s. So
// the login runs under the same pty relay `claude setup-token` uses
// (server/lib/pty-bridge.py on POSIX, winpty on Windows — platform.ptyArgs).
const BRIDGE = path.join(resourceRoot(), 'server', 'lib', 'pty-bridge.py');
// The pty makes codex colour its output — strip CSI/OSC before matching.
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '');
/** Hard ceiling on a browser login flow (the authorize URL's own state expires around then too). */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const APP_SERVER_TIMEOUT_MS = Number(process.env.ARIGAMI_CODEX_PROBE_TIMEOUT_MS) || 20_000;

// ---- app-server client ------------------------------------------------------

export interface RpcCall {
  method: string;
  params?: unknown;
}
export type RpcResults = Record<string, { result?: any; error?: any }>;

/**
 * Start `codex app-server` under `home`, run the initialize handshake, send
 * every call, collect the responses, and stop the process. Results are keyed
 * by method. Never throws on a per-call error (it lands under `error`); throws
 * only when the process itself cannot be started or answers nothing in time.
 */
export function appServerCall(home: string, calls: RpcCall[], timeoutMs = APP_SERVER_TIMEOUT_MS): Promise<RpcResults> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(codexBin(), ['app-server'], {
        env: { ...process.env, CODEX_HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      supervise(child, 'codex-probe');
    } catch (e) {
      reject(e);
      return;
    }
    const out: RpcResults = {};
    const pending = new Map<number, string>();
    let buf = '';
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin?.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      const t = setTimeout(() => killTree(child.pid), 1500);
      if (t.unref) t.unref();
      if (err) reject(err);
      else resolve(out);
    };
    const timer = setTimeout(() => finish(new Error('codex app-server did not answer in time')), timeoutMs);
    if (timer.unref) timer.unref();
    const send = (o: unknown) => {
      try { child.stdin!.write(JSON.stringify(o) + '\n'); } catch (e) { finish(e as Error); }
    };
    child.on('error', (e) => finish(e));
    child.on('close', () => {
      if (!done) finish(pending.size ? new Error('codex app-server exited before answering') : undefined);
    });
    child.stdout!.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        if (typeof j?.id !== 'number') continue; // a notification (configWarning, remoteControl…) — not ours
        if (j.id === 0) {
          // initialize answered → the handshake is done, fire the real calls.
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          calls.forEach((c, i) => {
            pending.set(i + 1, c.method);
            send({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params ?? {} });
          });
          if (!calls.length) finish();
          continue;
        }
        const method = pending.get(j.id);
        if (!method) continue;
        pending.delete(j.id);
        out[method] = j.error ? { error: j.error } : { result: j.result };
        if (!pending.size) finish();
      }
    });
    child.stderr!.on('data', () => {}); // the sandbox warning and friends — irrelevant here
    send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { clientInfo: { name: 'arigami', title: 'Arigami', version: '1' }, capabilities: { experimentalApi: true } },
    });
  });
}

// ---- reads -----------------------------------------------------------------

export interface CodexWindow {
  pct: number;
  resetsAt: string | null;
  /** the window's length in minutes (300 = 5h, 10080 = a week, 43200 = 30 days) */
  windowMins: number | null;
}
export interface CodexUsage {
  available: boolean;
  reason?: string;
  /** primary window — the short one on paid plans, the only one on free */
  session?: CodexWindow | null;
  /** secondary (longer) window, when the plan has one */
  week?: CodexWindow | null;
  plan?: string | null;
  limitReached?: string | null;
  credits?: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
  fetchedAt?: number;
}

const toWindow = (w: any): CodexWindow | null =>
  w && typeof w.usedPercent === 'number'
    ? {
        pct: Math.round(w.usedPercent),
        // codex reports unix SECONDS; the cockpit's untilTime() takes ms or ISO.
        resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null,
        windowMins: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
      }
    : null;

/** Pure: the `account/rateLimits/read` result → the shape usage.js/the cockpit already speak. */
export function normalizeCodexRateLimits(result: any): CodexUsage {
  const rl = result?.rateLimits;
  if (!rl) return { available: false, reason: 'no-rate-limits' };
  return {
    available: true,
    session: toWindow(rl.primary),
    week: toWindow(rl.secondary),
    plan: rl.planType || null,
    limitReached: rl.rateLimitReachedType || null,
    credits: rl.credits
      ? { hasCredits: !!rl.credits.hasCredits, unlimited: !!rl.credits.unlimited, balance: rl.credits.balance ?? null }
      : null,
    fetchedAt: Date.now(),
  };
}

/** Identity of the login under `home`: email + plan for ChatGPT logins, just the auth mode for API keys. */
export async function codexIdentity(home: string): Promise<{ email: string | null; plan: string | null; authMode: string | null }> {
  const r = await appServerCall(home, [{ method: 'account/read', params: { refreshToken: false } }]);
  const acc = r['account/read']?.result?.account || null;
  return {
    email: acc?.email || null,
    plan: acc?.planType || null,
    authMode: acc?.type || null,
  };
}

/** Usage for a codex account. Never throws. API-key logins have no windows — the key is billed per use. */
export async function codexUsage(accountId: string): Promise<CodexUsage> {
  const a = getAccount(accountId);
  const home = codexHomeOfAccount(a);
  if (!home || !fs.existsSync(path.join(home, 'auth.json'))) return { available: false, reason: 'no-credentials' };
  if (a.type === 'api-key') return { available: false, reason: 'api-key' };
  try {
    const r = await appServerCall(home, [{ method: 'account/rateLimits/read', params: {} }]);
    const call = r['account/rateLimits/read'];
    if (call?.error) {
      const msg = String(call.error?.message || '');
      return { available: false, reason: /401|unauthori|not logged|expired/i.test(msg) ? 'http-401' : 'unavailable' };
    }
    return normalizeCodexRateLimits(call?.result);
  } catch {
    return { available: false, reason: 'fetch-failed' };
  }
}

/**
 * Is this OpenAI API key real? `codex login --with-api-key` accepts anything,
 * so ask the API. Only a 401 says 'invalid'; a network blip is 'unknown' and
 * is treated like claude's — save rather than lose a good key.
 */
export async function validateApiKey(key: string): Promise<'valid' | 'invalid' | 'unknown'> {
  if (!key) return 'invalid';
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'valid';
    if (res.status === 401) return 'invalid';
    return 'valid'; // 403/429/5xx: the key authenticated, the rest is not our question
  } catch {
    return 'unknown';
  }
}

// ---- minting ---------------------------------------------------------------

// The standard `codex login` (browser) flow: codex prints an authorize URL
// (PKCE, its own client id) and serves the OAuth callback on 127.0.0.1:1455 —
// a loopback on the HOST. Two ways the callback reaches it:
//   - the human signs in from a browser ON this machine (the session desktop,
//     a local install): the redirect lands by itself, codex writes auth.json;
//   - the human signs in from their own laptop/phone: the browser is sent to
//     http://localhost:1455/auth/callback?code=…&state=… — which cannot load
//     THERE. The cockpit asks for that page's address (or just the code), and
//     the host forwards it to the loopback itself (submitCallback). Verified:
//     the loopback answers "State mismatch" for a wrong state and completes
//     for the right one, so codex still owns the exchange and the file format.
// `codex login --device-auth` would avoid the paste-back, but ChatGPT
// workspaces can have device-code auth disabled ("contact your workspace
// admin") — the owner's did, so it is not the default path.
const LOOPBACK = 'http://127.0.0.1:1455/auth/callback';

/** Pure: the authorize URL (and its `state`) out of `codex login`'s output (pty-coloured or plain). */
export function parseBrowserLogin(raw: string): { url: string | null; state: string | null } {
  const text = stripAnsi(raw).replace(/\r/g, '');
  const url = text.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s'"]+/)?.[0] || null;
  let state: string | null = null;
  if (url) {
    try { state = new URL(url).searchParams.get('state'); } catch { /* unparsable — no state */ }
  }
  return { url, state };
}

/**
 * Pure: what the human pasted back → {code, state}. Accepts the full callback
 * address (`http://localhost:1455/auth/callback?code=…&state=…`), a bare
 * `code=…&state=…` query, or just the code (state then comes from the flow).
 */
export function parseCallback(input: string): { code: string | null; state: string | null } {
  const s = String(input || '').trim();
  if (!s) return { code: null, state: null };
  const q = s.includes('?') ? s.slice(s.indexOf('?') + 1) : s;
  if (/(^|&)code=/.test(q)) {
    const p = new URLSearchParams(q.replace(/#.*$/, ''));
    return { code: p.get('code'), state: p.get('state') };
  }
  return { code: /^[A-Za-z0-9._~-]{8,}$/.test(s) ? s : null, state: null };
}

interface Flow {
  id: string;
  provider: 'codex';
  state: 'starting' | 'awaiting' | 'verifying' | 'done' | 'error' | 'cancelled';
  label: string;
  dir: string;
  url: string | null;
  oauthState: string | null;
  error: string | null;
  account: any;
  child?: ReturnType<typeof spawn>;
  buf: string;
  timer?: ReturnType<typeof setTimeout>;
}

const flows = new Map<string, Flow>();

const publicView = (f: Flow) => ({
  id: f.id,
  provider: f.provider,
  state: f.state,
  url: f.url,
  // The human pastes the callback address back when their browser is not on
  // this machine; when it is, the flow completes on its own and this is moot.
  needsCode: f.state === 'awaiting',
  error: f.error,
  account: f.account,
});

const emit = (f: Flow) => broadcast({ type: 'account-auth', flow: publicView(f) });

function pendingDir(id: string): string {
  const dir = path.join(CODEX_ACCOUNTS_DIR, `.pending-${id}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function dropDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function scheduleCleanup(f: Flow): void {
  const t = setTimeout(() => flows.delete(f.id), 60_000);
  if (t.unref) t.unref();
}

// SIGTERM lets pty-bridge.py run its handler (which kills the grandchild
// `codex login`); Windows has no signals for winpty to relay, so take the tree.
function killLogin(f: Flow): void {
  if (!f.child) return;
  if (isWin) { killTree(f.child.pid); return; }
  try { f.child.kill('SIGTERM'); } catch {}
  const t = setTimeout(() => { try { f.child?.kill('SIGKILL'); } catch {} }, 1500);
  if (t.unref) t.unref();
}

function fail(f: Flow, error: string): void {
  if (f.state === 'done' || f.state === 'cancelled') return;
  f.state = 'error';
  f.error = error;
  if (f.timer) clearTimeout(f.timer);
  killLogin(f);
  dropDir(f.dir);
  emit(f);
  scheduleCleanup(f);
}

/** Adopt the auth.json a finished login left in `f.dir` — identity probe, then the account record. */
async function adopt(f: Flow, type: 'chatgpt' | 'api-key'): Promise<void> {
  f.state = 'verifying';
  emit(f);
  let ident: { email: string | null; plan: string | null; authMode: string | null } = { email: null, plan: null, authMode: null };
  if (type === 'chatgpt') {
    try {
      ident = await codexIdentity(f.dir);
    } catch (e) {
      // The login file is there; an identity probe that cannot run (no app-server on
      // this codex build, a hiccup) must not throw the login away. Same posture as
      // claude's 'unknown' validity: save, and let the usage poller fill the rest.
      console.warn(`[codex-account] identity probe failed for ${f.id}: ${(e as Error).message}`);
    }
  }
  try {
    f.account = addCodexAccount({ label: f.label, type, pendingDir: f.dir, email: ident.email, plan: ident.plan });
    f.state = 'done';
    // Fill usage right away so the new card isn't blank until the next poll.
    import('./usage.js').then((m: any) => m.refreshAccount(f.account.id)).catch(() => {});
  } catch (e) {
    f.state = 'error';
    f.error = `signed in but could not save the account: ${(e as Error).message}`;
    dropDir(f.dir);
  }
  emit(f);
  scheduleCleanup(f);
}

/**
 * Start `codex login` in a fresh pending home. Returns the flow view; the
 * authorize URL arrives on the next broadcast (or via loginStatus()). The
 * human opens it and signs in as the account to add; the callback lands on
 * the loopback (by itself, or forwarded by submitCallback), codex writes
 * auth.json and exits; adopt() does the rest. One login at a time: the
 * loopback port is fixed, so a still-pending flow is cancelled first.
 */
export function startBrowserLogin({ label }: { label?: string } = {}) {
  for (const other of flows.values()) {
    if (other.state === 'starting' || other.state === 'awaiting') cancelLogin(other.id);
  }
  const id = 'cdx_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const f: Flow = { id, provider: 'codex', state: 'starting', label: (label || '').trim(), dir: '', url: null, oauthState: null, error: null, account: null, buf: '' };
  flows.set(id, f);
  try {
    f.dir = pendingDir(id);
    const [bin, ...args] = ptyArgs(BRIDGE, [codexBin(), 'login']);
    const child = spawn(bin, args, {
      env: { ...process.env, CODEX_HOME: f.dir, NO_COLOR: '1', BROWSER: 'true' }, // BROWSER=true: never try to open a browser on the host
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    supervise(child, 'codex-login');
    f.child = child;
    const onText = (chunk: Buffer) => {
      f.buf = (f.buf + chunk.toString()).slice(-8000);
      if (f.state !== 'starting') return;
      const { url, state } = parseBrowserLogin(f.buf);
      if (url) {
        f.url = url;
        f.oauthState = state;
        f.state = 'awaiting';
        emit(f);
      }
    };
    child.stdout!.on('data', onText);
    child.stderr!.on('data', onText);
    child.on('error', (e) => fail(f, `could not start codex: ${e.message}`));
    child.on('close', (code) => {
      if (f.state === 'cancelled' || f.state === 'error') return;
      if (fs.existsSync(path.join(f.dir, 'auth.json'))) { void adopt(f, 'chatgpt'); return; }
      const tail = stripAnsi(f.buf).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' · ');
      fail(f, tail ? `codex login exited (${code}): ${tail}` : `codex login exited (${code}) without signing in`);
    });
    f.timer = setTimeout(() => fail(f, 'timed out waiting for the browser sign-in'), LOGIN_TIMEOUT_MS);
    if (f.timer.unref) f.timer.unref();
  } catch (e) {
    fail(f, `could not start codex login: ${(e as Error).message}`);
  }
  return publicView(f);
}

/**
 * The paste-back half: forward the callback the human's browser could not
 * deliver to codex's loopback. Codex checks the state, exchanges the code,
 * writes auth.json and exits — the close handler adopts the account.
 */
export async function submitCallback(id: string, input: string): Promise<{ ok: boolean; error?: string }> {
  const f = flows.get(id);
  if (!f) return { ok: false, error: 'unknown login flow' };
  if (f.state === 'done') return { ok: true };
  if (f.state !== 'awaiting') return { ok: false, error: `login is ${f.state}` };
  const { code, state } = parseCallback(input);
  if (!code) return { ok: false, error: 'paste the address of the page you landed on after signing in (it starts with http://localhost:1455/…), or the code from it' };
  const st = state || f.oauthState;
  if (!st) return { ok: false, error: 'the callback has no state — paste the whole address, not just the code' };
  try {
    const res = await fetch(`${LOOPBACK}?${new URLSearchParams({ code, state: st })}`, { signal: AbortSignal.timeout(30_000), redirect: 'manual' });
    if (res.status >= 400) {
      const body = (await res.text().catch(() => '')).trim();
      return { ok: false, error: body ? `codex refused the callback: ${body}` : `codex refused the callback (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not reach codex's login server: ${(e as Error).message}` };
  }
}

export function loginStatus(id: string) {
  const f = flows.get(id);
  return f ? publicView(f) : { id, provider: 'codex', state: 'error', url: null, needsCode: false, error: 'unknown login flow', account: null };
}

export function cancelLogin(id: string) {
  const f = flows.get(id);
  if (!f) return { ok: true };
  if (f.state === 'done') return { ok: true };
  f.state = 'cancelled';
  if (f.timer) clearTimeout(f.timer);
  killLogin(f);
  dropDir(f.dir);
  emit(f);
  scheduleCleanup(f);
  return { ok: true };
}

/**
 * The paste path: validate the key against the API, then let codex write the
 * auth.json for it and adopt the directory. Throws on an invalid key.
 */
export async function addApiKeyAccount({ label, key }: { label?: string; key: string }) {
  const k = String(key || '').trim();
  if (!/^sk-/.test(k)) throw new Error('that does not look like an OpenAI API key (sk-…)');
  const validity = await validateApiKey(k);
  if (validity === 'invalid') throw new Error('OpenAI rejected this API key (401) — check it and try again');
  const id = 'cdx_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const dir = pendingDir(id);
  const written = await new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(codexBin(), ['login', '--with-api-key'], { env: { ...process.env, CODEX_HOME: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
      supervise(child, 'codex-login');
    } catch {
      resolve(false);
      return;
    }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(false); }, 20_000);
    if (t.unref) t.unref();
    child.on('error', () => { clearTimeout(t); resolve(false); });
    child.on('close', () => { clearTimeout(t); resolve(fs.existsSync(path.join(dir, 'auth.json'))); });
    child.stdout!.on('data', () => {});
    child.stderr!.on('data', () => {});
    try { child.stdin!.end(k + '\n'); } catch { /* close handles it */ }
  });
  if (!written) {
    // No codex binary (yet) — write the file the CLI itself writes for this
    // mode (verified on 0.153.4), so the account can be added before codex is
    // installed and works the moment it is.
    try { fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: k }, null, 2) + '\n', { mode: 0o600 }); } catch (e) {
      dropDir(dir);
      throw new Error(`could not store the key: ${(e as Error).message}`);
    }
  }
  try {
    return addCodexAccount({ label, type: 'api-key', pendingDir: dir });
  } catch (e) {
    dropDir(dir);
    throw e;
  }
}
