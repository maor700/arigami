// RESUME — the cockpit half's pure parts (web/src/lib/resume.js): the /__ws
// query, the cursor, applying a full / delta / legacy `state`, the open chat's
// gap riding on the replay, which chats a reconnect fills now vs. later, and
// the late gap fill landing in seq order (chat-merge.appendChatEvents).
import { test, expect } from 'bun:test';
import zlib from 'node:zlib';
import { wsQuery, nextCursor, applyState, stateChatGap, planGapFill, lastSeq, explanationsKey, inflateFrame } from '../web/src/lib/resume.js';
import { appendChatEvents } from '../web/src/lib/chat-merge.js';

const q = (s) => Object.fromEntries(new URLSearchParams(s.slice(1)));

test('wsQuery: wire v2 always; z, cursor and the open chat gap only when known', () => {
  expect(q(wsQuery(null, false))).toEqual({ wire: '2' });
  expect(q(wsQuery(null, true))).toEqual({ wire: '2', z: '1' });
  expect(q(wsQuery({ rev: 7, boot: 'b1' }, true, { sid: 's1', from: 40 }, 1500))).toEqual({
    wire: '2', z: '1', since: '7', boot: 'b1', open: 's1', seq: '40', clip: '1500',
  });
  // a half-known cursor is no cursor
  expect(q(wsQuery({ rev: 7 }, false))).toEqual({ wire: '2' });
});

test('nextCursor: a v2 state resets it, a stamped broadcast advances it, an old host clears it', () => {
  let c = nextCursor(null, { type: 'state', v: 2, rev: 10, boot: 'b' });
  expect(c).toEqual({ rev: 10, boot: 'b' });
  c = nextCursor(c, { type: 'session-updated', wrev: 12 });
  expect(c).toEqual({ rev: 12, boot: 'b' });
  expect(nextCursor(c, { type: 'session-updated', wrev: 11 })).toBe(c); // never backwards
  expect(nextCursor(c, { type: 'health' })).toBe(c);
  expect(nextCursor(c, { type: 'state', sessions: [] })).toBe(null); // legacy host
  expect(nextCursor(null, { type: 'session-updated', wrev: 3 })).toBe(null); // no base yet
});

test('applyState v2 full: exactly what the host sent', () => {
  const cur = [{ id: 'a' }, { id: 'old', archived: true }];
  const r = applyState(cur, { type: 'state', v: 2, rev: 1, boot: 'b', sessions: [{ id: 'a', title: 'A' }, { id: 'c' }] });
  expect(r).toEqual({ sessions: [{ id: 'a', title: 'A' }, { id: 'c' }], legacy: false, delta: false });
});

test('applyState v2 delta: changed replaced in place, new appended, deleted removed, rest untouched', () => {
  const b = { id: 'b', title: 'B' };
  const cur = [{ id: 'a', title: 'A', changesExplained: { pr: '1' } }, b, { id: 'gone' }];
  const r = applyState(cur, { type: 'state', v: 2, delta: true, sessions: [{ id: 'a', title: 'A2' }, { id: 'n' }], deleted: ['gone'] });
  expect(r.delta).toBe(true);
  expect(r.sessions.map((s) => s.id)).toEqual(['a', 'b', 'n']);
  expect(r.sessions[0]).toEqual({ id: 'a', title: 'A2' }); // replaced, not merged
  expect(r.sessions[1]).toBe(b);
});

test('applyState legacy (old host): its list plus the archived sessions it did not mention', () => {
  const cur = [{ id: 'a' }, { id: 'arch', archived: true }, { id: 'live-gone' }];
  const r = applyState(cur, { type: 'state', sessions: [{ id: 'a', x: 1 }] });
  expect(r.legacy).toBe(true);
  expect(r.sessions).toEqual([{ id: 'a', x: 1 }, { id: 'arch', archived: true }]);
  // no sessions array at all → nothing changes
  expect(applyState(cur, { type: 'state' }).sessions).toBe(cur);
});

test('stateChatGap: only the gap we asked for (same chat, same seq)', () => {
  const gap = { sid: 's1', from: 40 };
  const events = [{ seq: 41 }];
  expect(stateChatGap({ chat: { sessionId: 's1', since: 40, events } }, gap)).toBe(events);
  expect(stateChatGap({ chat: { sessionId: 's1', since: 39, events } }, gap)).toBe(null);
  expect(stateChatGap({ chat: { sessionId: 's2', since: 40, events } }, gap)).toBe(null);
  expect(stateChatGap({}, gap)).toBe(null); // an old host / too big a gap → REST
  expect(stateChatGap({ chat: { sessionId: 's1', since: 40, events } }, null)).toBe(null);
});

test('planGapFill: the open chat now, the others later — each from its last persisted seq', () => {
  const chats = {
    open: [{ seq: 1 }, { seq: 5 }, { kind: 'local' }],
    other: [{ seq: 9 }],
    unloaded: [{ seq: 3 }],
  };
  const r = planGapFill({ open: true, other: true, unloaded: false }, chats, 'open');
  expect(r).toEqual({ now: [{ sid: 'open', from: 5 }], later: { other: 9 } });
  expect(planGapFill({ other: true }, chats, null)).toEqual({ now: [], later: { other: 9 } });
  expect(lastSeq([])).toBe(0);
});

test('explanationsKey: stable over key order, null without stamps', () => {
  expect(explanationsKey({ changesExplained: { pr: '1', work: '2' } })).toBe(explanationsKey({ changesExplained: { work: '2', pr: '1' } }));
  expect(explanationsKey({ changesExplained: { pr: '1' } })).not.toBe(explanationsKey({ changesExplained: { pr: '2' } }));
  expect(explanationsKey({})).toBe(null);
});

test('inflateFrame: a binary gzip frame back to its JSON text', async () => {
  const text = JSON.stringify({ type: 'state', v: 2, sessions: [{ id: 'a' }] });
  const gz = zlib.gzipSync(text);
  const ab = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
  expect(await inflateFrame(ab)).toBe(text);
});

test('appendChatEvents: a late gap lands before the live rows that came after it', () => {
  // the chat was not open at reconnect (stale from seq 2); live 5,6 arrived since
  const onScreen = [{ id: 'e1', seq: 1 }, { id: 'e2', seq: 2 }, { id: 'e5', seq: 5 }, { id: 'e6', seq: 6 }];
  const gap = [{ id: 'e3', seq: 3 }, { id: 'e4', seq: 4 }, { id: 'e5', seq: 5 }, { id: 'e6', seq: 6 }];
  expect(appendChatEvents(onScreen, gap).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  // the ordinary case is unchanged: newer rows go at the end
  expect(appendChatEvents([{ id: 'a', seq: 1 }], [{ id: 'b', seq: 2 }]).map((e) => e.seq)).toEqual([1, 2]);
});
