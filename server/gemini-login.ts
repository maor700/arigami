// Signing the machine's `agy` in from the cockpit (provider `gemini`, account type `gemini-home`).
// agy owns the whole exchange and its token file: the host only presses Enter on "Google OAuth", shows the link agy prints, and types the pasted code.
// Measured on agy 1.5.14: a signed-out `agy` shows "Select login method" (1. Google OAuth), then an authorize link
// (redirect = antigravity.google/oauth-callback, which shows a code) and waits for that code on its input.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { supervise, killTree } from './lib/children.js';
import { ptyArgs, isWin } from './lib/platform.js';
import { resourceRoot } from './lib/resource-root.js';
import { broadcast } from './bus.js';
import { adoptLocalLogins, getActiveId } from './accounts.js';
import { geminiTokenFile } from './lib/gemini-home.js';
import { findAgy, AGY_MISSING } from './lib/gemini-cli.js';

const BRIDGE = path.join(resourceRoot(), 'server', 'lib', 'pty-bridge.py');
const LOGIN_TIMEOUT_MS = Number(process.env.ARIGAMI_GEMINI_LOGIN_TIMEOUT_MS) || 15 * 60_000;
const MENU_TIMEOUT_MS = Number(process.env.ARIGAMI_GEMINI_LOGIN_MENU_MS) || 12_000;
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
  menuAnswered: boolean;
  before: string;
  timer?: ReturnType<typeof setTimeout>;
  watch?: ReturnType<typeof setInterval>;
}

const flows = new Map<string, Flow>();

const stripAnsi = (s: string): string => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '');

/** Pure: the Google authorize link in agy's output — the terminal hyperlink carries it whole; the printed text may be wrapped. */
export function parseAgyLogin(raw: string): { menu: boolean; url: string | null } {
  const text = String(raw || '');
  const link = /\x1b\]8;[^;\x07\x1b]*;(https:\/\/accounts\.google\.com\/[^\x07\x1b\s]+)/.exec(text);
  const plain = link ? null : /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s\x07\x1b]+/.exec(stripAnsi(text));
  return { menu: /Select login method/i.test(stripAnsi(text)), url: link?.[1] || plain?.[0] || null };
}

/** Pure: what the human pasted → the authorization code, or null. It is typed into a terminal, so nothing but code characters passes. */
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
  if (child) {
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

/** agy wrote its token file: stop it before its chat opens, adopt the account, fill its usage. */
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

const tail = (f: Flow): string => stripAnsi(f.buf).split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^[─▄▀\s]+$/.test(l)).slice(-2).join(' · ').slice(0, 300);

/** Start agy's own Google sign-in. One at a time; the link arrives on the next broadcast (or loginStatus()). */
export function startGeminiLogin() {
  for (const other of flows.values()) if (other.state === 'starting' || other.state === 'awaiting' || other.state === 'verifying') cancelGeminiLogin(other.id);
  const id = 'agy_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const f: Flow = { id, provider: 'gemini', state: 'starting', url: null, error: null, account: null, buf: '', menuAnswered: false, before: fingerprint() };
  flows.set(id, f);
  const agy = findAgy();
  if (!agy || (path.isAbsolute(agy) && !fs.existsSync(agy))) { fail(f, AGY_MISSING); return publicView(f); }
  try {
    const [bin, ...args] = ptyArgs(BRIDGE, [agy]);
    // BROWSER=true: agy must not try to open a browser on the host.
    const child = spawn(bin, args, { env: { ...process.env, BROWSER: 'true' }, stdio: ['pipe', 'pipe', 'pipe'] });
    supervise(child, 'gemini-login');
    f.child = child;
    const onText = (chunk: Buffer) => {
      f.buf = (f.buf + chunk.toString()).slice(-16000);
      if (f.state !== 'starting') return;
      const seen = parseAgyLogin(f.buf);
      if (seen.menu && !f.menuAnswered) {
        f.menuAnswered = true;
        try { child.stdin!.write('\r'); } catch {} // "1. Google OAuth" is the highlighted row
      }
      if (seen.url) {
        f.url = seen.url;
        f.state = 'awaiting';
        emit(f);
      }
    };
    child.stdout!.on('data', onText);
    child.stderr!.on('data', onText);
    child.on('error', (e) => fail(f, `could not start agy: ${e.message}`));
    child.on('close', (code) => {
      if (signedIn(f)) return finish(f);
      const said = tail(f);
      fail(f, said ? `agy exited (${code}): ${said}` : `agy exited (${code}) without signing in`);
    });
    // No sign-in menu: agy came up already signed in (its chat opened) — nothing to do but say so.
    const menu = setTimeout(() => {
      if (f.state !== 'starting') return;
      if (!f.menuAnswered && f.before) finish(f);
      else fail(f, 'agy did not offer a sign-in link');
    }, MENU_TIMEOUT_MS);
    if (menu.unref) menu.unref();
    f.timer = setTimeout(() => fail(f, 'timed out waiting for the browser sign-in'), LOGIN_TIMEOUT_MS);
    if (f.timer.unref) f.timer.unref();
  } catch (e) {
    fail(f, `could not start the Gemini sign-in: ${(e as Error).message}`);
  }
  return publicView(f);
}

/** Type the pasted authorization code into agy and wait for it to write its token file. */
export function submitGeminiCode(id: string, input: unknown): { ok: boolean; state?: FlowState; error?: string } {
  const f = flows.get(id);
  if (!f) return { ok: false, error: 'unknown login flow' };
  if (f.state === 'done') return { ok: true, state: 'done' };
  if (f.state !== 'awaiting') return { ok: false, error: `login is ${f.state}` };
  const code = cleanAuthCode(input);
  if (!code) return { ok: false, error: 'paste the authorization code Google showed after you signed in' };
  try {
    f.child!.stdin!.write(code + '\r');
  } catch (e) {
    return { ok: false, error: `could not hand the code to agy: ${(e as Error).message}` };
  }
  f.state = 'verifying';
  const since = Date.now();
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
