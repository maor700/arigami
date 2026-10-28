// RESUME — the pure half of a fast return from the background (store.js wires
// it to the socket). Split out so the delta/cursor rules are testable without
// a DOM. The host side is server/lib/wire-resume.ts + server/bus.js.
//
// The client speaks wire v2 when it connects with `?wire=2`:
//   - list/broadcast sessions arrive without the heavy fields the rail never
//     renders (stamps instead — changesExplained, claude.mcp.sig, caps counts);
//     the open session's are fetched on demand;
//   - the `state` replay carries {v:2, rev, boot}; a reconnect that sends the
//     last rev + boot back gets {delta:true, sessions:[changed], deleted:[ids]};
//   - every session broadcast carries `wrev`, so the cursor tracks what the
//     page has actually seen;
//   - with `z=1` big frames come as one binary gzip frame;
//   - with `open=<id>&seq=<n>` the replay also carries that chat's gap
//     ({chat:{sessionId, since, events}}) — absent if the host can't/won't.
// A host that predates all this ignores the params and sends the old full
// `state` (no `v`) — applyState() falls back to the old merge for it.

export const WIRE = 2;

/** The /__ws query: wire version, inflate support, the resume cursor if we have one, and the open chat's gap start. */
export function wsQuery(cursor, canInflate, gap = null, clip = 0) {
  const q = new URLSearchParams({ wire: String(WIRE) });
  if (canInflate) q.set('z', '1');
  if (cursor && cursor.boot && Number.isInteger(cursor.rev)) {
    q.set('since', String(cursor.rev));
    q.set('boot', cursor.boot);
  }
  if (gap && gap.sid && Number.isInteger(gap.from)) {
    q.set('open', gap.sid);
    q.set('seq', String(gap.from));
    if (clip) q.set('clip', String(clip));
  }
  return `?${q}`;
}

/** The open chat's gap, if the replay carried it for the chat we asked about. */
export function stateChatGap(msg, gap) {
  const c = msg?.chat;
  if (!gap || !c || c.sessionId !== gap.sid || c.since !== gap.from || !Array.isArray(c.events)) return null;
  return c.events;
}

/** The cursor after a message: a v2 state resets it, a stamped broadcast advances it. */
export function nextCursor(cursor, msg) {
  if (!msg || typeof msg !== 'object') return cursor;
  if (msg.type === 'state') {
    if (msg.v >= WIRE && typeof msg.boot === 'string' && Number.isInteger(msg.rev)) return { rev: msg.rev, boot: msg.boot };
    return null; // an old host: nothing to resume from
  }
  if (cursor && Number.isInteger(msg.wrev) && msg.wrev > cursor.rev) return { ...cursor, rev: msg.wrev };
  return cursor;
}

/**
 * The session list after a `state` message.
 *   v2 full  → exactly what the host sent (it includes archived sessions)
 *   v2 delta → current list, changed sessions replaced, deleted ones removed
 *   legacy   → the host's list, plus archived sessions it did not mention (an
 *              old replay could omit them; the REST list fills them in)
 * Returns { sessions, legacy, delta }.
 */
export function applyState(current, msg) {
  const list = Array.isArray(msg?.sessions) ? msg.sessions.filter((s) => s && s.id) : null;
  const legacy = !(msg?.v >= WIRE);
  if (!list) return { sessions: current, legacy, delta: false };
  if (!legacy && msg.delta) {
    const gone = new Set(Array.isArray(msg.deleted) ? msg.deleted : []);
    const byId = new Map(list.map((s) => [s.id, s]));
    const out = [];
    for (const s of current || []) {
      if (gone.has(s.id)) continue;
      if (byId.has(s.id)) {
        out.push(byId.get(s.id));
        byId.delete(s.id);
      } else out.push(s);
    }
    for (const s of byId.values()) out.push(s);
    return { sessions: out, legacy: false, delta: true };
  }
  if (!legacy) return { sessions: list, legacy: false, delta: false };
  const ids = new Set(list.map((s) => s.id));
  const keepArchived = (current || []).filter((s) => s.archived && !ids.has(s.id));
  return { sessions: [...list, ...keepArchived], legacy: true, delta: false };
}

/** A binary frame is one gzip'd JSON text (the host's ?z=1 path). */
export async function inflateFrame(data) {
  const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

/** The last persisted chat seq on screen (locally injected rows have none). */
export function lastSeq(events) {
  for (let i = (events?.length || 0) - 1; i >= 0; i--) if (events[i]?.seq > 0) return events[i].seq;
  return 0;
}

/**
 * Which loaded chats a reconnect gap-fills NOW (the open one) and which it
 * only marks stale (filled when the user opens them), with the seq each one
 * had when the link came back — the gap starts there even if live rows land
 * on top before the fill does.
 */
export function planGapFill(chatLoaded, chats, openId) {
  const now = [];
  const later = {};
  for (const sid of Object.keys(chatLoaded || {})) {
    if (!chatLoaded[sid]) continue;
    const from = lastSeq(chats?.[sid]);
    if (sid === openId) now.push({ sid, from });
    else later[sid] = from;
  }
  return { now, later };
}

/** The heavy-field stamp of a session: changes whenever its changesExplanations would. */
export function explanationsKey(session) {
  const s = session?.changesExplained;
  return s && typeof s === 'object' ? JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]])) : null;
}
