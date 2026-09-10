// The "agent's desktop" interface — pure extraction, no new behavior.
//
// Today every session's screen/browser story is Xvfb+x11vnc (server/lib/
// desktops.ts), a hand-rolled RFB client + scrot/import fallback
// (server/vnc.ts) and XTEST typing (skills/_lib/xinput.py) — all Linux-only.
// Arigami is going to run as a desktop app on macOS/Windows too, where none
// of that exists (no X server to spawn, no VNC to bridge, no XTEST to type
// through). This file is the seam: every caller that used to reach into
// desktops.ts/vnc.ts/xinput.py directly now goes through a `ScreenDriver`
// instead, so a future macOS/Windows implementation is a second file behind
// `pickDriver()`, not a rewrite of chrome.ts/api.ts/screenshots.ts.
//
// `pickDriver()` picks x11 on Linux (dev checkout or a Linux desktop build)
// and native-window everywhere else — see screen-driver-x11.ts and
// screen-driver-native.ts. ARIGAMI_SCREEN_DRIVER forces either one, mainly
// so native-window can be exercised on a Linux dev box that has no real
// desktop-app build to run.

/**
 * Opaque per-session (or global) desktop handle. Callers must not read
 * fields off it except `kind` — everything else (display number, VNC host/
 * port…) is x11-driver-internal. `Record<string, unknown>` keeps the type
 * usable without a cast for the driver's OWN internals, which do need those
 * fields; external callers (api.ts, chrome-cdp.ts…) only ever check `kind`
 * or pass the handle back into another driver method.
 */
export type SurfaceHandle = { readonly kind: string } & Record<string, unknown>;

/**
 * How a viewer should reach this desktop. Replaces handing vncHost/vncPort/
 * password to callers outside the driver.
 *
 * `interactive` — whether input (mouse/keyboard) reaches the machine over
 * this transport, or the viewer can only watch. The cockpit needs this to be
 * a property of the TRANSPORT rather than an assumption baked into the client:
 * useScreenConnection.js used to hardcode "RFB, therefore interactive", which
 * silently made every non-x11 host unusable for a take-over. A `false` here is
 * a real answer ("look, don't touch"), not a missing feature — the UI can then
 * say so instead of showing a canvas that eats clicks.
 *
 * `scope` — how much of the machine the viewer actually sees: the whole
 * desktop (x11's framebuffer) or just the browser window (CDP screencast).
 * Surfaced so the take-over UI can tell the human what they are NOT getting
 * before they need it (a native file dialog opening outside the frame).
 */
export type ViewerDescriptor =
  | { transport: 'rfb'; path: string; needsPassword: boolean; interactive: boolean; scope: 'desktop' | 'browser' }
  | { transport: 'screencast'; path: string; interactive: boolean; scope: 'desktop' | 'browser' }
  | { transport: 'native'; note: string; interactive: boolean; scope: 'desktop' | 'browser' };

export interface CaptureResult {
  png: Buffer;
  width?: number;
  height?: number;
  frame?: { width: number; height: number; rgba: Buffer }; // present when captured pixel-exact (lets callers hash/downscale)
  via: string; // driver-defined provenance tag ('rfb' | 'x11' for the x11 driver)
}

