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
