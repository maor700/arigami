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
import { pickDriver } from './screen-driver.js';
import { chromeCandidates, findChromeBin } from './platform.js';

export const CHROME_BASE_DIR = path.join(ARIGAMI_DIR, 'chrome-base');
export const CHROME_SESSIONS_DIR = path.join(ARIGAMI_DIR, 'chrome-sessions');

export function chromeSessionDir(sessionId: string): string {
  return path.join(CHROME_SESSIONS_DIR, sessionId);
}

// A2: an agent ("צוות") owns a persistent profile of its own —
// $ARIGAMI_DIR/agents/<slug>/browser/. Sessions born from the agent clone THAT
// (not chrome-base) on first open, and sync their logins back into it, so the
// agent keeps its own identity across sessions. Slug shape = agents.ts SLUG_RE
// (kept inline: agents.ts pulls in skills/bus, which chrome.ts must not).
const AGENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function agentBrowserDir(slug: string): string {
  if (!AGENT_SLUG_RE.test(slug)) throw new Error(`invalid agent slug: ${slug}`);
  return path.join(ARIGAMI_DIR, 'agents', slug, 'browser');
}

/** The agent slug a session was born from (metadata.agent), or null. */
export function agentOfSession(sessionId: string): string | null {
  const a = (state.getSession(sessionId)?.metadata as any)?.agent;
  return typeof a === 'string' && AGENT_SLUG_RE.test(a) ? a : null;
}

/** Where a session's profile copy is seeded from / synced to: the agent's profile, else chrome-base. */
export function profileSeedFor(sessionId: string): { dir: string; owner: string } {
  const slug = agentOfSession(sessionId);
  return slug ? { dir: agentBrowserDir(slug), owner: `agent:${slug}` } : { dir: CHROME_BASE_DIR, owner: 'global' };
}

function ensureBase(dir = CHROME_BASE_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
}

// First open only — an existing copy is left alone so a session's own
// in-progress browsing (open tabs, a login mid-flow) survives a restart.
// An agent's first-ever profile starts EMPTY (its own identity — it does not
// inherit the shared base logins); later sessions of the agent inherit its own.
export function ensureSessionProfile(sessionId: string): string {
  const dir = chromeSessionDir(sessionId);
  if (!fs.existsSync(dir)) {
    const seed = profileSeedFor(sessionId).dir;
    ensureBase(seed);
    fs.mkdirSync(CHROME_SESSIONS_DIR, { recursive: true });
    fs.cpSync(seed, dir, { recursive: true });
  }
  return dir;
}

const running = new Map<string, ChildProcess>();

// B2/§7.4: the browser binary is abstracted behind CHROME_BIN — google-chrome
// on amd64, chromium on arm64 (the Docker image and install.sh both set it).
// Off Linux (or when nothing on PATH matches), lib/platform.ts's
// findChromeBin() also tries the macOS/Windows well-known install paths — see
// its comment for why a missing binary throws here instead of returning a
// name that only fails once spawn() gets it (silently: supervise() swallows
// the child's 'error' event, so openChrome() would otherwise report success).
export function chromeBin(): string {
  const found = findChromeBin();
  if (found) return found;
  throw new Error(
    `Chrome/Chromium not found — looked for: ${chromeCandidates().join(', ')}. Set CHROME_BIN to its full path.`
  );
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
  const driver = pickDriver();
  const handle = await driver.ensure(sessionId);
  const display = String(handle.display);
  const existing = running.get(sessionId);
  if (existing && isChromeRunning(sessionId)) return { display, pid: existing.pid!, alreadyRunning: true };

  const profileDir = ensureSessionProfile(sessionId);
  const args = [
    `--user-data-dir=${profileDir}`,
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    // F8: loopback DevTools port (Chrome writes it to <profile>/DevToolsActivePort)
    // so the host can read the take-over browser's tabs / type into it — see chrome-cdp.ts.
    '--remote-debugging-port=0',
    ...(url ? [url] : []),
  ];
  const { env, extraArgs } = await driver.browserLaunch(sessionId);
  const child = spawn(chromeBin(), chromeExtraFlags().concat(extraArgs, args), {
    env,
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
const LOCK_STALE_MS = 10_000;

// Directory-create-as-mutex: mkdir is atomic, so the first caller to succeed
// holds the lock; everyone else retries (non-blocking — a setTimeout wait,
// not a busy loop, so it never stalls the server's event loop) until it's
// free or a stuck holder's lock is old enough to be considered crashed.
async function withLock<T>(target: string, fn: () => T, timeoutMs = 5000): Promise<T> {
  ensureBase(target);
  const LOCK_DIR = path.join(target, '.sync.lock');
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

function copySyncPaths(src: string, target: string, sessionId: string): string[] {
  const synced: string[] = [];
  for (const rel of SYNC_PATHS) {
    const from = path.join(src, rel);
    const to = path.join(target, rel);
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
  return synced;
}

/**
 * Copy cookies/saved logins/local storage from this session's profile copy back
 * to its seed — chrome-base for a plain session, the AGENT's browser/ for a
 * session born from an agent (A2). `shared:true` additionally syncs an agent
 * session into chrome-base (only when asked — an agent's logins stay its own
 * by default). Last-writer-wins under a per-target lock. No-op if the session
 * never opened a browser.
 */
export async function syncProfileToBase(sessionId: string, opts: { shared?: boolean } = {}): Promise<{ ok: boolean; synced: string[]; targets: string[] }> {
  const src = chromeSessionDir(sessionId);
  if (!fs.existsSync(src)) return { ok: false, synced: [], targets: [] };
  const seed = profileSeedFor(sessionId);
  const targets = [seed];
  if (opts.shared && seed.owner !== 'global') targets.push({ dir: CHROME_BASE_DIR, owner: 'global' });
  let synced: string[] = [];
  for (const t of targets) synced = await withLock(t.dir, () => copySyncPaths(src, t.dir, sessionId));
  return { ok: true, synced, targets: targets.map((t) => t.owner) };
}

/**
 * F6: the Google account signed in on a Chrome profile, read from the
 * profile's Preferences (`account_info[].email` — Chrome records the web
 * sign-in there; no cookies or secrets are touched). Looks at the session's
 * own copy first, then chrome-base (the take-over sync just wrote it there).
 * null = no Google web session found.
 */
export function googleAccountEmail(sessionId?: string | null): string | null {
  // A2: a session born from an agent falls back to the AGENT's profile, never chrome-base
  // (the agent's identity is its own; the shared one must not leak in).
  const agent = sessionId ? agentOfSession(sessionId) : null;
  const dirs = [sessionId ? chromeSessionDir(sessionId) : null, agent ? agentBrowserDir(agent) : CHROME_BASE_DIR].filter(Boolean) as string[];
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
