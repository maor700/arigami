// Screen-share bridge (/__vnc): terminates the browser's WebSocket connection
// and pipes its binary frames to/from a raw TCP connection to the VNC server
// configured in cfg.screen — the same role `websockify` plays for noVNC, done
// in-process with the `ws` package already used by bus.js (no new server
// dependency). Global (not per-session): one shared desktop, reachable
// regardless of which session tab is open. See docs on cfg.screen for the
// trust model — the VNC server itself is loopback-only; this bridge is the
// only path to it, gated the same way the rest of the host is (VPN).
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { cfg } from './state.js';

// noVNC's RFB class opens the socket with `new WebSocket(url, ['binary'])`
// and expects the server to select that subprotocol back — without it some
// noVNC versions refuse the connection.
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols: Set<string>) => (protocols.has('binary') ? 'binary' : false),
});

wss.on('connection', (ws: WebSocket) => {
  const { vncHost, vncPort } = cfg.screen;
  const tcp = net.connect(vncPort, vncHost);

  tcp.on('connect', () => {
    ws.on('message', (data: Buffer) => {
      try { tcp.write(data); } catch {}
    });
  });
  tcp.on('data', (chunk) => {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(chunk); } catch {}
    }
  });
  tcp.on('error', () => { try { ws.close(); } catch {} });
  tcp.on('close', () => { try { ws.close(); } catch {} });
  ws.on('close', () => { try { tcp.destroy(); } catch {} });
  ws.on('error', () => { try { tcp.destroy(); } catch {} });
});

export function handleUpgrade(req: any, socket: any, head: Buffer): void {
  if (!cfg.screen?.enabled) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => wss.emit('connection', ws, req));
}
