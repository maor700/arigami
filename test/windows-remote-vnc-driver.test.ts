// The winvnc ScreenDriver (server/lib/screen-driver-winvnc.ts): whole-desktop
// remote control of a Windows machine by talking to a VNC service running on
// it, instead of the browser-only CDP path.
//
// The point of this file: the driver's contract is "speak RFB to a VNC server
// on this machine's loopback", and RFB is RFB — the Windows service and the
// x11vnc on this Linux box are the same protocol. So everything except the
// Windows-specific service INSTALL is testable here for real: the driver is
// pointed at a genuine Xvfb+x11vnc pair spawned by this test, and its capture
// path has to come back with actual pixels. What no test here can cover is
// Windows' own session isolation and the installer — docs/WINDOWS-REMOTE.md §4
// lists those explicitly.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { runInChild } from './_child.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const have = (bin: string) => {
  try { return Bun.spawnSync(['sh', '-c', `command -v ${bin}`]).exitCode === 0; } catch { return false; }
};
const HAVE_VNC = have('Xvfb') && have('x11vnc');

let xvfb: ChildProcess | null = null;
let x11vnc: ChildProcess | null = null;
let vncPort = 0;
let display = '';

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

async function waitPort(port: number, ms = 10000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port, timeout: 400 });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); resolve(false); });
      s.once('timeout', () => { s.destroy(); resolve(false); });
    });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}

