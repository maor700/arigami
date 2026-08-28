// Screenshots (T3): capture the shared desktop → PNG on disk → `screenshot`
// chat event. Three entry points share one pipeline:
//   - POST /__api/sessions/:id/screenshot (the agent's capture_screen tool)
//   - Watch-mode auto-snapshots while a request_screen card is open
//   - retention sweep (age / total size), after each save and hourly
//
// Files live in ~/.arigami/uploads/screens/<session>/<ts>.png (outside any
// worktree, next to chat attachments) and are served back through
// GET /__api/sessions/:id/screens/<file>.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './state.js';
import * as claude from './claude.js';
import { captureScreen } from './vnc.js';
import { ensureDesktop, screenTarget } from './lib/desktops.js';
import { encodePng, downscaleRgba } from './lib/png.js';

export const SCREENS_DIR = path.join(cfg.configDir || path.join(process.env.HOME || '.', '.arigami'), 'uploads', 'screens');

export interface ScreenshotEvent {
  kind: 'screenshot';
  url: string;
  file: string;
  caption?: string;
  ts: number;
  width?: number;
  height?: number;
  auto?: boolean;      // taken by the Watch-mode timer, not by the agent
  requestId?: string;  // the request_screen card it belongs to (auto only)
  via: 'rfb' | 'x11';
}

const FILE_RE = /^[A-Za-z0-9_-]+\.png$/;

export function screenFilePath(sessionId: string, file: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !FILE_RE.test(file)) return null;
  const p = path.join(SCREENS_DIR, sessionId, file);
  return p.startsWith(SCREENS_DIR + path.sep) ? p : null;
}

// Watch-mode snapshots skip frames identical to the previous one (an idle
// login page every 10s adds nothing); the agent's explicit captures never skip.
const lastHash = new Map<string, string>();

