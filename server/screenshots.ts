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
import { pickDriver } from './lib/screen-driver.js';
import { encodePng, downscaleRgba, frameDiffRatio } from './lib/png.js';

export const SCREENS_DIR = path.join(cfg.configDir!, 'uploads', 'screens');

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
  via: 'rfb' | 'x11' | 'cdp'; // driver-defined; 'cdp' is native-window's (see screen-driver-native.ts)
}

const FILE_RE = /^[A-Za-z0-9_-]+\.png$/;

export function screenFilePath(sessionId: string, file: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !FILE_RE.test(file)) return null;
  const p = path.join(SCREENS_DIR, sessionId, file);
  return p.startsWith(SCREENS_DIR + path.sep) ? p : null;
}

// Dedup / change detection (T9). Per session we keep the last RECORDED frame
// (raw RGBA, ~4MB — one per active session, dropped by forgetSession) so both
// the agent's capture_screen and the Watch-mode loop can ask "is this frame
// materially different from what's already in the chat?".
interface LastShot { rgba: Buffer; width: number; height: number; pngSha?: string; url: string; ts: number; }
const lastShot = new Map<string, LastShot>();

export interface ChangePolicy { threshold: number; minIntervalMs: number; }

// Pure: should a new frame be recorded given the previous recorded one?
// `diff` is frameDiffRatio(prev, next); `sinceMs` the time since the previous
// recording. Below the change threshold → duplicate. Above it but too soon →
// throttled (auto loop only; capture_screen ignores minIntervalMs).
export function judgeFrame(diff: number, sinceMs: number, policy: ChangePolicy, throttle: boolean): 'record' | 'duplicate' | 'throttled' {
  if (diff <= policy.threshold) return 'duplicate';
  if (throttle && sinceMs < policy.minIntervalMs) return 'throttled';
  return 'record';
}

function policy(): ChangePolicy {
  return {
    threshold: cfg.screen?.snapshotChangeThreshold ?? 0.03,
    minIntervalMs: cfg.screen?.snapshotMinIntervalMs ?? 30_000,
  };
}

export type ShotResult =
  | { status: 'recorded'; event: ScreenshotEvent }
  | { status: 'duplicate'; url: string; ts: number }
  | { status: 'throttled' };

export async function takeScreenshot(
  sessionId: string,
  opts: { caption?: string; auto?: boolean; requestId?: string; force?: boolean } = {}
): Promise<ShotResult> {
  // Lazy per-session desktop (T8): the session's own machine if it has (or
  // can get) one, otherwise the global desktop — ensureDesktop() throwing
  // (binary missing, ports exhausted) is not fatal here, just no upgrade.
  const driver = pickDriver();
  try { await driver.ensure(sessionId); } catch {}
  const cap = await driver.capture(sessionId);
  let png = cap.png;
  let width = cap.width, height = cap.height;
  const now = Date.now();
  const prev = lastShot.get(sessionId);
  const pngSha = cap.frame ? undefined : crypto.createHash('sha1').update(png).digest('hex');
  if (prev && !opts.force) {
    let verdict: ReturnType<typeof judgeFrame>;
    if (cap.frame) {
      const diff = frameDiffRatio(prev.rgba, cap.frame.rgba, cap.frame.width, cap.frame.height);
      verdict = judgeFrame(diff, now - prev.ts, policy(), !!opts.auto);
    } else {
      // x11 fallback path: no pixels to compare, byte-identical PNG = duplicate.
      verdict = pngSha === prev.pngSha ? 'duplicate' : (opts.auto && now - prev.ts < policy().minIntervalMs ? 'throttled' : 'record');
    }
    if (verdict === 'duplicate') return { status: 'duplicate', url: prev.url, ts: prev.ts };
    if (verdict === 'throttled') return { status: 'throttled' };
  }
  if (cap.frame && opts.auto && cap.frame.width > 800) {
    // Auto-snapshots are rarely inspected at full size — halve them.
    const d = downscaleRgba(cap.frame.rgba, cap.frame.width, cap.frame.height, 2);
    png = encodePng(d.rgba, d.width, d.height);
    width = d.width; height = d.height;
  }
  const ts = now;
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
    via: cap.via as ScreenshotEvent['via'],
    ...(opts.caption ? { caption: opts.caption } : {}),
    ...(width ? { width, height } : {}),
    ...(opts.auto ? { auto: true } : {}),
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
  };
  lastShot.set(sessionId, {
    rgba: cap.frame?.rgba ?? Buffer.alloc(0),
    width: cap.frame?.width ?? 0,
    height: cap.frame?.height ?? 0,
    pngSha,
    url: ev.url,
    ts,
  });
  claude.appendChat(sessionId, ev);
  scheduleSweep();
  return { status: 'recorded', event: ev };
}

// Drop the cached comparison frame (session archived / killed).
export function forgetSession(sessionId: string): void {
  lastShot.delete(sessionId);
}

// ---- Watch-mode auto-snapshots ----------------------------------------------
//
// OFF by default (screen.autoSnapshots). When on: the server only knows a
// request_screen is *pending*; Watch vs Control is client state (T1). The
// card reports it via POST …/screen-request/mode, and the loop pauses in
// Control — nothing is recorded while the human is typing passwords (same
// privacy rule as Operator). Each poll captures a frame but only RECORDS it
// if it changed materially since the last recorded one and at least
// snapshotMinIntervalMs passed (judgeFrame) — an idle login page produces
// nothing, a navigation produces one card.
interface AutoLoop {
  sessionId: string;
  mode: 'watch' | 'control';
  timer: NodeJS.Timeout | null;
  busy: boolean;
  count: number;
  failed: number;
}
const loops = new Map<string, AutoLoop>();

async function tick(requestId: string, first = false): Promise<void> {
  const loop = loops.get(requestId);
  if (!loop || loop.mode !== 'watch' || loop.busy) return;
  loop.busy = true;
  try {
    // The first frame shows the human what they're being asked about — it is
    // still deduped against the agent's own last capture (the skill says to
    // capture_screen right before request_screen, so usually it's a no-op).
    const r = await takeScreenshot(loop.sessionId, { auto: true, requestId, force: false });
    if (r.status === 'recorded') loop.count++;
  } catch (e) {
    // A failing capture backend shouldn't spam the log every poll.
    if (loop.failed++ === 0) console.error('[screens] auto-snapshot failed:', (e as Error).message);
  } finally {
    loop.busy = false;
  }
}

export function startAutoSnapshots(sessionId: string, requestId: string): void {
  if (!cfg.screen?.enabled || !cfg.screen?.autoSnapshots || loops.has(requestId)) return;
  const interval = Math.max(2000, cfg.screen.snapshotIntervalMs || 10_000);
  const loop: AutoLoop = { sessionId, mode: 'watch', timer: null, busy: false, count: 0, failed: 0 };
  loops.set(requestId, loop);
  void tick(requestId, true);
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
