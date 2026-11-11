// Desktop control — screenshots in, mouse and keyboard out — as a HOST capability.
//
// It is deliberately engine-neutral: it is exposed as MCP tools (mcp/host-mcp.js) that every session
// gets, Claude or Codex alike, so what a person can do with the machine never depends on which
// subscription they happen to hold. The tools act on the session's OWN desktop (a private Xvfb, see
// screen-driver-x11.ts) — never the owner's real screen.
//
// Linux/x11 only today: input goes through skills/_lib/xinput.py (XTEST over ctypes). A driver that
// cannot do it says so; there is no silent fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pickDriver } from './screen-driver.js';
import { chromeEnv, chromeExtraFlags } from './chrome.js';
import { cfg } from './config.js';
import { screenTarget } from './desktops.js';
import { captureScreen } from '../vnc.js';
import { SKILLS_DIR } from '../skills.js';

export const XINPUT = path.join(SKILLS_DIR, '_lib', 'xinput.py');

export type DesktopAction =
  | { action: 'move'; x: number; y: number }
  | { action: 'click' | 'right_click' | 'middle_click' | 'double_click'; x: number; y: number }
  | { action: 'drag'; x: number; y: number; x2: number; y2: number }
  | { action: 'scroll'; x: number; y: number; dy: number }
  | { action: 'type'; text: string }
  | { action: 'key'; key: string };

const int = (v: unknown, name: string): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return String(Math.round(n));
};

/** The xinput.py argv for one action — pure, so the mapping is testable without a display. */
export function xinputArgs(a: DesktopAction): string[] {
  switch (a.action) {
    case 'move':
      return ['move', int(a.x, 'x'), int(a.y, 'y')];
    case 'click':
      return ['click', int(a.x, 'x'), int(a.y, 'y'), '1'];
    case 'middle_click':
      return ['click', int(a.x, 'x'), int(a.y, 'y'), '2'];
    case 'right_click':
      return ['click', int(a.x, 'x'), int(a.y, 'y'), '3'];
    case 'double_click':
      return ['dblclick', int(a.x, 'x'), int(a.y, 'y')];
    case 'drag':
      return ['drag', int(a.x, 'x'), int(a.y, 'y'), int((a as any).x2, 'x2'), int((a as any).y2, 'y2')];
    case 'scroll':
      return ['scroll', int(a.x, 'x'), int(a.y, 'y'), int((a as any).dy, 'dy')];
    case 'type': {
      const text = String((a as any).text ?? '');
      if (!text) throw new Error('text is empty');
      if (text.length > 2000) throw new Error('text is too long (max 2000 chars per call)');
      return ['type', text];
    }
    case 'key': {
      const key = String((a as any).key ?? '').trim();
      if (!key) throw new Error('key is empty');
      return ['key', key];
    }
    default:
      throw new Error(`unknown action: ${(a as any).action}`);
  }
}

async function ownDesktop(sessionId: string): Promise<{ display: string }> {
  const driver = pickDriver();
  if (driver.id !== 'x11') throw new Error(`desktop control needs the x11 driver (Linux); this host uses "${driver.id}"`);
  const handle = await driver.ensure(sessionId);
  const display = String(handle.display ?? '');
  if (!display) throw new Error('this session has no desktop');
  return { display };
}

function run(argv: string[], display: string, timeoutMs = 15_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('python3', argv, { env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(kill); resolve({ code: code ?? 1, out: out.trim(), err: err.trim() }); });
    p.on('error', (e) => { clearTimeout(kill); resolve({ code: 1, out, err: String(e.message) }); });
  });
}

/** Perform one pointer/keyboard action on the session's own desktop. */
export async function desktopAct(sessionId: string, a: DesktopAction): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = xinputArgs(a);
  const { display } = await ownDesktop(sessionId);
  return actOn(display, args);
}

async function actOn(display: string, args: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await run([XINPUT, ...args], display);
  if (r.code !== 0) return { ok: false, error: r.err || `xinput exited ${r.code}` };
  return { ok: true };
}

// ---- the SHARED desktop (the owner's screen, :99) — only through the lease in shared-desktop.ts ------------------

/** The shared display, or an error when this host has none to drive. */
export function sharedDisplay(): string {
  const driver = pickDriver();
  if (driver.id !== 'x11') throw new Error(`desktop control needs the x11 driver (Linux); this host uses "${driver.id}"`);
  const d = String(cfg.screen?.display || ':99');
  if (!/^:\d+$/.test(d)) throw new Error('this host has no shared desktop display');
  return d;
}

/** One action on the shared desktop. The caller has checked the lease and the input guards. */
export async function sharedAct(a: DesktopAction): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = xinputArgs(a);
  const display = sharedDisplay();
  const sd = await import('./shared-desktop.js');
  return sd.agentInput(() => actOn(display, args));
}

/**
 * sign_in's vault fill: type ONE value into whatever has focus on the shared desktop. The value goes to xinput.py on
 * stdin (argv shows in `ps`), the error text never carries it, and nothing here logs it. The caller has checked the
 * lease and the fill guard (lib/sign-in.ts sharedFillGuard).
 */
export async function sharedTypeSecret(value: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const display = sharedDisplay();
  const sd = await import('./shared-desktop.js');
  return sd.agentInput(
    () =>
      new Promise((resolve) => {
        const p = spawn('python3', [XINPUT, 'type-secret'], { env: { ...process.env, DISPLAY: display }, stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 30_000);
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => {
          clearTimeout(kill);
          resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim().replace(/^xinput: /, '') || `xinput exited ${code}` });
        });
        p.on('error', (e) => { clearTimeout(kill); resolve({ ok: false, error: String(e.message) }); });
        p.stdin.end(value);
      })
  );
}

