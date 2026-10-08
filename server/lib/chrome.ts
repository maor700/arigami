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

// A2: an agent (Team section) owns a persistent profile of its own —
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

// First open only — an existing profile is left alone so a session's own
// in-progress browsing (open tabs, a login mid-flow) survives a restart.
//
// A plain session's browser starts EMPTY. It used to start as a full copy of
// chrome-base, which handed every agent every login the owner had, with no
// say in it; logins now arrive one site at a time, only when the owner
// approves (login-vault.ts, request_login). A session born from an AGENT still
// starts from that agent's own profile — that is the agent's identity, which
// the owner set up for it deliberately.
export function ensureSessionProfile(sessionId: string): string {
  const dir = chromeSessionDir(sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(CHROME_SESSIONS_DIR, { recursive: true });
    const seed = profileSeedFor(sessionId);
    if (seed.owner !== 'global') {
      ensureBase(seed.dir); // an agent's first-ever profile starts empty and is created here
      // Caches are what makes a profile hundreds of MB; they are not identity.
      fs.cpSync(seed.dir, dir, { recursive: true, filter: (src) => !CACHE_DIRS.has(path.basename(src)) });
    } else {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  return dir;
}

const CACHE_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache', 'Service Worker', 'blob_storage', 'Crashpad']);

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
// Detected via /.dockerenv, a Kubernetes pod (KUBERNETES_SERVICE_HOST — containerd pods have no /.dockerenv, which
// is how every browser launch in a tenant pod used to die in Chrome's zygote), or an explicit CHROME_NO_SANDBOX=1 —
// never on a native host. CHROME_NO_SANDBOX=0 forces the sandbox on.
export function chromeExtraFlags(env: NodeJS.ProcessEnv = process.env, dockerenv: boolean = fs.existsSync('/.dockerenv')): string[] {
  if (env.CHROME_NO_SANDBOX === '0') return [];
  const inContainer = env.CHROME_NO_SANDBOX === '1' || dockerenv || !!env.KUBERNETES_SERVICE_HOST;
  return inContainer ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : [];
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
    // Window sizing/positioning is driver-specific (see browserLaunch below):
    // x11's virtual screen wants --start-maximized, a native-window desktop
    // must NOT get it (it would take over the user's real monitor).
    // F8: loopback DevTools port (Chrome writes it to <profile>/DevToolsActivePort)
    // so the host can read the take-over browser's tabs / type into it — see chrome-cdp.ts.
    '--remote-debugging-port=0',
    // Reopened after an idle close (below) with the tabs it had.
    '--restore-last-session',
    // A long-lived session profile otherwise grows its cache without bound.
    '--disk-cache-size=52428800',
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
  touch(sessionId);
  return { display, pid: child.pid!, alreadyRunning: false };
}

// ---- idle close -----------------------------------------------------------------
//
// A session's Chrome costs 650 MB-1.1 GB and mostly sits idle between the
// agent's browser steps. Close it after IDLE_MS without use; the next browser
// step reopens it (browser-actions.ts) with the same profile and its tabs, so
// logins and open pages survive. Never while a human may be looking at it: an
// open take-over request, or a take-over that ended recently, keeps it up.

const lastUse = new Map<string, number>();
export const IDLE_MS = Number(process.env.ARIGAMI_BROWSER_IDLE_MS) || 10 * 60_000;

/** Record that this session's browser was just used (every browser_* step calls it). */
export function touch(sessionId: string): void {
  lastUse.set(sessionId, Date.now());
}

/**
 * Stop Chrome cleanly: Browser.close over DevTools lets it flush cookies and
 * storage and write its session (for --restore-last-session); SIGTERM/SIGKILL
 * only if it does not go.
 */
export async function closeChromeGracefully(sessionId: string, port: number | null): Promise<void> {
  const child = running.get(sessionId);
  if (!child) return;
  if (port) {
    try {
      const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).json()) as any;
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise<void>((res) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          setTimeout(res, 200);
        };
        ws.onerror = () => res();
      });
      const t0 = Date.now();
      while (child.exitCode === null && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 100));
    } catch {
      /* fall through to the signal */
    }
  }
  if (child.exitCode === null) killTree(child.pid);
  running.delete(sessionId);
}

/** Sessions whose browser should close now. Pure — the caller supplies what a human is doing. */
export function idleCandidates(now: number, humanBusy: (sessionId: string) => boolean): string[] {
  const out: string[] = [];
  for (const id of running.keys()) {
    if (!isChromeRunning(id)) continue;
    const last = lastUse.get(id) ?? 0;
    if (now - last < IDLE_MS) continue;
    if (humanBusy(id)) continue;
    out.push(id);
  }
  return out;
}

export function startIdleCloser(humanBusy: (sessionId: string) => boolean, portOf: (sessionId: string) => number | null, log: (m: string) => void = console.log): () => void {
  const tick = async () => {
    for (const id of idleCandidates(Date.now(), humanBusy)) {
      await closeChromeGracefully(id, portOf(id)).catch(() => {});
      log(`[chrome] closed the idle browser of ${id} (unused for ${Math.round(IDLE_MS / 60000)} min; it reopens on the next browser step)`);
    }
  };
  const t = setInterval(() => void tick(), 60_000);
  t.unref?.();
  return () => clearInterval(t);
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
 * Copy cookies/saved logins/local storage from an AGENT session's profile back
 * into the agent's own browser/ (A2) — the agent's identity. Last-writer-wins
 * under a per-target lock. No-op if the session never opened a browser.
 *
 * It never writes chrome-base, the owner's own profile: that used to be the
 * default for plain sessions and an opt-in (`shared`) for agents, and it is how
 * logins overwrote each other. A login reaches the owner's browser only through
 * login-vault.ts's saveToVault — one site, after the owner approved it.
 */
export async function syncProfileToBase(sessionId: string): Promise<{ ok: boolean; synced: string[]; targets: string[] }> {
  const src = chromeSessionDir(sessionId);
  if (!fs.existsSync(src)) return { ok: false, synced: [], targets: [] };
  const seed = profileSeedFor(sessionId);
  if (seed.owner === 'global') return { ok: false, synced: [], targets: [] };
  const targets = [seed];
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
