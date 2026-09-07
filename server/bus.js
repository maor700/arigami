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

// EXT: in-process subscribers. `broadcast` is server→client; extensions (and
// anything else inside the host) need the same stream without a socket, so
// every broadcast ALSO goes to the subscribers here, and `emitLocal` publishes
// domain events that have no place on the wire. One misbehaving subscriber must
// never stop a broadcast — each call is isolated.
const subs = new Set();

/** Subscribe to every bus message. Returns the unsubscribe function. */
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function subscriberCount() {
  return subs.size;
}

function fanout(msg) {
  if (!subs.size) return;
  for (const fn of subs) {
    try { fn(msg); } catch { /* a subscriber's bug is not the bus's problem */ }
  }
}

export function broadcast(msg) {
  fanout(msg);
  if (!wss.clients.size) return;
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState === 1 /* OPEN */) {
      try { c.send(data); } catch {}
    }
  }
}

/**
 * A DOMAIN event: subscribers only, never the WebSocket. The names are part of
 * the public extension API (sdk/README.md) — `merge.done`, `listener.fired`,
 * `review.approved`, … — and are deliberately dotted so they can't collide with
 * the dashed/colon-separated wire event types above.
 */
export function emitLocal(name, payload = {}) {
  fanout({ type: name, ...payload });
}

export function clientCount() {
  return wss.clients.size;
}
