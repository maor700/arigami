// Pure helpers for reconciling a persisted chat snapshot with events already in
// the store. Extracted from store.js so it can be unit-tested without a DOM.
//
// WS 'chat' events that arrive while a REST /chat fetch is in flight get
// appended to the live array, and those same events are ALSO in the snapshot
// (the server persisted them) — a naive concat renders them twice. Keep the
// snapshot (authoritative, oldest→newest), then re-append only the live events
// that either aren't in the snapshot by identity OR are strictly newer than it
// (streamed in after the snapshot was taken).

export function chatKey(e) {
  return e?.id ?? e?.requestId ?? (e?.ts != null ? `${e.kind}:${e.ts}` : null);
}

export function mergeChatEvents(existing, snapshot) {
  if (!Array.isArray(snapshot) || !snapshot.length) return existing;
  const snapKeys = new Set(snapshot.map(chatKey).filter(Boolean));
  const maxTs = snapshot.reduce(
    (m, e) => (typeof e?.ts === 'number' && e.ts > m ? e.ts : m),
    0
  );
  const extra = (existing || []).filter((e) => {
    const k = chatKey(e);
    if (k && snapKeys.has(k)) return false; // already represented in the snapshot
    if (typeof e?.ts === 'number' && maxTs && e.ts <= maxTs) return false; // persisted → in snapshot
    return true;
  });
  return [...snapshot, ...extra];
}

// F6: a persisted chat holds the {kind:'setup'} card AND every `setup-update`
// the host appended for it (same requestId). Live, store.js patches the card
// in place; on (re)load the snapshot must be folded the same way, otherwise
// a reloaded page shows a done card as "needs you" again. Updates carry the
// FULL narration list (the last one wins); the update rows themselves are
// dropped — nothing renders them.
// A1: the same fold applies to {kind:'agent-card'} + 'agent-card-update' (keyed by cardId).
// CHAT1: the same fold covers the answer rows — `permission-answer` onto its
// `permission-request` (and, for a "Question for you" card, onto the
// AskUserQuestion `tool-use` by toolUseId, carrying the picks) and
// `screen-request-answer` onto its `screen-request`. Live, store.js patches
// those cards in place and never appends the answer row; on (re)load the
// snapshot must match, otherwise a reloaded page (or the other device) shows
// an answered question with live buttons again.
const FOLDED = new Set(['setup-update', 'agent-card-update', 'permission-answer', 'screen-request-answer']);
export function foldSetupUpdates(events) {
  if (!Array.isArray(events) || !events.some((e) => FOLDED.has(e?.kind))) return events;
  const out = [];
  const cardAt = new Map(); // requestId / cardId -> index in `out`
  const toolAt = new Map(); // toolUseId -> index in `out` (AskUserQuestion cards)
  for (const e of events) {
    if (e?.kind === 'setup' || e?.kind === 'agent-card' || e?.kind === 'permission-request' || e?.kind === 'screen-request') {
      cardAt.set(e.requestId ?? e.cardId ?? e.id, out.length);
      out.push(e);
      continue;
    }
    if (e?.kind === 'tool-use' && e.toolUseId) toolAt.set(e.toolUseId, out.length);
    if (e?.kind === 'setup-update' || e?.kind === 'agent-card-update') {
      const idx = cardAt.get(e.requestId ?? e.cardId ?? e.id);
      if (idx == null) continue; // update without its card in this page — nothing to show
      const { kind: _k, requestId: _r, cardId: _c, ts: _ts, seq: _seq, ...patch } = e;
      out[idx] = { ...out[idx], ...patch };
      continue;
    }
    if (e?.kind === 'permission-answer') {
      const idx = cardAt.get(e.requestId);
      if (idx != null && out[idx].answered == null) out[idx] = { ...out[idx], answered: e.behavior, answeredMessage: e.message };
      const ti = e.toolUseId ? toolAt.get(e.toolUseId) : undefined;
      if (ti != null && out[ti].answered == null) out[ti] = { ...out[ti], answered: e.behavior, ...(e.answers ? { answers: e.answers } : {}) };
      continue;
    }
    if (e?.kind === 'screen-request-answer') {
      const idx = cardAt.get(e.requestId);
      if (idx != null && out[idx].answered == null) out[idx] = { ...out[idx], answered: true, note: e.note, takenOver: !!e.takenOver };
      continue;
    }
    out.push(e);
  }
  return out;
}

// CHATWS: the two PARTIAL-page merges. mergeChatEvents above assumes the
// snapshot is the authoritative FULL transcript (anything older than its
// newest row and absent from it "was persisted, so it is in the snapshot" →
// dropped). A page is not that: an older page (load earlier) or a since-gap
// (reconnect refill) covers only a slice, and every row already on screen
// must survive it. Both helpers key rows by chatKey (id / requestId /
// kind:ts) and by seq, keep order oldest→newest, and never duplicate.

function keysOf(list) {
  const ks = new Set();
  const seqs = new Set();
  for (const e of list || []) {
    const k = chatKey(e);
    if (k) ks.add(k);
    if (e?.seq > 0) seqs.add(e.seq);
  }
  return { ks, seqs };
}
function known(e, { ks, seqs }) {
  const k = chatKey(e);
  return (k && ks.has(k)) || (e?.seq > 0 && seqs.has(e.seq));
}

/** An OLDER page goes in front of what is on screen. */
export function prependChatEvents(older, existing) {
  if (!Array.isArray(older) || !older.length) return existing || [];
  const have = keysOf(existing);
  const fresh = older.filter((e) => !known(e, have));
  return fresh.length ? [...fresh, ...(existing || [])] : existing || [];
}

/** A NEWER slice (…/chat?since=seq) goes after what is on screen. Rows the
 *  live socket already delivered are skipped; a streamed partial that the
 *  persisted row supersedes (same key) is replaced in place. */
export function appendChatEvents(existing, newer) {
  if (!Array.isArray(newer) || !newer.length) return existing || [];
  const cur = existing || [];
  const have = keysOf(cur);
  const byKey = new Map();
  for (const e of newer) {
    const k = chatKey(e);
    if (k) byKey.set(k, e);
  }
  // replace in place where the key matches (persisted form wins)
  const replaced = cur.map((e) => {
    const k = chatKey(e);
    return k && byKey.has(k) ? byKey.get(k) : e;
  });
  const fresh = newer.filter((e) => !known(e, have));
  return fresh.length ? [...replaced, ...fresh] : replaced;
}