export interface ActiveWindow {
  pid: number | null;
  wmClass: string;
  title: string;
}

/** The focused window on the shared desktop (xprop): its process, class and title. Null when it cannot be read. */
export async function sharedActiveWindow(): Promise<ActiveWindow | null> {
  const display = sharedDisplay();
  const xprop = (args: string[]) =>
    new Promise<string>((resolve) => {
      const p = spawn('xprop', args, { env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 3000);
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => { clearTimeout(kill); resolve(out); });
      p.on('error', () => { clearTimeout(kill); resolve(''); });
    });
  const root = await xprop(['-root', '_NET_ACTIVE_WINDOW']);
  const id = /window id # (0x[0-9a-f]+)/i.exec(root)?.[1];
  if (!id || /^0x0$/i.test(id)) return null;
  const w = await xprop(['-id', id, '_NET_WM_PID', 'WM_CLASS', '_NET_WM_NAME']);
  const pid = Number(/_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(w)?.[1]) || null;
  const wmClass = /WM_CLASS\(STRING\) = (.*)/.exec(w)?.[1]?.trim() || '';
  const title = /_NET_WM_NAME\(UTF8_STRING\) = "(.*)"/.exec(w)?.[1] || '';
  return { pid, wmClass, title };
}

export async function sharedScreenshot(sessionId: string): Promise<DesktopShot> {
  sharedDisplay();
  const cap = await captureScreen(screenTarget(null));
  return keepShot(sessionId, cap.png, cap.width ?? null, cap.height ?? null);
}

/** Start a browser on the shared desktop (the owner's own, when it is not running). Not tracked for desktop_quit. */
export function sharedLaunch(command: string, args: string[]): { pid: number } {
  if (!command || /[\s;&|`$<>]/.test(command)) throw new Error('command must be a single program name or path (put its arguments in args)');
  const child = spawn(command, args.map(String), { env: chromeEnv({ ...process.env, DISPLAY: sharedDisplay() }), detached: true, stdio: 'ignore' });
  child.unref();
  if (!child.pid) throw new Error(`could not start ${command}`);
  return { pid: child.pid };
}

export interface DesktopShot {
  png: Buffer;
  width: number | null;
  height: number | null;
  ts: number;
  file: string;
}

/**
 * A fresh frame of the session's desktop, taken NOW (never a cached one) and kept as a file the model can
 * also open by path. Coordinates in the image are SCREEN pixels — what the pointer actions take.
 */
export async function desktopScreenshot(sessionId: string): Promise<DesktopShot> {
  const driver = pickDriver();
  if (driver.id !== 'x11') throw new Error(`desktop control needs the x11 driver (Linux); this host uses "${driver.id}"`);
  await driver.ensure(sessionId);
  const cap = await driver.capture(sessionId);
  return keepShot(sessionId, cap.png, cap.width ?? null, cap.height ?? null);
}

function keepShot(sessionId: string, png: Buffer, width: number | null, height: number | null): DesktopShot {
  const dir = path.join(process.env.ARIGAMI_DIR || path.join(os.homedir(), '.arigami'), 'desktop-shots', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const file = path.join(dir, `${ts}.png`);
  fs.writeFileSync(file, png);
  // keep only the last few frames of a session
  try {
    const old = fs.readdirSync(dir).sort().slice(0, -8);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
  return { png, width, height, ts, file };
}

const launched = new Map<string, Map<number, { cmd: string }>>(); // session → pid → record

const CHROME_RE = /(?:^|\/)(?:google-chrome(?:-stable|-beta|-unstable)?|chrome|chromium(?:-browser)?|arigami-chrome)$/;

/**
 * Chrome/Chromium args with the container flags (chrome.ts chromeExtraFlags — `--no-sandbox` & co. in a pod, where the
 * sandbox can't start and a launch would die silently) added when missing. Anything else is returned as is. Pure.
 */
export function launchArgs(command: string, args: string[], flags: string[]): string[] {
  if (!CHROME_RE.test(command)) return args;
  return [...flags.filter((f) => !args.includes(f)), ...args];
}

/**
 * Start a program on the session's own desktop, detached (it must outlive this call — a background process
 * that dies with its launching shell is how a first-use test lost its Chrome). Returns its pid.
 */
export async function desktopLaunch(sessionId: string, command: string, args: string[] = []): Promise<{ pid: number }> {
  if (!command || /[\s;&|`$<>]/.test(command)) throw new Error('command must be a single program name or path (put its arguments in args)');
  const { display } = await ownDesktop(sessionId);
  const env = { ...process.env, DISPLAY: display };
  const child = spawn(command, launchArgs(command, args.map(String), chromeExtraFlags()), {
    env: CHROME_RE.test(command) ? chromeEnv(env) : env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  if (!child.pid) throw new Error(`could not start ${command}`);
  if (!launched.has(sessionId)) launched.set(sessionId, new Map());
  launched.get(sessionId)!.set(child.pid, { cmd: command });
  return { pid: child.pid };
}

/** Stop a program started with desktopLaunch (and only those). */
export function desktopQuit(sessionId: string, pid: number): { ok: boolean; error?: string } {
  const rec = launched.get(sessionId)?.get(pid);
  if (!rec) return { ok: false, error: `pid ${pid} was not launched by this session's desktop_launch` };
  try {
    process.kill(-pid, 'SIGTERM'); // the whole group: Chrome forks
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  launched.get(sessionId)!.delete(pid);
  return { ok: true };
}

/** Forget a session's launches (archive/delete). */
export function desktopRelease(sessionId: string): void {
  for (const pid of launched.get(sessionId)?.keys() ?? []) {
    try { process.kill(-pid, 'SIGTERM'); } catch {}
  }
  launched.delete(sessionId);
}
