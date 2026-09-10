// Live, INTERACTIVE view of a session's native-window desktop (server/lib/
// screen-driver-native.ts's `viewer`/`attachViewer`) — the screencast
// equivalent of /__vnc's RFB bridge (server/vnc.ts). There is no VNC server to
// bridge to when the native-window driver is active (the "desktop" is a real
// window on a real screen, not something this host renders), so instead this
// drives Chrome's own CDP `Page.startScreencast` and re-frames each JPEG
// straight onto the viewer's WebSocket — and relays that viewer's mouse and
// keyboard back into the page through CDP `Input.*`.
//
// It used to be VIEW-ONLY, with this reasoning: native-window's premise is
// that Chrome is a real window on the end user's real screen, so whoever is
// sitting at that machine already has full physical control of it — nothing
// to relay. That reasoning holds for the machine the human is SITTING AT (a
// MacBook running the desktop app) and breaks completely for the case this
// file now also has to serve: a machine nobody is sitting at. A Windows box
// added as one of the human's machines is driven entirely from the cockpit,
// possibly from a phone; "you already have physical control" is false there,
// and a request_screen take-over that can only show pixels is not a take-over
// at all. On x11 that same take-over gets full mouse+keyboard over RFB, so
// view-only here was the concrete thing making Windows/macOS second-class.
//
// The reach is still the Chrome WINDOW, not the whole desktop — CDP cannot
// click the Windows taskbar, a native file dialog or a UAC prompt. Closing
// THAT half needs a real desktop-capture+SendInput path on the machine (a VNC
// server service, or a native agent); see docs/WINDOWS-REMOTE.md. This closes
// the half that needs no software installed on the machine at all.
//
// Wire protocol — the contract web/src/lib/screencastClient.js is built
// against:
//   Client opens `new WebSocket(".../__screencast?session=<id>")` — same
//   auth gate as /__vnc (the cookie/bearer check in server/index.ts's
//   `upgrade` handler runs before either path is dispatched to). No
//   subprotocol is required or negotiated.
//   Server -> client, one TEXT message per frame, JSON:
//     { "type": "frame", "data": "<base64 jpeg>", "width": number,
//       "height": number, "ts": <ms epoch> }
//     { "type": "error", "message": "<human-readable>" } — sent at most
//       once (no Chrome tab for this session, CDP unreachable, …),
//       immediately followed by the server closing the socket.
//   Client -> server, TEXT JSON, one input event per message (see
//   `inputToCdp` for the exact shapes and their CDP translation):
//     { "type":"mouse", "action":"move"|"down"|"up"|"wheel", x, y, ... }
//     { "type":"key", "action":"down"|"up", key, code, keyCode, ... }
//     { "type":"text", "text":"…" }   ← insertText, for IME/paste/unicode
//   Anything unrecognized is dropped silently — a newer client talking to an
//   older host degrades to view-only rather than erroring the socket.
//   One Page.startScreencast CDP session per WebSocket connection; closing
//   or erroring either socket tears down the other.
//
// Trust model: identical to /__vnc's. That bridge pipes raw RFB both ways
// with no server-side view-only enforcement either — whoever can open the
// socket can already drive the machine. `viewOnly` is a CLIENT-side policy in
// both transports (useScreenConnection.js only lets the highest-priority
// visible consumer send input), and the real gate is the auth check that runs
// before the upgrade is dispatched.
import { WebSocketServer, WebSocket } from 'ws';
import { cfg } from './state.js';
import { frontPage } from './lib/chrome-cdp.js';

const wss = new WebSocketServer({ noServer: true });

function sendError(ws: WebSocket, message: string): void {
  try { ws.send(JSON.stringify({ type: 'error', message })); } catch {}
  try { ws.close(); } catch {}
}

// ---- input relay ------------------------------------------------------------

/** CDP's modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
function modifierMask(m: any): number {
  return (m?.alt ? 1 : 0) | (m?.ctrl ? 2 : 0) | (m?.meta ? 4 : 0) | (m?.shift ? 8 : 0);
}

const MOUSE_TYPE: Record<string, string> = {
  move: 'mouseMoved',
  down: 'mousePressed',
  up: 'mouseReleased',
  wheel: 'mouseWheel',
};

const BUTTONS = new Set(['none', 'left', 'middle', 'right', 'back', 'forward']);

/**
 * One client input message → the CDP call to make, or null to drop it.
 *
 * Pure and exported so the whole translation table is unit-testable without a
 * socket or a Chrome (test/screencast-input.test.ts) — the coordinate/keycode
 * mapping is the part with real bugs in it, and it is exactly the part that
 * cannot be checked by looking at a screenshot.
 *
 * Coordinates arrive already in PAGE space: the client scales them from its
 * canvas using the width/height the server sent with each frame, so a phone
 * showing a 320px-wide scaled view still lands its taps on the right element.
 * Anything non-finite is dropped rather than passed to Chrome as NaN.
 */