export async function takeScreenshot(
  sessionId: string,
  opts: { caption?: string; auto?: boolean; requestId?: string; skipUnchanged?: boolean } = {}
): Promise<ScreenshotEvent | null> {
  // Lazy per-session desktop (T8): the session's own machine if it has (or
  // can get) one, otherwise the global desktop — ensureDesktop() throwing
  // (binary missing, ports exhausted) is not fatal here, just no upgrade.
  try { await ensureDesktop(sessionId); } catch {}
  const cap = await captureScreen(screenTarget(sessionId));
  let png = cap.png;
  let width = cap.width, height = cap.height;
  if (cap.frame) {
    if (opts.skipUnchanged) {
      const h = crypto.createHash('sha1').update(cap.frame.rgba).digest('hex');
      const key = opts.requestId || sessionId;
      if (lastHash.get(key) === h) return null;
      lastHash.set(key, h);
    }
    // Auto-snapshots are many and rarely inspected at full size — halve them.
    if (opts.auto && cap.frame.width > 800) {
      const d = downscaleRgba(cap.frame.rgba, cap.frame.width, cap.frame.height, 2);
      png = encodePng(d.rgba, d.width, d.height);
      width = d.width; height = d.height;
    }
  }
  const ts = Date.now();
  const dir = path.join(SCREENS_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  let file = `${ts}.png`;
  for (let n = 1; fs.existsSync(path.join(dir, file)); n++) file = `${ts}-${n}.png`;
  fs.writeFileSync(path.join(dir, file), png);
  const ev: ScreenshotEvent = {
    kind: 'screenshot',
    url: `/__api/sessions/${sessionId}/screens/${file}`,
    file,
    ts,
    via: cap.via,
    ...(opts.caption ? { caption: opts.caption } : {}),
    ...(width ? { width, height } : {}),
    ...(opts.auto ? { auto: true } : {}),
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
  };
  claude.appendChat(sessionId, ev);
  scheduleSweep();
  return ev;
}

export function forgetSession(requestKey: string): void {
  lastHash.delete(requestKey);
}

// ---- Watch-mode auto-snapshots ----------------------------------------------
//
// The server only knows a request_screen is *pending*; Watch vs Control is
// client state (T1). The card reports it via POST …/screen-request/mode, and
// the timer here pauses in Control — nothing is recorded while the human is
// typing passwords (same privacy rule as Operator).
interface AutoLoop {
  sessionId: string;
  mode: 'watch' | 'control';
  timer: NodeJS.Timeout | null;
  busy: boolean;
  count: number;
}
const loops = new Map<string, AutoLoop>();

async function tick(requestId: string): Promise<void> {
  const loop = loops.get(requestId);
  if (!loop || loop.mode !== 'watch' || loop.busy) return;
  loop.busy = true;
  try {
    const ev = await takeScreenshot(loop.sessionId, { auto: true, requestId, skipUnchanged: true });
    if (ev) loop.count++;
  } catch (e) {
    // A failing capture backend shouldn't spam the log every 10s.
    if (loop.count === 0) console.error('[screens] auto-snapshot failed:', (e as Error).message);
  } finally {
    loop.busy = false;
  }
}

export function startAutoSnapshots(sessionId: string, requestId: string): void {
  if (!cfg.screen?.enabled || loops.has(requestId)) return;
  const interval = Math.max(2000, cfg.screen.snapshotIntervalMs || 10_000);
  const loop: AutoLoop = { sessionId, mode: 'watch', timer: null, busy: false, count: 0 };
  loops.set(requestId, loop);
  // First frame right away (shows the human what they're being asked about),
  // then every `interval`.
  void tick(requestId);
  loop.timer = setInterval(() => void tick(requestId), interval);
}

export function setAutoSnapshotMode(requestId: string, mode: 'watch' | 'control'): boolean {
  const loop = loops.get(requestId);
  if (!loop) return false;
  loop.mode = mode;
  return true;
}

export function stopAutoSnapshots(requestId: string): void {
  const loop = loops.get(requestId);
  if (!loop) return;
  if (loop.timer) clearInterval(loop.timer);
  loops.delete(requestId);
  lastHash.delete(requestId);
}

// ---- Retention ---------------------------------------------------------------

export interface SweepResult { removed: number; bytesFreed: number; }

// Pure: delete files older than maxAgeMs, then oldest-first until the tree is
// under maxBytes. Empty session dirs are removed too. Exported for tests.
export function sweepScreensDir(root: string, maxAgeMs: number, maxBytes: number, now = Date.now()): SweepResult {
  const out: SweepResult = { removed: 0, bytesFreed: 0 };
  if (!fs.existsSync(root)) return out;
  const files: { p: string; size: number; mtime: number }[] = [];
  for (const sess of fs.readdirSync(root)) {
    const dir = path.join(root, sess);
    let st: fs.Stats;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!FILE_RE.test(f)) continue;
      try {
        const fst = fs.statSync(path.join(dir, f));
        // Filenames are the capture timestamp — more reliable than mtime on
        // copied/restored trees; fall back to mtime otherwise.
        const tsName = Number(f.split(/[.-]/)[0]);
        files.push({ p: path.join(dir, f), size: fst.size, mtime: Number.isFinite(tsName) && tsName > 0 ? tsName : fst.mtimeMs });
      } catch {}
    }
  }
  const rm = (f: { p: string; size: number }) => {
    try { fs.unlinkSync(f.p); out.removed++; out.bytesFreed += f.size; } catch {}
  };
  let keep = files.filter((f) => {
    if (now - f.mtime > maxAgeMs) { rm(f); return false; }
    return true;
  });
  let total = keep.reduce((n, f) => n + f.size, 0);
  keep.sort((a, b) => a.mtime - b.mtime);
  for (const f of keep) {
    if (total <= maxBytes) break;
    rm(f);
    total -= f.size;
  }
  for (const sess of fs.readdirSync(root)) {
    const dir = path.join(root, sess);
    try { if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
  }
  return out;
}

let sweepTimer: NodeJS.Timeout | null = null;
export function sweepNow(): SweepResult {
  const days = cfg.screen?.screenshotRetentionDays ?? 7;
  const mb = cfg.screen?.screenshotMaxMb ?? 200;
  return sweepScreensDir(SCREENS_DIR, days * 86_400_000, mb * 1024 * 1024);
}
// Debounced: a burst of captures triggers one sweep shortly after.
function scheduleSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => { sweepTimer = null; try { sweepNow(); } catch {} }, 5000);
}
// Hourly sweep so age-based expiry happens even on a quiet host.
setInterval(() => { try { sweepNow(); } catch {} }, 3_600_000).unref?.();
