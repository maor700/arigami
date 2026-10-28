// WebSocket hub (/__ws). noServer mode: index.js hands us upgrades.
// Server → client only; clients act via REST. On connect: a state snapshot —
// full, or (RESUME) only what changed since the client's cursor.
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { RevTracker, WIRE_V2, slimHeavy, slimMessage } from './lib/wire-resume.js';

// permessage-deflate where the runtime negotiates it (node's `ws`). Bun's
// built-in `ws` shim accepts the option and never negotiates the extension
// (checked on bun 1.4) — those links get app-level gzip frames, see send().
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });

// RESUME: every session broadcast bumps a revision; a v2 client reconnecting
// with ?since=<rev>&boot=<id> gets just the sessions that changed meanwhile.
const tracker = new RevTracker();
/** Test hook / introspection. */
export function wireRev() {
  return { rev: tracker.rev, boot: tracker.boot };
}

// A v2 client that can inflate (?z=1 — it has DecompressionStream) gets frames
// above this size as ONE binary gzip frame instead of text, unless the link
// already deflates. A 190KB state replay goes out as ~40KB.
const GZIP_MIN = 4096;
function send(c, text) {
  if (c.gz && text.length >= GZIP_MIN && !/permessage-deflate/.test(c.extensions || '')) {
    try {
      c.send(zlib.gzipSync(text, { level: 6 }), { binary: true });
      return;
    } catch {}
  }
  try { c.send(text); } catch {}
}

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

wss.on('connection', async (ws, req) => {
  ws.isAlive = true;
  // RESUME: what this client speaks. No params = an old cockpit: full v1 form.
  let q = null;
  try { q = new URL(req?.url || '/', 'http://x').searchParams; } catch {}
  ws.wire = Number(q?.get('wire')) >= WIRE_V2 ? WIRE_V2 : 1;
  ws.gz = ws.wire >= WIRE_V2 && q?.get('z') === '1';
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
  const { listSessionsForWire, listListeners, listFolders, getSession, toWireSession } = await import('./state.js');
  let triggers = [];
  let pending = [];
  let queue = { autoplay: false, maxConcurrent: 3 };
  try {
    const t = await import('./triggers.js');
    ({ triggers, pending, queue } = t.snapshot());
  } catch {}
  if (ws.wire < WIRE_V2) {
    const rest = { listeners: listListeners(), folders: listFolders(), triggers, pending, queue };
    try { ws.send(JSON.stringify({ type: 'state', sessions: listSessionsForWire({ archived: true }), ...rest })); } catch {}
    return;
  }
  // The open chat's gap rides along (?open=<id>&seq=<last seq on screen>): a
  // waking phone gets the replay AND what it missed in the chat it is looking
  // at in one message, with no REST round trip after the handshake — and
  // atomically: this socket already receives live events, so nothing slips
  // between the two. A huge gap (or no such chat) is left to REST.
  const chat = await openChatGap(q, getSession);
  // Everything below is computed in one synchronous step after the last await,
  // so the replay is never older than a broadcast this socket already got.
  const rest = { listeners: listListeners(), folders: listFolders(), triggers, pending, queue };
  const since = q?.has('since') ? tracker.since(q.get('since'), q.get('boot')) : { full: true };
  const stamp = { v: WIRE_V2, rev: tracker.rev, boot: tracker.boot };
  const msg = since.full
    ? { type: 'state', ...stamp, sessions: listSessionsForWire({ archived: true }).map(slimHeavy), ...rest }
    : {
        type: 'state',
        ...stamp,
        delta: true,
        sessions: since.changed.map((id) => getSession(id)).filter(Boolean).map((s) => slimHeavy(toWireSession(s))),
        deleted: since.deleted,
        ...rest,
      };
  if (chat) msg.chat = chat;
  send(ws, JSON.stringify(msg));
});

const GAP_MAX_EVENTS = 300;
async function openChatGap(q, getSession) {
  const open = q?.get('open');
  const seq = Number(q?.get('seq'));
  if (!open || !Number.isInteger(seq) || seq < 0 || !getSession(open)) return null;
  try {
    const claude = await import('./claude.js');
    const events = claude.getChat(open, seq);
    if (!Array.isArray(events) || events.length > GAP_MAX_EVENTS) return null;
    const clip = Math.max(0, Number(q.get('clip')) || 0);
    return { sessionId: open, since: seq, events: clip ? claude.clipEvents(events, clip) : events };
  } catch {
    return null;
  }
}

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
  // noted even with nobody connected — that is exactly the client that will ask later
  const rev = tracker.note(msg);
  fanout(msg);
  if (!wss.clients.size) return;
  // Serialised once per wire form, and only if some client speaks it.
  let v1 = null;
  let v2 = null;
  for (const c of wss.clients) {
    if (c.readyState !== 1 /* OPEN */) continue;
    if (c.wire >= WIRE_V2) {
      v2 ??= JSON.stringify(rev == null ? slimMessage(msg) : { ...slimMessage(msg), wrev: rev });
      send(c, v2);
    } else {
      v1 ??= JSON.stringify(msg);
      try { c.send(v1); } catch {}
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
