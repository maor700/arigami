// The winvnc ScreenDriver — real, whole-desktop remote control of a Windows
// machine, by talking to a VNC service running ON that machine.
//
// Why this shape (the reasoning is in docs/WINDOWS-REMOTE.md, in full):
// a VNC server on Windows mirrors the CONSOLE session — the same desktop the
// session's Chrome is on — which is exactly what Xvfb+x11vnc gives us on
// Linux. RFB is RFB, so everything downstream is already written and already
// carrying production traffic: /__vnc's TCP↔WebSocket bridge (server/vnc.ts),
// noVNC in the cockpit, and the framebuffer capture in `captureFrame()`. None
// of that is X11-specific. What IS Windows-specific is only "is a VNC server
// running, and where" — which is this file, and almost nothing else.
//
// The one structural difference from x11, and it is not cosmetic: **there are
// no per-session desktops here.** Xvfb gives every Linux session a private
// display; Windows has one console session, and every session on the machine
// shares it. So `ensure()` does not allocate anything, `peek()` reports the
// same shared surface for everyone, and `status().own` is always false — the
// cockpit's machine panel reads that flag precisely so it can say "this is
// the shared machine" instead of implying a session owns it.
//
// Selection: `pickDriver()` never picks this by inference. It is opt-in
// (ARIGAMI_SCREEN_DRIVER=winvnc, or ARIGAMI_WIN_VNC=1 on win32) because the
// alternative — probing a port to decide — would either make driver selection
// async everywhere or silently downgrade the whole machine to browser-only
// for one slow probe at the wrong moment. A Windows host WITHOUT the service
// keeps the native-window driver and the browser-window control that comes
// with it, rather than losing everything.
//
// UNVERIFIED ON REAL WINDOWS — see docs/WINDOWS-REMOTE.md §4. The logic here
// is exercised against a real RFB server on Linux (test/windows-remote-vnc-
// driver.test.ts points it at a live x11vnc, which is the same protocol the
// Windows service speaks); what no test here can cover is the service install
// and Windows' own session isolation.
import net from 'node:net';
import { cfg } from './config.js';
import { captureScreen, bridgeToVnc } from '../vnc.js';
import { frontPage, cdpCall } from './chrome-cdp.js';
import type { ScreenDriver, SurfaceHandle, CaptureResult, ViewerDescriptor } from './screen-driver.js';

/** Where the machine's VNC service is. Loopback by default: the /__vnc bridge is meant to be the only path in, same trust model as Linux. */
export function vncTarget(): { vncHost: string; vncPort: number } {
  return { vncHost: cfg.screen?.vncHost || '127.0.0.1', vncPort: cfg.screen?.vncPort || 5900 };
}

