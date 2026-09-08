// Live view of a session's native-window desktop (server/lib/screen-driver-
// native.ts's `viewer`/`attachViewer`) — the screencast equivalent of
// /__vnc's RFB bridge (server/vnc.ts). There is no VNC server to bridge to
// when the native-window driver is active (the "desktop" is a real window on
// a real screen, not something this host renders), so instead this drives
// Chrome's own CDP `Page.startScreencast` and re-frames each JPEG straight
// onto the viewer's WebSocket.
//
// This is VIEW-ONLY, on purpose: native-window's whole premise is that
// Chrome is a real window on the end user's real screen, so whoever is
// sitting at that machine already has full physical control of it — there
// is nothing to relay input through. The only reason this transport exists
// is that the cockpit is also opened from a phone, where "the window on
// your screen" is worthless because the viewer isn't in front of that
// screen; this gives that viewer something to look at.
//
// Wire protocol — this is the contract the client side (a future
// web/src/lib/useScreenConnection.js screencast branch) is built against;
// nothing else in this repo speaks it yet:
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
//   Client -> server: nothing is read; any message the client sends is
//   ignored — see the view-only note above.
//   One Page.startScreencast CDP session per WebSocket connection; closing
//   or erroring either socket tears down the other.
import { WebSocketServer, WebSocket } from 'ws';
import { cfg } from './state.js';
import { frontPage } from './lib/chrome-cdp.js';

const wss = new WebSocketServer({ noServer: true });

function sendError(ws: WebSocket, message: string): void {
  try { ws.send(JSON.stringify({ type: 'error', message })); } catch {}
  try { ws.close(); } catch {}
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
