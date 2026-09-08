// The native-window ScreenDriver — for macOS/Windows (and any compiled
// desktop build), where there is no X server to fake: a session's Chrome
// window is a REAL window on the end user's REAL screen, so there is no
// "desktop" for this driver to allocate, capture pixels from off a fake
// framebuffer, or synthesize input into. Every method here either does
// nothing (nothing to spawn, nothing to tear down) or talks CDP to the
// session's already-running Chrome — see chrome-cdp.ts for the raw
// WebSocket-to-DevTools plumbing this reuses, and screencast.ts for the
// live-view transport `viewer`/`attachViewer` hand off to.
import { cfg } from './config.js';
import { findChromeBin } from './platform.js';
import { frontPage, cdpCall, cdpPort } from './chrome-cdp.js';
import { bridgeToScreencast } from '../screencast.js';
import type { ScreenDriver, SurfaceHandle, CaptureResult, ViewerDescriptor } from './screen-driver.js';

function handle(): SurfaceHandle {
  return { kind: 'native-window' };
}

// PNG's IHDR chunk always starts at byte 12 (8-byte signature + 4-byte chunk
// length), with width/height as two big-endian uint32s right after the
// 4-byte "IHDR" tag — reading them directly avoids pulling in a PNG decoder
// just to report dimensions CDP's Page.captureScreenshot already encoded.
function pngDimensions(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function createNativeDriver(): ScreenDriver {
  return {
    id: 'native-window',

    async available() {
      if (!cfg.screen?.enabled) return { ok: false, reason: 'screen share disabled' };
      if (!findChromeBin()) return { ok: false, reason: 'Chrome/Chromium not found on this machine' };
      return { ok: true };
    },

    async ensure(_sessionId) {
      // Nothing to allocate — the desktop already exists; it's the user's own.
      return handle();
    },

    release(_sessionId) {
      // Nothing owned per-session to tear down (Chrome's own lifecycle is
      // chrome.ts's job either way, same as on x11).
    },

    peek(sessionId) {
      return sessionId ? handle() : null;
    },

    async childEnv(_sessionId) {
      // Returns {} — never {...process.env} — so there is nothing here for
      // an ambient DISPLAY/XAUTHORITY to leak through (same class of bug as
      // browserLaunch below). Not that it matters yet: claude.js spawns the
      // session's own process synchronously and reads the driver's
      // synchronous peek() instead (this method can't be awaited from
      // there) — see server/claude.js's own comment on that call site.
      return {};
    },

    async browserLaunch(_sessionId) {
      // Deliberately DELETE DISPLAY/XAUTHORITY/WAYLAND_DISPLAY rather than
      // just not setting them: process.env is ambient — this host process
      // may itself be running with a stray DISPLAY (a systemd unit's env, a
      // dev shell, another session's Xvfb from the x11 driver elsewhere in
      // this same process). Forwarding that would silently open Chrome on
      // whatever unrelated display happens to be set instead of the user's
      // real screen — exactly the bug this driver exists to prevent. The
      // OS's own windowing APIs find the real screen without any of these;
      // nothing needs to be added, only these three ever need removing.
      // No --start-maximized either: on a real monitor that takes over the
      // whole desktop, which a native window must never do — an ordinary,
      // movable, reasonably-sized window instead.
      const env = { ...process.env };
      delete env.DISPLAY;
      delete env.XAUTHORITY;
      delete env.WAYLAND_DISPLAY;
      return {
        env,
        extraArgs: ['--window-size=1280,900', '--window-position=48,48'],
      };
    },

    async capture(sessionId) {
      // Throws '...call browser_open first' when there's no tab — no
      // fallback capture path exists (there is no fake framebuffer to read
      // instead), so that error is the correct, honest result.
      const page = await frontPage(sessionId);
      const shot = await cdpCall(page.webSocketDebuggerUrl!, 'Page.captureScreenshot', { format: 'png' });
      const png = Buffer.from(shot.data as string, 'base64');
      const dims = pngDimensions(png);
      // No `frame` (raw RGBA): CDP only ever hands back compressed bytes, and
      // the contract says not to fabricate pixel data we don't have —
      // screenshots.ts's dedup already falls back to a PNG hash without it.
      const result: CaptureResult = { png, via: 'cdp' };
      if (dims) { result.width = dims.width; result.height = dims.height; }
      return result;
    },

    async typeText(sessionId, text, press) {
      if (!text) throw new Error('empty text');
      // CDP only — deliberately no XTEST-style fallback. That fallback moves
      // the END USER'S real mouse cursor, which is exactly what this driver
      // exists to avoid. frontPage() throws a clear, actionable error
      // ('call browser_open first') when there's no tab to type into.
      const page = await frontPage(sessionId);
      const ws = page.webSocketDebuggerUrl!;
      await cdpCall(ws, 'Input.insertText', { text });
      if (press === 'Enter') {
        await cdpCall(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await cdpCall(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      }
      return { via: 'cdp' };
    },

    async viewer(sessionId): Promise<ViewerDescriptor> {
      return {
        transport: 'screencast',
        path: sessionId ? `/__screencast?session=${encodeURIComponent(sessionId)}` : '/__screencast',
      };
    },

    async attachViewer(ws, sessionId) {
      await bridgeToScreencast(ws as any, sessionId ?? null);
    },

    async handOver(sessionId) {
      try {
        const page = await frontPage(sessionId);
        await cdpCall(page.webSocketDebuggerUrl!, 'Page.bringToFront', {});
        return { focused: true };
      } catch (e) {
        return { focused: false, note: (e as Error).message };
      }
    },

    async handBack() {
      // Nothing to release — same as x11: the window's lifecycle doesn't
      // depend on who's currently looking at it.
    },

    async status(sessionId) {
      if (!sessionId) {
        const a = await this.available();
        return { available: a.ok, own: false, detail: a.reason };
      }
      const port = cdpPort(sessionId);
      return {
        available: port != null,
        own: port != null,
        detail: port != null ? undefined : 'no Chrome DevTools port for this session yet',
      };
    },
  };
}