/** Raw TCP reachability probe — same one the x11 driver uses for its own servers. */
export function probeVnc(host: string, port: number, timeout = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

function handle(): SurfaceHandle {
  const t = vncTarget();
  // No `display`: there is no X display here, and inventing one would make
  // childEnv/browserLaunch leak a DISPLAY that means nothing on Windows.
  return { kind: 'winvnc', vncHost: t.vncHost, vncPort: t.vncPort };
}

/** The actionable form of "there is no VNC service on this machine" — this string ends up in front of a human, so it says what to do. */
function notReachable(): string {
  const t = vncTarget();
  return `no VNC service answering on ${t.vncHost}:${t.vncPort} — install/start the machine's VNC service (see docs/WINDOWS-REMOTE.md), or unset ARIGAMI_WIN_VNC to fall back to browser-window control`;
}

export function createWinVncDriver(): ScreenDriver {
  return {
    id: 'winvnc',

    async available() {
      if (!cfg.screen?.enabled) return { ok: false, reason: 'screen share disabled' };
      const t = vncTarget();
      if (!(await probeVnc(t.vncHost, t.vncPort))) return { ok: false, reason: notReachable() };
      return { ok: true };
    },

    async ensure(_sessionId) {
      // Nothing to spawn — the VNC service is managed by Windows, not by us.
      // Still probe, so a caller that asked for a machine and got a resolved
      // promise really can be shown one; the alternative is a black canvas
      // several seconds later with no explanation.
      const t = vncTarget();
      if (!(await probeVnc(t.vncHost, t.vncPort))) throw new Error(notReachable());
      return handle();
    },

    release(_sessionId) {
      // The console desktop outlives every session on it. Killing the VNC
      // service because one session was archived would take the machine away
      // from every other session AND from the human sitting at it.
    },

    peek(_sessionId) {
      // Synchronous by contract (claude.js's spawn path can't await), so this
      // cannot probe. The shared desktop is always "there" as far as
      // addressing goes; reachability is `status()`/`available()`'s job.
      return handle();
    },

    async childEnv(_sessionId) {
      // Nothing to inject: no DISPLAY, no XAUTHORITY on Windows. Explicitly
      // {} rather than {...process.env} so an ambient DISPLAY inherited from
      // somewhere odd can't leak through (same class of bug the native
      // driver's own comment describes).
      return {};
    },

    async browserLaunch(_sessionId) {
      const env = { ...process.env };
      delete env.DISPLAY;
      delete env.XAUTHORITY;
      delete env.WAYLAND_DISPLAY;
      // No --start-maximized: unlike a bare Xvfb, this is a real desktop with
      // a real window manager and, possibly, a human looking at it. An
      // ordinary window, same as the native-window driver.
      return { env, extraArgs: ['--window-size=1280,900', '--window-position=48,48'] };
    },

    async capture(_sessionId) {
      // The WHOLE desktop, not just the browser — the parity win. Note
      // captureScreen() falls back to scrot/import, which do not exist on
      // Windows; that fallback simply never fires there and the RFB error
      // surfaces instead, which is the honest outcome.
      const cap = await captureScreen({ ...vncTarget() });
      return cap as CaptureResult;
    },

    async typeText(sessionId, text, press) {
      if (!text) throw new Error('empty text');
      // CDP into the front tab. There is no XTEST on Windows, so unlike x11
      // there is no whole-desktop typing fallback here — typing into a
      // non-Chrome window has to go through the interactive VNC canvas, which
      // this driver's whole point is to make available. Keeping the CDP path
      // matters because the take-over modal's "type into the desktop" box is
      // how a one-time code gets in without crossing the clipboard.
      const page = await frontPage(sessionId);
      const ws = page.webSocketDebuggerUrl!;
      await cdpCall(ws, 'Input.insertText', { text });
      if (press === 'Enter') {
        await cdpCall(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await cdpCall(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      }
      return { via: 'cdp' };
    },

    async viewer(_sessionId): Promise<ViewerDescriptor> {
      // Deliberately the SAME descriptor shape the x11 driver returns, with
      // no ?session= (there is one desktop). The cockpit already renders
      // `rfb` with noVNC, so this driver needs zero client-side code — that
      // is what the transport seam in screen-driver.ts was for.
      return {
        transport: 'rfb',
        path: '/__vnc',
        needsPassword: !!cfg.screen?.vncPassword,
        interactive: true,
        scope: 'desktop',
      };
    },

    async attachViewer(ws, _sessionId) {
      // null, never the sessionId: passing one would send bridgeToVnc down
      // its ensureDesktop() path, which is Xvfb-only and would reject on
      // every call. null goes straight to the configured target — the
      // machine's own VNC service.
      await bridgeToVnc(ws as any, null);
    },

    async handOver(sessionId) {
      // Bring the session's Chrome to the front so the human taking over sees
      // what the agent was doing, rather than whatever window happened to be
      // on top of the shared desktop. Best-effort: no Chrome open is a normal
      // state (a take-over for something that isn't a browser task at all).
      try {
        const page = await frontPage(sessionId);
        await cdpCall(page.webSocketDebuggerUrl!, 'Page.bringToFront', {});
        return { focused: true };
      } catch (e) {
        return { focused: false, note: (e as Error).message };
      }
    },

    async handBack() {
      // Nothing to release — the desktop's lifecycle is independent of who is
      // currently driving it.
    },

    async status(_sessionId) {
      const t = vncTarget();
      const available = !!cfg.screen?.enabled && (await probeVnc(t.vncHost, t.vncPort));
      return {
        available,
        // Always false, and that is the truth, not a stub: Windows has one
        // console desktop and every session shares it. ScreenSidePanel.jsx
        // reads this to avoid rendering a shared desktop as a session's own.
        own: false,
        // …and no session ever CAN own one here, which is a different
        // statement from "hasn't got one yet". The panel must show the shared
        // desktop rather than an allocate button that cannot do anything.
        perSession: false,
        detail: available ? undefined : notReachable(),
      };
    },
  };
}
