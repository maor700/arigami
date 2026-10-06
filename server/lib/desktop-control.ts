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
  const r = await run([XINPUT, ...args], display);
  if (r.code !== 0) return { ok: false, error: r.err || `xinput exited ${r.code}` };
  return { ok: true };
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
  const dir = path.join(process.env.ARIGAMI_DIR || path.join(os.homedir(), '.arigami'), 'desktop-shots', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const file = path.join(dir, `${ts}.png`);
  fs.writeFileSync(file, cap.png);
  // keep only the last few frames of a session
  try {
    const old = fs.readdirSync(dir).sort().slice(0, -8);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
  return { png: cap.png, width: cap.width ?? null, height: cap.height ?? null, ts, file };
}

const launched = new Map<string, Map<number, { cmd: string }>>(); // session → pid → record

/**
 * Start a program on the session's own desktop, detached (it must outlive this call — a background process
 * that dies with its launching shell is how a first-use test lost its Chrome). Returns its pid.
 */
export async function desktopLaunch(sessionId: string, command: string, args: string[] = []): Promise<{ pid: number }> {
  if (!command || /[\s;&|`$<>]/.test(command)) throw new Error('command must be a single program name or path (put its arguments in args)');
  const { display } = await ownDesktop(sessionId);
  const child = spawn(command, args.map(String), {
    env: { ...process.env, DISPLAY: display },
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
