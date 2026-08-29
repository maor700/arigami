// Per-session desktops (T8): a session gets its own `Xvfb`+`x11vnc` pair
// instead of sharing the global :99/5900 desktop — so two sessions driving a
// browser at once don't show each other the wrong window, and each keeps its
// own Chrome profile (see server/lib/chrome.ts).
//
// Allocation is lazy: `ensureDesktop(sessionId)` is called from the first
// request_screen/capture_screen/browser-open of a session (or up front, at
// create_session with needs_screen:true). The result is written to
// `session.metadata.screen = {display, vncPort}` — that IS the allocation
// table; there's no separate store, so a free port is just "not claimed by
// any live session's metadata.screen.vncPort" (mirrors allocatePort() for
// the dispatcher's dev-server pool in server/api.ts).
//
// Lifecycle: killed at archive (metadata cleared, port freed) and at delete
// (same, plus the Chrome profile copy — see chrome.ts). The global :99/5900
// desktop is untouched — it's not something this module owns.
import fs from 'node:fs';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { cfg } from './config.js';
import { supervise, killTree } from './children.js';
import { portFree } from './hostlock.js';
import * as state from '../state.js';

export interface DesktopInfo {
  display: string; // ':100'
  vncHost: string; // always loopback — same trust model as the global desktop
  vncPort: number;
}

// Desktops this process spawned (and is therefore allowed to kill). A desktop
// recorded in a session's metadata but absent here (e.g. after a host
// restart) is treated as dead — its port is free to reallocate; any leftover
// Xvfb/x11vnc pid was already caught by children.ts's startup sweep.
const alive = new Map<string, { xvfb: ChildProcess; x11vnc: ChildProcess }>();
const pending = new Map<string, Promise<DesktopInfo>>();

function usedPorts(): Set<number> {
  const used = new Set<number>();
  for (const s of state.listSessions({ archived: true })) {
    const p = Number((s.metadata as any)?.screen?.vncPort);
    if (Number.isFinite(p) && p > 0) used.add(p);
  }
  return used;
}

export interface AllocOpts {
  range?: [number, number];
  displayBase?: number;
  // Real-world occupancy (T5 §3): our own bookkeeping only knows what WE
  // allocated; another instance (or a stray Xvfb) may hold the display or the
  // port. Both default to the /tmp/.X<n>-lock probe and "not busy".
  displayBusy?: (displayNum: number) => boolean;
  portBusy?: (port: number) => boolean;
}

/** `:107` is taken if X left a lock or a socket for it — regardless of who owns it. */
export function displayLocked(displayNum: number): boolean {
  return fs.existsSync(`/tmp/.X${displayNum}-lock`) || fs.existsSync(`/tmp/.X11-unix/X${displayNum}`);
}

// Pure (no I/O unless a probe is passed) so it's unit-testable without
// spawning anything real — the port→display mapping is the part with actual
// bugs to catch. `used` = ports already claimed by this instance's sessions.
export function allocatePort(used: Set<number>, opts: AllocOpts = {}): { display: string; vncPort: number } {
  const [lo, hi] = opts.range || cfg.screen.portRange;
  const base = opts.displayBase ?? cfg.screen.displayBase ?? 100;
  const displayBusy = opts.displayBusy || displayLocked;
  const portBusy = opts.portBusy || (() => false);
  for (let p = lo; p <= hi; p++) {
    if (used.has(p)) continue;
    const n = base + (p - lo);
    if (displayBusy(n) || portBusy(p)) continue;
    return { display: `:${n}`, vncPort: p };
  }
  throw new Error(`screen.portRange [${lo},${hi}] exhausted — no free per-session VNC port/display`);
}

// Async wrapper: the sync allocator skips displays with an X lock; ports are
// then verified with a real bind, and a busy one is retried as "used".
async function allocateFree(): Promise<{ display: string; vncPort: number }> {
  const used = usedPorts();
  for (;;) {
    const pick = allocatePort(used);
    if (await portFree(pick.vncPort, '127.0.0.1')) return pick;
    used.add(pick.vncPort);
  }
}

function waitForFile(p: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(p)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${p}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function waitForPort(port: number, host: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ port, host, timeout: 500 });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`timed out waiting for VNC on :${port}`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

