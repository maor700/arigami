// Per-session Chrome (T8 §3-4): every session that opens a browser gets its
// own `--user-data-dir`, cloned from `<ARIGAMI_DIR>/chrome-base/` on first use —
// a shared profile can't work (Chrome locks it), but a shared LOGIN STATE
// should. So each session works on its own copy, and cookies/saved
// logins/local storage sync back to the base copy (a) right after a
// request_screen resolves with takenOver:true, and (b) at session delete —
// so the NEXT session's clone starts already logged in. Last-writer-wins,
// under a lock (see withLock) so two sessions closing at once can't
// interleave writes into chrome-base.
//
// Never `pkill chrome` — every session runs its own instance on its own
// X display; killing one by pid (closeChrome) never touches another
// session's or the global desktop's browser.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ARIGAMI_DIR } from './instance.js';
import { supervise, killTree } from './children.js';
import * as state from '../state.js';
import { ensureDesktop } from './desktops.js';

export const CHROME_BASE_DIR = path.join(ARIGAMI_DIR, 'chrome-base');
export const CHROME_SESSIONS_DIR = path.join(ARIGAMI_DIR, 'chrome-sessions');

export function chromeSessionDir(sessionId: string): string {
  return path.join(CHROME_SESSIONS_DIR, sessionId);
}

function ensureBase(): void {
  fs.mkdirSync(CHROME_BASE_DIR, { recursive: true });
}

// First open only — an existing copy is left alone so a session's own
// in-progress browsing (open tabs, a login mid-flow) survives a restart.
function ensureSessionProfile(sessionId: string): string {
  const dir = chromeSessionDir(sessionId);
  if (!fs.existsSync(dir)) {
    ensureBase();
    fs.mkdirSync(CHROME_SESSIONS_DIR, { recursive: true });
    fs.cpSync(CHROME_BASE_DIR, dir, { recursive: true });
  }
  return dir;
}

const running = new Map<string, ChildProcess>();

// B2/§7.4: the browser binary is abstracted behind CHROME_BIN — google-chrome
// on amd64, chromium on arm64 (the Docker image and install.sh both set it).
export function chromeBin(): string {
  return process.env.CHROME_BIN || 'google-chrome';
}

// Inside a container the host runs as an unprivileged user without user
// namespaces, so Chrome's sandbox cannot start; `--no-sandbox` is the
// documented answer (compose gives it a 1g /dev/shm instead of SYS_ADMIN).
// Detected via /.dockerenv (or an explicit CHROME_NO_SANDBOX=1) — never on a
// native host.
export function chromeExtraFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  const inDocker = env.CHROME_NO_SANDBOX === '1' || fs.existsSync('/.dockerenv');
  return inDocker ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : [];
}

export function isChromeRunning(sessionId: string): boolean {
  const p = running.get(sessionId);
  return !!(p && p.exitCode === null && !p.killed);
}

/** Open (or report already-open) this session's Chrome, on its own desktop and profile copy. */
export async function openChrome(sessionId: string, url?: string): Promise<{ display: string; pid: number; alreadyRunning: boolean }> {
  const s = state.getSession(sessionId);
  if (!s) throw new Error(`unknown session: ${sessionId}`);
  const { display } = await ensureDesktop(sessionId);
  const existing = running.get(sessionId);
  if (existing && isChromeRunning(sessionId)) return { display, pid: existing.pid!, alreadyRunning: true };

  const profileDir = ensureSessionProfile(sessionId);
  const args = [
    `--user-data-dir=${profileDir}`,
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    ...(url ? [url] : []),
  ];
  const child = spawn(chromeBin(), chromeExtraFlags().concat(args), {
    env: { ...process.env, DISPLAY: display },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  supervise(child, `browser:${sessionId}`);
  child.on('exit', () => { if (running.get(sessionId) === child) running.delete(sessionId); });
  running.set(sessionId, child);
  return { display, pid: child.pid!, alreadyRunning: false };
}

/** Kill THIS session's Chrome, if running — never touches any other process. */
export function closeChrome(sessionId: string): void {
  const child = running.get(sessionId);
  if (!child) return;
  killTree(child.pid);
  running.delete(sessionId);
}

// ---- Sync back to chrome-base (T8 §4) ---------------------------------------

const SYNC_PATHS = ['Default/Cookies', 'Default/Login Data', 'Default/Local Storage'];
const LOCK_DIR = path.join(CHROME_BASE_DIR, '.sync.lock');
const LOCK_STALE_MS = 10_000;

// Directory-create-as-mutex: mkdir is atomic, so the first caller to succeed
// holds the lock; everyone else retries (non-blocking — a setTimeout wait,
// not a busy loop, so it never stalls the server's event loop) until it's
// free or a stuck holder's lock is old enough to be considered crashed.
async function withLock<T>(fn: () => T, timeoutMs = 5000): Promise<T> {
  ensureBase();
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(LOCK_DIR);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() - start > timeoutMs) throw new Error('chrome-base sync lock timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
  }
}

/** Copy cookies/saved logins/local storage from this session's profile copy back to chrome-base. Last-writer-wins. No-op if the session never opened a browser. */
export async function syncProfileToBase(sessionId: string): Promise<{ ok: boolean; synced: string[] }> {
  const src = chromeSessionDir(sessionId);
  if (!fs.existsSync(src)) return { ok: false, synced: [] };
  return withLock(() => {
    const synced: string[] = [];
    for (const rel of SYNC_PATHS) {
      const from = path.join(src, rel);
      const to = path.join(CHROME_BASE_DIR, rel);
      if (!fs.existsSync(from)) continue;
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true });
        synced.push(rel);
      } catch (e) {
        console.error(`[chrome] sync ${rel} for ${sessionId} failed:`, (e as Error).message);
      }
    }
    return { ok: true, synced };
  });
}

/**
 * F6: the Google account signed in on a Chrome profile, read from the
 * profile's Preferences (`account_info[].email` — Chrome records the web
 * sign-in there; no cookies or secrets are touched). Looks at the session's
 * own copy first, then chrome-base (the take-over sync just wrote it there).
 * null = no Google web session found.
 */
export function googleAccountEmail(sessionId?: string | null): string | null {
  const dirs = [sessionId ? chromeSessionDir(sessionId) : null, CHROME_BASE_DIR].filter(Boolean) as string[];
  for (const d of dirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, 'Default', 'Preferences'), 'utf8'));
      const infos: any[] = Array.isArray(j?.account_info) ? j.account_info : [];
      const email = infos.map((a) => String(a?.email || '').trim().toLowerCase()).find((e) => /^[^\s@]+@[^\s@]+$/.test(e));
      if (email) return email;
    } catch {
      /* no profile / malformed */
    }
  }
  return null;
}

export function removeSessionProfile(sessionId: string): void {
  try { fs.rmSync(chromeSessionDir(sessionId), { recursive: true, force: true }); } catch {}
}
