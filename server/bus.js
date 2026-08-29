// WebSocket hub (/__ws). noServer mode: index.js hands us upgrades.
// Server → client only; clients act via REST. On connect: full state snapshot.
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (ws) => {
  // dynamic import breaks the state ⇄ bus import cycle
  const { listSessionsForWire, listListeners, listFolders } = await import('./state.js');
  let triggers = [];
  let pending = [];
  let queue = { autoplay: false, maxConcurrent: 3 };
  try {
    const t = await import('./triggers.js');
    ({ triggers, pending, queue } = t.snapshot());
  } catch {}
  try {
    ws.send(
      JSON.stringify({
        type: 'state',
        sessions: listSessionsForWire({ archived: true }),
        listeners: listListeners(),
        folders: listFolders(),
        triggers,
        pending,
        queue,
      })
    );
  } catch {}
});

export function handleUpgrade(req, socket, head) {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

export function broadcast(msg) {
  if (!wss.clients.size) return;
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState === 1 /* OPEN */) {
      try { c.send(data); } catch {}
    }
  }
}

export function clientCount() {
  return wss.clients.size;
}
