// WebSocket hub (/__ws). noServer mode: index.js hands us upgrades.
// Server → client only; clients act via REST. On connect: full state snapshot.
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ noServer: true });

// CHATWS: liveness. A phone that goes to the background (or drops off wifi)
// leaves a socket that LOOKS open on both ends — the server keeps a ghost
// client, the browser never gets a `close` and so never reconnects. Two
// halves: (1) the server pings every client on an interval (ws-level ping;
// browsers answer with a pong automatically) and terminates the ones that
// missed the previous round; (2) a client may send `{type:"ping"}` and gets
// `{type:"pong", ts}` back — the only client→server message the hub accepts,
// so page JS (which cannot see ws-level pings) can prove the link is alive.
const HEARTBEAT_MS = 30_000;
function heartbeat() {
  for (const c of wss.clients) {
    if (c.isAlive === false) { try { c.terminate(); } catch {} continue; }
    c.isAlive = false;
    try { c.ping(); } catch {}
  }
}
const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
heartbeatTimer.unref?.();
/** Test hook: run one heartbeat round now. */
export function __heartbeat() { heartbeat(); }

wss.on('connection', async (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    ws.isAlive = true;
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg?.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now(), echo: msg.ts ?? null })); } catch {}
    }
  });
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