export function inputToCdp(msg: any): { method: string; params: Record<string, unknown> } | null {
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'text') {
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (!text) return null;
    return { method: 'Input.insertText', params: { text } };
  }

  if (msg.type === 'mouse') {
    const type = MOUSE_TYPE[String(msg.action)];
    if (!type) return null;
    const x = Number(msg.x), y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const button = BUTTONS.has(String(msg.button)) ? String(msg.button) : 'left';
    const params: Record<string, unknown> = {
      type,
      x: Math.round(x),
      y: Math.round(y),
      modifiers: modifierMask(msg.modifiers),
    };
    if (type === 'mouseWheel') {
      // A wheel event has no button and no clickCount; Chrome ignores a
      // wheel whose deltas are both 0, so don't bother sending one.
      const dx = Number(msg.deltaX) || 0, dy = Number(msg.deltaY) || 0;
      if (!dx && !dy) return null;
      params.deltaX = dx;
      params.deltaY = dy;
      params.button = 'none';
    } else if (type === 'mouseMoved') {
      // A move is a HOVER unless something is actually held. The client sends
      // the DOM's `e.button`, which is 0 ("left") on a plain pointermove — so
      // taking it at face value would tell Chrome the left button is involved
      // in every mouse movement. `buttons` (the bitmask of what is held) is
      // the field that distinguishes the two, and it is also what makes Chrome
      // treat a move as a drag rather than a hover.
      const held = Number(msg.buttons) || 0;
      params.button = held ? button : 'none';
      params.buttons = held;
    } else {
      params.button = button;
      params.clickCount = Number(msg.clickCount) || 1;
      params.buttons = Number(msg.buttons) || 0;
    }
    return { method: 'Input.dispatchMouseEvent', params };
  }

  if (msg.type === 'key') {
    const type = msg.action === 'up' ? 'keyUp' : msg.action === 'down' ? 'keyDown' : null;
    if (!type) return null;
    const key = typeof msg.key === 'string' ? msg.key : '';
    if (!key) return null;
    const params: Record<string, unknown> = {
      type,
      key,
      code: typeof msg.code === 'string' ? msg.code : '',
      windowsVirtualKeyCode: Number(msg.keyCode) || 0,
      nativeVirtualKeyCode: Number(msg.keyCode) || 0,
      modifiers: modifierMask(msg.modifiers),
      autoRepeat: !!msg.repeat,
    };
    // `text` is what makes a keyDown actually insert a character. Only a
    // single-character `key` is printable text (per the DOM spec everything
    // longer is a named key: 'Enter', 'ArrowLeft', 'F5'…), and only when no
    // Ctrl/Meta is held — Ctrl+C must stay a shortcut, not the letter "c".
    // Enter and Tab are the two named keys with a text form Chrome expects
    // ('\r', '\t') — Enter matching what chrome-cdp.ts's typeIntoDesktop
    // already sends. Every other named key carries no text at all.
    if (type === 'keyDown' && !msg.modifiers?.ctrl && !msg.modifiers?.meta) {
      if ([...key].length === 1) params.text = key;
      else if (key === 'Enter') params.text = '\r';
      else if (key === 'Tab') params.text = '\t';
    }
    return { method: 'Input.dispatchKeyEvent', params };
  }

  return null;
}

/** Bridge an already-upgraded viewer socket to `sessionId`'s Chrome screencast. Exported so screen-driver-native.ts's attachViewer can drive it the same way the raw /__screencast upgrade handler below does. */
export async function bridgeToScreencast(ws: WebSocket, sessionId: string | null): Promise<void> {
  if (!sessionId) return sendError(ws, 'native-window screencast requires ?session=<id>');
  let page;
  try {
    page = await frontPage(sessionId);
  } catch (e) {
    return sendError(ws, (e as Error).message);
  }
  if (ws.readyState !== 1 /* OPEN */) return; // client gone while we awaited the tab lookup

  const cdp = new WebSocket(page.webSocketDebuggerUrl!);
  let cdpId = 1;
  const send = (method: string, params: Record<string, unknown> = {}) => {
    try { cdp.send(JSON.stringify({ id: cdpId++, method, params })); } catch {}
  };
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    send('Page.stopScreencast');
    try { cdp.close(); } catch {}
    try { ws.close(); } catch {}
  };

  cdp.onopen = () => {
    send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  };
  cdp.onmessage = (ev: any) => {
    let msg: any;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.method !== 'Page.screencastFrame') return;
    const { data, metadata, sessionId: cdpSessionId } = msg.params || {};
    if (ws.readyState === 1 /* OPEN */) {
      try {
        ws.send(JSON.stringify({
          type: 'frame',
          data,
          width: metadata?.deviceWidth,
          height: metadata?.deviceHeight,
          ts: Date.now(),
        }));
      } catch {}
    }
    // Ack unconditionally, even if the viewer socket is gone: this is the
    // signal Chrome waits for before producing the next frame, and
    // withholding it because a slow client hasn't drained yet would stall
    // the capture pipeline for a reason Chrome has no way to detect itself.
    send('Page.screencastFrameAck', { sessionId: cdpSessionId });
  };
  // Viewer -> page. Fire-and-forget over the SAME CDP socket the frames come
  // in on: an input event whose reply we waited for would serialize the whole
  // stream behind a round trip, and there is nothing useful in the reply.
  // Ordering is preserved because it is one socket.
  ws.on('message', (raw: any) => {
    if (closed || cdp.readyState !== 1 /* OPEN */) return;
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const call = inputToCdp(msg);
    if (call) send(call.method, call.params);
  });
  cdp.onerror = () => cleanup();
  cdp.onclose = () => cleanup();
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

wss.on('connection', (ws: WebSocket, req: any) => {
  const sessionId = new URL(req.url || '/', 'http://localhost').searchParams.get('session');
  void bridgeToScreencast(ws, sessionId);
});

export function handleUpgrade(req: any, socket: any, head: Buffer): void {
  if (!cfg.screen?.enabled) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => wss.emit('connection', ws, req));
}