export interface ScreenDriver {
  readonly id: 'x11' | 'native-window' | 'winvnc';
  /** Can this driver run at all on this host right now (binaries present, platform match)? */
  available(): Promise<{ ok: boolean; reason?: string }>;
  /** Lazily allocate/spawn (or reuse) this session's own desktop. Throws on failure — callers fall back to whatever `peek()`/global default they already had. */
  ensure(sessionId: string): Promise<SurfaceHandle>;
  /** Tear down a session's own desktop (archive/delete). */
  release(sessionId: string): void;
  /** This session's OWN desktop right now, no allocation, no I/O — null if it has none. Synchronous: claude.js's process-spawn path can't await. */
  peek(sessionId?: string | null): SurfaceHandle | null;
  /** Env vars a spawned process (the session's own `claude`) needs to reach this session's desktop, if any. Async twin of `peek()` for callers that CAN await — not used by claude.js today (see report). */
  childEnv(sessionId: string): Promise<NodeJS.ProcessEnv>;
  /** Env + extra argv a BROWSER launch needs (DISPLAY today; a macOS driver may need neither). */
  browserLaunch(sessionId: string): Promise<{ env: NodeJS.ProcessEnv; extraArgs: string[] }>;
  /** One frame of this session's desktop (its own if allocated, else the shared fallback). */
  capture(sessionId: string): Promise<CaptureResult>;
  /** Type into whatever has focus on this session's desktop, when no CDP tab is available. */
  typeText(sessionId: string, text: string, press?: 'Enter'): Promise<{ via: string }>;
  /** How a client should open a live view of this session's desktop. */
  viewer(sessionId?: string | null): Promise<ViewerDescriptor>;
  /** Bridge an already-upgraded viewer socket to this session's desktop (the /__vnc path today). */
  attachViewer(ws: unknown, sessionId?: string | null): Promise<void>;
  /** The human is about to take over this session's desktop. */
  handOver(sessionId: string): Promise<{ focused: boolean; note?: string }>;
  /** The human is done; the agent resumes. */
  handBack(sessionId: string): Promise<void>;
  /**
   * Reachability + ownership for status UI (sidebar icon, machine panel).
   *
   * `perSession` — whether this host can give a session a machine OF ITS OWN.
   * True on x11 (a private Xvfb per session) and native-window (a private
   * Chrome per session); FALSE on winvnc, because Windows has one console
   * desktop that every session shares. The machine side panel keys off it:
   * without it, a shared-desktop host reports `own:false` forever and the
   * panel offers to "allocate a machine" that already exists and can never be
   * allocated — an empty state in front of a working desktop.
   */
  status(sessionId?: string | null): Promise<{ available: boolean; own: boolean; perSession?: boolean; detail?: string; display?: string }>;
}

/**
 * x11 on Linux, native-window everywhere else (a compiled desktop build is
 * never Linux+Xvfb — see isCompiledBinary()'s own doc for why that signal,
 * not just `process.platform`, is what actually distinguishes "dev checkout"
 * from "shipped app"). `env`/`platform` are injectable for tests.
 * ARIGAMI_SCREEN_DRIVER=x11|native-window|winvnc overrides the decision
 * outright — the only way to exercise a foreign host's shape on a Linux dev
 * box, and how every non-Linux path in this repo is tested.
 *
 * `winvnc` (whole-desktop control of a Windows machine through a VNC service
 * running on it — screen-driver-winvnc.ts) is **opt-in on win32**, never
 * inferred: deciding it by probing a port would make driver selection async
 * everywhere, and a single slow probe at the wrong moment would silently
 * downgrade the whole machine to browser-only. A Windows host without the
 * service keeps native-window — browser-window control still works there, so
 * the failure mode of not opting in is "less", never "nothing".
 */
export function pickDriver(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ScreenDriver {
  const forced = env.ARIGAMI_SCREEN_DRIVER;
  if (forced === 'native-window') return nativeDriver();
  if (forced === 'x11') return x11Driver();
  if (forced === 'winvnc') return winVncDriver();
  if (platform === 'win32' && env.ARIGAMI_WIN_VNC === '1') return winVncDriver();
  if (platform !== 'linux' || isCompiledBinary()) return nativeDriver();
  return x11Driver();
}

// Lazy import + singleton: screen-driver-x11.ts pulls in desktops.ts/vnc.ts,
// which have their own module-level state (the `alive`/`pending` maps) —
// keeping construction behind a function (rather than constructing at
// top-level import time) is what made the native-window branch above a
// one-line addition instead of a restructure.
import { createX11Driver } from './screen-driver-x11.js';
import { createNativeDriver } from './screen-driver-native.js';
import { createWinVncDriver } from './screen-driver-winvnc.js';
import { isCompiledBinary } from './resource-root.js';
let _x11: ScreenDriver | null = null;
function x11Driver(): ScreenDriver {
  if (!_x11) _x11 = createX11Driver();
  return _x11;
}
let _native: ScreenDriver | null = null;
function nativeDriver(): ScreenDriver {
  if (!_native) _native = createNativeDriver();
  return _native;
}
let _winvnc: ScreenDriver | null = null;
function winVncDriver(): ScreenDriver {
  if (!_winvnc) _winvnc = createWinVncDriver();
  return _winvnc;
}
