// CHATWS — the partial-page merges (web/src/lib/chat-merge.js).
// Before: "load earlier" ran the older page through mergeChatEvents, whose
// full-snapshot rule ("older than the newest snapshot row and not in it →
// persisted → drop") threw the whole page away; the reconnect refill
// (…/chat?since=) did the same to everything already on screen. Both are
// pure functions, tested without a DOM.
import { test, expect } from 'bun:test';
import { prependChatEvents, appendChatEvents, mergeChatEvents } from '../web/src/lib/chat-merge.js';

const ev = (seq, extra = {}) => ({ id: `e${seq}`, seq, ts: seq * 10, kind: 'assistant-text', text: `t${seq}`, ...extra });

test('mergeChatEvents (full snapshot) is NOT a page merge — documents why the helpers exist', () => {
  expect(mergeChatEvents([ev(1)], [ev(2)]).map((e) => e.id)).toEqual(['e2']); // the older row is dropped
});

test('prependChatEvents: the older page lands in front, nothing on screen is lost', () => {
  const screen = [ev(61), ev(62), ev(63)];
  const page = [ev(1), ev(2), ev(60)];
  const out = prependChatEvents(page, screen);
  expect(out.map((e) => e.seq)).toEqual([1, 2, 60, 61, 62, 63]);
  expect(out[3]).toBe(screen[0]); // identity of on-screen rows kept (memoized rows don't remount)
});

test('prependChatEvents: overlap with what is on screen is deduped by id and by seq', () => {
  const screen = [ev(60), { seq: 61, kind: 'user', ts: 610 }, ev(62)];
  const page = [ev(59), ev(60), { seq: 61, kind: 'user', ts: 610 }];
  expect(prependChatEvents(page, screen).map((e) => e.seq)).toEqual([59, 60, 61, 62]);
  expect(prependChatEvents([], screen)).toBe(screen);
  expect(prependChatEvents(null, screen)).toBe(screen);
});

test('appendChatEvents: a since-slice is appended, the history stays', () => {
  const screen = [ev(1), ev(2), ev(3)];
  const gap = [ev(4), ev(5)];
  expect(appendChatEvents(screen, gap).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(appendChatEvents(screen, [])).toBe(screen);
});

test('appendChatEvents: rows the socket already delivered are not duplicated; a persisted row replaces its streamed partial', () => {
  const partial = { id: 'e4', seq: 4, ts: 40, kind: 'assistant-text', text: 'par' };
  const screen = [ev(3), partial, ev(5)];
  const gap = [ev(4, { text: 'partial → full' }), ev(5), ev(6)];
  const out = appendChatEvents(screen, gap);
  expect(out.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
  expect(out[1].text).toBe('partial → full');
});