beforeAll(async () => {
  if (!HAVE_VNC) return;
  // A display number this box is not already using — /tmp/.X<n>-lock is the
  // same signal desktops.ts's own allocator reads.
  let n = 240;
  while (fs.existsSync(`/tmp/.X${n}-lock`) || fs.existsSync(`/tmp/.X11-unix/X${n}`)) n++;
  display = `:${n}`;
  vncPort = await freePort();
  xvfb = spawn('Xvfb', [display, '-screen', '0', '640x480x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !fs.existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
  x11vnc = spawn('x11vnc', ['-display', display, '-rfbport', String(vncPort), '-localhost', '-shared', '-forever', '-noxdamage', '-quiet', '-nopw'], { stdio: 'ignore' });
  await waitPort(vncPort);
}, 40000);

afterAll(() => {
  try { x11vnc?.kill('SIGKILL'); } catch {}
  try { xvfb?.kill('SIGKILL'); } catch {}
});

/**
 * Run `body` in a child with an isolated ARIGAMI_DIR, the winvnc driver forced,
 * and cfg.screen pointed at whatever VNC endpoint the caller wants — that
 * config IS the driver's entire notion of "the machine's VNC service".
 */
function inChild(body: string, port: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-winvnc-'));
  const r = runInChild(body, {
    ARIGAMI_DIR: dir,
    ARIGAMI_PORT: '',
    ARIGAMI_WA_AUTOSTART: '0',
    ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
    ARIGAMI_SCREEN_DRIVER: 'winvnc',
    ARIGAMI_SCREEN_ENABLED: '1',
    ARIGAMI_VNC_HOST: '127.0.0.1',
    ARIGAMI_VNC_PORT: String(port),
    ARIGAMI_GLOBAL_DESKTOP: '0',
  });
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

// ---- selection --------------------------------------------------------------

test('pickDriver: winvnc is opt-in on win32, never inferred — a Windows box without the service keeps browser-window control', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-winvnc-pick-'));
  const r = runInChild(
    "const {pickDriver}=await import('./server/lib/screen-driver.ts');" +
    "emit({" +
    "plainWin: pickDriver({}, 'win32').id," +
    "optedIn: pickDriver({ARIGAMI_WIN_VNC:'1'}, 'win32').id," +
    "forced: pickDriver({ARIGAMI_SCREEN_DRIVER:'winvnc'}, 'linux').id," +
    "linuxUntouched: pickDriver({}, 'linux').id," +
    "macUntouched: pickDriver({ARIGAMI_WIN_VNC:'1'}, 'darwin').id" +
    "});",
    { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_WA_AUTOSTART: '0', ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa') }
  );
  if (!r.ok) throw new Error(r.error);
  const out = r.out[0];
  expect(out.plainWin).toBe('native-window'); // no service opted into → not "nothing", just less
  expect(out.optedIn).toBe('winvnc');
  expect(out.forced).toBe('winvnc');
  expect(out.linuxUntouched).toBe('x11'); // the platform everyone actually runs on is untouched
  expect(out.macUntouched).toBe('native-window'); // the win32 opt-in is win32-only
});

// ---- against a REAL RFB server ---------------------------------------------

test.skipIf(!HAVE_VNC)('winvnc: available()/status() report the real VNC service as reachable', () => {
  const out = inChild(
    "const {createWinVncDriver}=await import('./server/lib/screen-driver-winvnc.ts');" +
    "const d=createWinVncDriver();" +
    "emit({available: await d.available(), status: await d.status('s1'), handle: await d.ensure('s1')});",
    vncPort
  );
  expect(out.available).toEqual({ ok: true });
  expect(out.status.available).toBe(true);
  // One console desktop, shared by every session — never reported as a
  // session's own machine (ScreenSidePanel.jsx keys off this).
  expect(out.status.own).toBe(false);
  expect(out.handle).toMatchObject({ kind: 'winvnc', vncPort });
});

test.skipIf(!HAVE_VNC)('winvnc: capture() returns REAL desktop pixels over RFB — the whole point vs. browser-only', () => {
  const out = inChild(
    "const {createWinVncDriver}=await import('./server/lib/screen-driver-winvnc.ts');" +
    "const c=await createWinVncDriver().capture('s1');" +
    "emit({via: c.via, width: c.width, height: c.height, pngHead: [...c.png.subarray(0,8)], bytes: c.png.length, frame: !!c.frame});",
    vncPort
  );
  expect(out.via).toBe('rfb');
  // The Xvfb this test spawned is 640x480 — proof the pixels came from the
  // desktop framebuffer and not from some browser viewport.
  expect(out.width).toBe(640);
  expect(out.height).toBe(480);
  expect(out.pngHead).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
  expect(out.bytes).toBeGreaterThan(1000);
  expect(out.frame).toBe(true); // raw RGBA present → screenshots.ts can dedup
});

test('winvnc: with NO service reachable, every entry point fails with one actionable message instead of hanging', async () => {
  const dead = await freePort(); // nothing is listening here
  const out = inChild(
    "const {createWinVncDriver}=await import('./server/lib/screen-driver-winvnc.ts');" +
    "const d=createWinVncDriver();" +
    "let ensureErr=null; try { await d.ensure('s1'); } catch (e) { ensureErr=e.message; }" +
    "emit({available: await d.available(), status: await d.status('s1'), ensureErr});",
    dead
  );
  expect(out.available.ok).toBe(false);
  expect(out.available.reason).toContain('no VNC service answering');
  expect(out.status.available).toBe(false);
  // The message has to tell a human what to DO, not just that something is off.
  expect(out.ensureErr).toContain('install/start');
  expect(out.ensureErr).toContain('ARIGAMI_WIN_VNC');
});

// ---- the descriptor the cockpit reads --------------------------------------

test('winvnc: viewer() is an ordinary rfb descriptor, so the cockpit needs no new client code', () => {
  const out = inChild(
    "const {createWinVncDriver}=await import('./server/lib/screen-driver-winvnc.ts');" +
    "emit(await createWinVncDriver().viewer('s1'));",
    5900
  );
  expect(out).toMatchObject({ transport: 'rfb', interactive: true, scope: 'desktop' });
  // No ?session= — Windows has ONE console desktop, and bridgeToVnc's
  // per-session path is Xvfb-only and would reject on every call.
  expect(out.path).toBe('/__vnc');
});

test('winvnc: browserLaunch strips an ambient DISPLAY and does not maximize onto a real desktop', () => {
  const out = inChild(
    "const {createWinVncDriver}=await import('./server/lib/screen-driver-winvnc.ts');" +
    "process.env.DISPLAY=':77'; process.env.XAUTHORITY='/tmp/xa'; process.env.WAYLAND_DISPLAY='wl-0';" +
    "const b=await createWinVncDriver().browserLaunch('s1');" +
    "emit({d: b.env.DISPLAY ?? null, x: b.env.XAUTHORITY ?? null, w: b.env.WAYLAND_DISPLAY ?? null, args: b.extraArgs, childEnv: await createWinVncDriver().childEnv('s1')});",
    5900
  );
  expect(out.d).toBeNull();
  expect(out.x).toBeNull();
  expect(out.w).toBeNull();
  expect(out.args).not.toContain('--start-maximized');
  expect(out.childEnv).toEqual({});
});

test('winvnc: release() does NOT tear the machine down — the console desktop outlives any one session', () => {
  // The bug this guards: copying x11's releaseDesktop() would take the shared
  // Windows desktop away from every other session (and from the human at the
  // keyboard) the first time one session was archived.
  const out = inChild(
    "const {createWinVncDriver}=await import('./server/lib/screen-driver-winvnc.ts');" +
    "const d=createWinVncDriver();" +
    "d.release('s1');" +
    "emit({stillThere: d.peek('s1'), threw: false});",
    5900
  );
  expect(out.stillThere).toMatchObject({ kind: 'winvnc' });
});