async function spawnDesktop(sessionId: string): Promise<DesktopInfo> {
  const { display, vncPort } = await allocateFree();
  const displayNum = display.slice(1);

  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  supervise(xvfb, `desktop:${sessionId}:xvfb`);
  try {
    await waitForFile(`/tmp/.X11-unix/X${displayNum}`, 5000);
  } catch (e) {
    killTree(xvfb.pid);
    throw e;
  }

  const vncArgs = [
    '-display', display,
    '-rfbport', String(vncPort),
    '-localhost', '-shared', '-forever', '-noxdamage', '-quiet',
    ...(cfg.screen.vncPassword ? ['-passwd', cfg.screen.vncPassword] : ['-nopw']),
  ];
  const x11vnc = spawn('x11vnc', vncArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  supervise(x11vnc, `desktop:${sessionId}:x11vnc`);
  try {
    await waitForPort(vncPort, '127.0.0.1', 5000);
  } catch (e) {
    killTree(xvfb.pid);
    killTree(x11vnc.pid);
    throw e;
  }

  const forget = () => { const c = alive.get(sessionId); if (c?.xvfb === xvfb || c?.x11vnc === x11vnc) alive.delete(sessionId); };
  xvfb.on('exit', forget);
  x11vnc.on('exit', forget);
  alive.set(sessionId, { xvfb, x11vnc });

  state.patchSession(sessionId, { metadata: { screen: { display, vncPort } } });
  return { display, vncHost: '127.0.0.1', vncPort };
}

/** Lazily spawn (or reuse) this session's desktop. Throws on allocation/spawn failure — callers should fall back to the global desktop rather than fail the caller's whole flow. */
export function ensureDesktop(sessionId: string): Promise<DesktopInfo> {
  if (!cfg.screen?.enabled) return Promise.reject(new Error('screen share disabled'));
  const s = state.getSession(sessionId);
  if (!s) return Promise.reject(new Error(`unknown session: ${sessionId}`));
  const existing = (s.metadata as any)?.screen as { display?: string; vncPort?: number } | undefined;
  if (existing?.display && existing?.vncPort && alive.has(sessionId))
    return Promise.resolve({ display: existing.display, vncHost: '127.0.0.1', vncPort: existing.vncPort });
  const inFlight = pending.get(sessionId);
  if (inFlight) return inFlight;
  const p = spawnDesktop(sessionId).finally(() => pending.delete(sessionId));
  pending.set(sessionId, p);
  return p;
}

/** The desktop a session should be viewed/captured on: its own if allocated, else the global one. */
export function screenTarget(sessionId?: string | null): { vncHost: string; vncPort: number; display?: string } {
  if (sessionId) {
    const s = state.getSession(sessionId);
    const scr = (s?.metadata as any)?.screen as { display?: string; vncPort?: number } | undefined;
    if (scr?.vncPort) return { vncHost: '127.0.0.1', vncPort: scr.vncPort, display: scr.display };
  }
  return { vncHost: cfg.screen.vncHost, vncPort: cfg.screen.vncPort, display: cfg.screen.display };
}

/** Kill a session's desktop processes (archive/delete). Profile-copy removal is the caller's call — see chrome.ts. */
export function releaseDesktop(sessionId: string): void {
  const procs = alive.get(sessionId);
  if (procs) {
    killTree(procs.xvfb.pid);
    killTree(procs.x11vnc.pid);
    alive.delete(sessionId);
  }
  const s = state.getSession(sessionId);
  if ((s?.metadata as any)?.screen) state.patchSession(sessionId, { metadata: { screen: null } });
}

// ---- global desktop autostart (spec §7.3) --------------------------------------
//
// The shared :99/5900 desktop (the one `screenTarget()` falls back to when a
// session has no desktop of its own) used to be a hand-written systemd unit
// outside the repo. Starting it from code makes Docker/systemd/launchd behave
// the same: on boot the DEFAULT instance checks whether the display is already
// up (another owner — e.g. the legacy unit — or a previous run) and only then
// spawns Xvfb + a window manager (if present) + x11vnc bound to loopback.
// Non-default instances never touch it (T5: they don't own the global desktop).
// Set ARIGAMI_GLOBAL_DESKTOP=0 to opt out entirely.
import { execSync } from 'node:child_process';
import { IS_DEFAULT_INSTANCE } from './instance.js';

const globalProcs: ChildProcess[] = [];

function which(bin: string): string | null {
  try { return execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'], shell: '/bin/sh' }).toString().trim() || null; } catch { return null; }
}

export interface GlobalDesktopOpts {
  isDefaultInstance?: boolean;
  enabled?: boolean;
  display?: string; // ':99'
  vncPort?: number;
  vncHost?: string;
  vncPassword?: string;
  which?: (bin: string) => string | null;
  displayBusy?: (n: number) => boolean;
  portBusy?: (port: number) => Promise<boolean>;
  spawnFn?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  startTimeoutMs?: number; // how long to wait for the X socket / VNC port
}

export type GlobalDesktopResult =
  | { started: false; reason: string }
  | { started: true; display: string; vncPort: number; pids: number[] };

/** Decide-and-spawn, with every probe injectable so the decision is unit-testable. */
export async function ensureGlobalDesktop(opts: GlobalDesktopOpts = {}): Promise<GlobalDesktopResult> {
  const env = opts.env || process.env;
  if (env.ARIGAMI_GLOBAL_DESKTOP === '0') return { started: false, reason: 'ARIGAMI_GLOBAL_DESKTOP=0' };
  if (process.platform !== 'linux') return { started: false, reason: 'not linux' };
  if (!(opts.isDefaultInstance ?? IS_DEFAULT_INSTANCE)) return { started: false, reason: 'non-default instance' };
  if (!(opts.enabled ?? cfg.screen?.enabled)) return { started: false, reason: 'screen disabled' };
  const display = opts.display || cfg.screen.display || ':99';
  const n = Number(display.replace(/^:/, '').split('.')[0]);
  if (!Number.isFinite(n)) return { started: false, reason: `bad display ${display}` };
  const vncPort = opts.vncPort ?? cfg.screen.vncPort;
  const vncHost = opts.vncHost ?? cfg.screen.vncHost;
  if (vncHost && vncHost !== '127.0.0.1' && vncHost !== 'localhost') return { started: false, reason: `vncHost ${vncHost} is remote` };
  const w = opts.which || which;
  const xvfbBin = w('Xvfb');
  const vncBin = w('x11vnc');
  if (!xvfbBin) return { started: false, reason: 'Xvfb not installed' };
  if (!vncBin) return { started: false, reason: 'x11vnc not installed' };
  if ((opts.displayBusy || displayLocked)(n)) return { started: false, reason: `display ${display} already up` };
  const busy = opts.portBusy ? await opts.portBusy(vncPort) : !(await portFree(vncPort, '127.0.0.1'));
  if (busy) return { started: false, reason: `vnc port ${vncPort} in use` };

  const sp = opts.spawnFn || spawn;
  const startTimeoutMs = opts.startTimeoutMs ?? 5000;
  const pids: number[] = [];
  const xvfb = sp(xvfbBin, [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe'] });
  supervise(xvfb, 'desktop:global:xvfb');
  globalProcs.push(xvfb);
  if (xvfb.pid) pids.push(xvfb.pid);
  try {
    await waitForFile(`/tmp/.X11-unix/X${n}`, startTimeoutMs);
  } catch (e) {
    killTree(xvfb.pid);
    return { started: false, reason: `Xvfb did not come up: ${(e as Error).message}` };
  }
  const denv = { ...env, DISPLAY: display };
  const wm = w('openbox');
  if (wm) {
    const p = sp(wm, [], { stdio: 'ignore', env: denv });
    supervise(p, 'desktop:global:wm');
    globalProcs.push(p);
    if (p.pid) pids.push(p.pid);
  }
  const panel = w('tint2');
  if (panel) {
    const p = sp(panel, [], { stdio: 'ignore', env: denv });
    supervise(p, 'desktop:global:panel');
    globalProcs.push(p);
    if (p.pid) pids.push(p.pid);
  }
  const pw = opts.vncPassword ?? cfg.screen.vncPassword;
  const x11vnc = sp(vncBin, [
    '-display', display, '-rfbport', String(vncPort),
    '-localhost', '-shared', '-forever', '-noxdamage', '-quiet',
    ...(pw ? ['-passwd', pw] : ['-nopw']),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  supervise(x11vnc, 'desktop:global:x11vnc');
  globalProcs.push(x11vnc);
  if (x11vnc.pid) pids.push(x11vnc.pid);
  try {
    await waitForPort(vncPort, '127.0.0.1', startTimeoutMs);
  } catch (e) {
    for (const p of globalProcs) killTree(p.pid);
    globalProcs.length = 0;
    return { started: false, reason: `x11vnc did not come up: ${(e as Error).message}` };
  }
  return { started: true, display, vncPort, pids };
}
