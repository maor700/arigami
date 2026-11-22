// Signing the machine's `agy` in from the cockpit (provider `gemini`, account type `gemini-home`).
// agy owns the whole exchange and its token file: the host shows the link agy prints and hands it the pasted code on stdin.
// Measured on agy 1.5.14: `agy acp --login [--gemini-dir <home>]` needs no terminal — it prints the Google authorize link
// (redirect = antigravity.google/oauth-callback, which shows a code), reads the code from stdin, and exits non-zero with
// one line on a refused code or an empty input. It asks even when already signed in and leaves the old login until the new one lands.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { supervise, killTree } from './lib/children.js';
import { isWin } from './lib/platform.js';
import { broadcast } from './bus.js';
import { adoptLocalLogins, getActiveId } from './accounts.js';
import { geminiTokenFile } from './lib/gemini-home.js';
import { findAgy, agyAcpArgs, AGY_MISSING } from './lib/gemini-cli.js';

const LOGIN_TIMEOUT_MS = Number(process.env.ARIGAMI_GEMINI_LOGIN_TIMEOUT_MS) || 15 * 60_000;
const LINK_TIMEOUT_MS = Number(process.env.ARIGAMI_GEMINI_LOGIN_LINK_MS) || 30_000;
const EXCHANGE_TIMEOUT_MS = Number(process.env.ARIGAMI_GEMINI_LOGIN_EXCHANGE_MS) || 90_000;

type FlowState = 'starting' | 'awaiting' | 'verifying' | 'done' | 'error' | 'cancelled';
interface Flow {
  id: string;
  provider: 'gemini';
  state: FlowState;
  url: string | null;
  error: string | null;
  account: any;
  child?: ReturnType<typeof spawn>;
  buf: string;
  before: string;
  timer?: ReturnType<typeof setTimeout>;
  watch?: ReturnType<typeof setInterval>;
}

const flows = new Map<string, Flow>();

const stripAnsi = (s: string): string => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '');

/** Pure: the Google authorize link in agy's output (a terminal hyperlink, when there is one, carries it unwrapped). */
export function parseAgyLogin(raw: string): { url: string | null } {
  const text = String(raw || '');
  const link = /\x1b\]8;[^;\x07\x1b]*;(https:\/\/accounts\.google\.com\/[^\x07\x1b\s]+)/.exec(text);
  const plain = link ? null : /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s\x07\x1b]+/.exec(stripAnsi(text));
  return { url: link?.[1] || plain?.[0] || null };
}

