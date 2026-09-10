// The x11 ScreenDriver — today's (and, for now, only) implementation. Every
// method here is a thin adapter over the existing Xvfb+x11vnc machinery in
// desktops.ts, the RFB client + scrot/import fallback in vnc.ts, and the
// XTEST typing in skills/_lib/xinput.py — none of that logic moved, it just
// gained one indirection so callers stop reaching into those modules by name.
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cfg } from './config.js';
import * as state from '../state.js';
import * as desktops from './desktops.js';
import { captureScreen, bridgeToVnc } from '../vnc.js';
import { resourceRoot } from './resource-root.js';
import type { ScreenDriver, SurfaceHandle, CaptureResult, ViewerDescriptor } from './screen-driver.js';

const XINPUT = path.join(resourceRoot(), 'skills', '_lib', 'xinput.py');

function toHandle(d: { display: string; vncHost: string; vncPort: number }): SurfaceHandle {
  return { kind: 'x11', display: d.display, vncHost: d.vncHost, vncPort: d.vncPort };
}

/** Own-desktop metadata for a session, no I/O — mirrors the `own` check every screen-status/type caller already did ad hoc. */
function ownMeta(sessionId: string): { display?: string; vncPort?: number } | undefined {
  return (state.getSession(sessionId)?.metadata as any)?.screen;
}

/** Raw TCP reachability probe — moved here verbatim from api.ts's probeVnc(). */
function probeVnc(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 800 });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

function xinputRun(display: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', [XINPUT, ...args], { env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `xinput exit ${code}`))));
  });
}

export function createX11Driver(): ScreenDriver {
  return {
    id: 'x11',

    async available() {
      const reason = desktops.desktopUnsupportedReason();
      if (reason) return { ok: false, reason };
      if (!cfg.screen?.enabled) return { ok: false, reason: 'screen share disabled' };
      return { ok: true };
    },

    async ensure(sessionId) {
      const info = await desktops.ensureDesktop(sessionId);
      return toHandle(info);
    },

    release(sessionId) {
      desktops.releaseDesktop(sessionId);
    },

    peek(sessionId) {
      if (!sessionId) return null;
      const m = ownMeta(sessionId);
      if (!m?.display || !m?.vncPort) return null;
      return toHandle({ display: m.display, vncHost: '127.0.0.1', vncPort: m.vncPort });
    },

    async childEnv(sessionId) {
      const h = this.peek(sessionId);
      return h?.display ? { DISPLAY: String(h.display) } : {};
    },

    async browserLaunch(sessionId) {
      const info = await desktops.ensureDesktop(sessionId);
      // --start-maximized used to be hardcoded in chrome.ts for every driver;
      // it now lives here because it's an x11-only need — Xvfb's virtual
      // screen has no window manager, so an unmaximized Chrome opens at
      // whatever default size Chrome picks, cropped by the screen edges.
      return { env: { ...process.env, DISPLAY: info.display }, extraArgs: ['--start-maximized'] };
    },

    async capture(sessionId) {
      const cap = await captureScreen(desktops.screenTarget(sessionId));
      return cap as CaptureResult;
    },

    async typeText(sessionId, text, press) {
      if (!text) throw new Error('empty text');
      const h = this.peek(sessionId);
      const display = h?.display ? String(h.display) : undefined;
      if (!display) throw new Error('no browser or desktop for this session');
      await xinputRun(display, ['type', text]);
      if (press === 'Enter') await xinputRun(display, ['key', 'Return']);
      return { via: 'xinput' };
    },

    async viewer(sessionId): Promise<ViewerDescriptor> {
      return {
        transport: 'rfb',
        path: sessionId ? `/__vnc?session=${encodeURIComponent(sessionId)}` : '/__vnc',
        needsPassword: !!cfg.screen?.vncPassword,
        // RFB carries pointer/keyboard both ways, and the framebuffer is the
        // WHOLE Xvfb display — every window on it, not just a browser. This is
        // the bar the other drivers are measured against.
        interactive: true,
        scope: 'desktop',
      };
    },

    async attachViewer(ws, sessionId) {
      await bridgeToVnc(ws as any, sessionId ?? null);
    },

    async handOver(sessionId) {
      await desktops.ensureDesktop(sessionId).catch(() => {});
      return { focused: true };
    },

    async handBack() {
      // Nothing x11-specific to release — the desktop's lifecycle is
      // independent of who's currently driving it.
    },

    async status(sessionId) {
      const own = !!sessionId && !!ownMeta(sessionId)?.vncPort;
      const target = desktops.screenTarget(sessionId);
      const available = !!cfg.screen?.enabled && (await probeVnc(target.vncHost, target.vncPort));
      // Xvfb gives every session a display of its own — the panel may offer
      // to allocate one.
      return { available, own, perSession: true, display: target.display };
    },
  };
}
