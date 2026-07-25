// mergeChatEvents dedups a persisted snapshot against events already in the
// store (live WS events that arrived during the REST fetch, or during a
// reconnect gap) so nothing renders twice and nothing is dropped.
import { test, expect } from 'bun:test';
import { mergeChatEvents, chatKey } from '../web/src/lib/chat-merge.js';

test('empty snapshot returns existing untouched', () => {
  const live = [{ kind: 'assistant-text', ts: 5, text: 'hi' }];
  expect(mergeChatEvents(live, [])).toBe(live);
  expect(mergeChatEvents(live, null)).toBe(live);
});

test('overlapping live events are not duplicated (dedup by ts+kind)', () => {
  const live = [
    { kind: 'assistant-text', ts: 10, text: 'a' },
    { kind: 'assistant-text', ts: 20, text: 'b' },
  ];
  const snapshot = [
    { kind: 'user-text', ts: 5, text: 'q' },
    { kind: 'assistant-text', ts: 10, text: 'a' },
    { kind: 'assistant-text', ts: 20, text: 'b' },
  ];
  const merged = mergeChatEvents(live, snapshot);
  expect(merged).toEqual(snapshot); // no dup of ts=10/20
});

test('live events strictly newer than the snapshot are kept and appended', () => {
  const live = [
    { kind: 'assistant-text', ts: 10, text: 'a' }, // in snapshot
    { kind: 'tool-use', ts: 30, text: 'newer' }, // after snapshot → keep
  ];
  const snapshot = [
    { kind: 'user-text', ts: 5 },
    { kind: 'assistant-text', ts: 10, text: 'a' },
  ];
  const merged = mergeChatEvents(live, snapshot);
  expect(merged).toHaveLength(3);
  expect(merged[2]).toEqual({ kind: 'tool-use', ts: 30, text: 'newer' });
});

test('dedup by requestId even when ts differs (permission cards)', () => {
  const live = [{ kind: 'permission-request', requestId: 'perm_1', ts: 99 }];
  const snapshot = [{ kind: 'permission-request', requestId: 'perm_1', ts: 12 }];
  const merged = mergeChatEvents(live, snapshot);
  expect(merged).toHaveLength(1);
  expect(merged[0].ts).toBe(12); // snapshot wins
});

test('chatKey prefers id, then requestId, then kind:ts', () => {
  expect(chatKey({ id: 'x', requestId: 'y', ts: 1, kind: 'k' })).toBe('x');
  expect(chatKey({ requestId: 'y', ts: 1, kind: 'k' })).toBe('y');
  expect(chatKey({ ts: 1, kind: 'k' })).toBe('k:1');
  expect(chatKey({ kind: 'k' })).toBeNull();
});