/** Pure: what the human pasted → the authorization code, or null. It goes to a CLI's input, so nothing but code characters passes. */
export function cleanAuthCode(input: unknown): string | null {
  let s = String(input ?? '').trim();
  const fromUrl = /[?&]code=([^&#\s]+)/.exec(s);
  if (fromUrl) { try { s = decodeURIComponent(fromUrl[1]); } catch { return null; } }
  return /^[A-Za-z0-9._~\/+=-]{8,512}$/.test(s) ? s : null;
}

const fingerprint = (): string => {
  try { const st = fs.statSync(geminiTokenFile()); return `${st.size}:${st.mtimeMs}`; } catch { return ''; }
};
const signedIn = (f: Flow): boolean => { const now = fingerprint(); return !!now && now !== f.before && !now.startsWith('0:'); };

const publicView = (f: Flow) => ({ id: f.id, provider: f.provider, state: f.state, url: f.url, needsCode: f.state === 'awaiting', error: f.error, account: f.account });
const emit = (f: Flow) => broadcast({ type: 'account-auth', flow: publicView(f) });

function stop(f: Flow): void {
  if (f.timer) clearTimeout(f.timer);
  if (f.watch) clearInterval(f.watch);
  const child = f.child;
  if (child && child.exitCode === null) {
    if (isWin) killTree(child.pid);
    else {
      try { child.kill('SIGTERM'); } catch {}
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500);
      if (t.unref) t.unref();
    }
  }
  const t = setTimeout(() => flows.delete(f.id), 60_000);
  if (t.unref) t.unref();
}

function fail(f: Flow, error: string): void {
  if (f.state === 'done' || f.state === 'cancelled' || f.state === 'error') return;
  f.state = 'error';
  f.error = error;
  stop(f);
  emit(f);
}

/** agy wrote its token file: stop it, adopt the account, fill its usage. */
function finish(f: Flow): void {
  if (f.state === 'done' || f.state === 'cancelled' || f.state === 'error') return;
  f.state = 'done';
  stop(f);
  try {
    adoptLocalLogins();
    const id = getActiveId('gemini');
    f.account = id ? { id, provider: 'gemini' } : null;
    if (id) import('./usage.js').then((m: any) => m.refreshAccount(id)).catch(() => {});
  } catch {}
  emit(f);
}

/** agy's last line that is not the link or its own prompt — what it said went wrong. */
const tail = (f: Flow): string =>
  stripAnsi(f.buf).split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^https:\/\//.test(l) && !/^(Open this link|Then paste)/i.test(l)).slice(-1).join('').slice(0, 300);

/** Start agy's own Google sign-in. One at a time; the link arrives on the next broadcast (or geminiLoginStatus()). */
export function startGeminiLogin() {
  for (const other of flows.values()) if (other.state === 'starting' || other.state === 'awaiting' || other.state === 'verifying') cancelGeminiLogin(other.id);
  const id = 'agy_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const f: Flow = { id, provider: 'gemini', state: 'starting', url: null, error: null, account: null, buf: '', before: fingerprint() };
  flows.set(id, f);
  const agy = findAgy();
  if (!agy || (path.isAbsolute(agy) && !fs.existsSync(agy))) { fail(f, AGY_MISSING); return publicView(f); }
  try {
    // BROWSER=true: agy must not try to open a browser on the host. agyAcpArgs carries --gemini-dir for an overridden home.
    const child = spawn(agy, agyAcpArgs(process.env, ['--login']), { env: { ...process.env, BROWSER: 'true' }, stdio: ['pipe', 'pipe', 'pipe'] });
    supervise(child, 'gemini-login');
    f.child = child;
    const onText = (chunk: Buffer) => {
      f.buf = (f.buf + chunk.toString()).slice(-16000);
      if (f.state !== 'starting') return;
      const { url } = parseAgyLogin(f.buf);
      if (!url) return;
      f.url = url;
      f.state = 'awaiting';
      emit(f);
    };
    child.stdout!.on('data', onText);
    child.stderr!.on('data', onText);
    child.stdin!.on('error', () => {}); // agy may be gone by the time a code is written
    child.on('error', (e) => fail(f, `could not start agy: ${e.message}`));
    child.on('close', (code) => {
      if (signedIn(f)) return finish(f);
      const said = tail(f);
      fail(f, said ? `agy: ${said}` : `agy exited (${code}) without signing in`);
    });
    const link = setTimeout(() => { if (f.state === 'starting') fail(f, 'agy did not offer a sign-in link'); }, LINK_TIMEOUT_MS);
    if (link.unref) link.unref();
    f.timer = setTimeout(() => fail(f, 'timed out waiting for the browser sign-in'), LOGIN_TIMEOUT_MS);
    if (f.timer.unref) f.timer.unref();
  } catch (e) {
    fail(f, `could not start the Gemini sign-in: ${(e as Error).message}`);
  }
  return publicView(f);
}

/** Hand the pasted authorization code to agy and wait for it to write its token file. */
export function submitGeminiCode(id: string, input: unknown): { ok: boolean; state?: FlowState; error?: string } {
  const f = flows.get(id);
  if (!f) return { ok: false, error: 'unknown login flow' };
  if (f.state === 'done') return { ok: true, state: 'done' };
  if (f.state !== 'awaiting') return { ok: false, error: `login is ${f.state}` };
  const code = cleanAuthCode(input);
  if (!code) return { ok: false, error: 'paste the authorization code Google showed after you signed in' };
  try {
    f.child!.stdin!.write(code + '\n');
  } catch (e) {
    return { ok: false, error: `could not hand the code to agy: ${(e as Error).message}` };
  }
  f.state = 'verifying';
  const since = Date.now();
  // A refused code ends agy at once (the close handler reports it); this only catches a silent hang.
  f.watch = setInterval(() => {
    if (signedIn(f)) return finish(f);
    if (Date.now() - since > EXCHANGE_TIMEOUT_MS) fail(f, `agy did not accept the code${tail(f) ? `: ${tail(f)}` : ''}`);
  }, 400);
  if (f.watch.unref) f.watch.unref();
  emit(f);
  return { ok: true, state: 'verifying' };
}

export function geminiLoginStatus(id: string) {
  const f = flows.get(id);
  return f ? publicView(f) : { id, provider: 'gemini', state: 'error', url: null, needsCode: false, error: 'unknown login flow', account: null };
}

export function cancelGeminiLogin(id: string) {
  const f = flows.get(id);
  if (!f || f.state === 'done' || f.state === 'error' || f.state === 'cancelled') return { ok: true };
  f.state = 'cancelled';
  stop(f);
  emit(f);
  return { ok: true };
}
