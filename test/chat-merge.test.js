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

// F6: on (re)load, setup-update rows fold into their setup card (last state
// wins, full narration list replaces), and the update rows disappear.
test('foldSetupUpdates: reload shows the card in its final state', () => {
  const { foldSetupUpdates } = require('../web/src/lib/chat-merge.js');
  const snap = [
    { kind: 'user-text', ts: 1, text: 'q' },
    { kind: 'setup', id: 'setup_1', requestId: 'setup_1', ts: 2, capability: 'composio:gmail', state: 'pending', lines: [] },
    { kind: 'setup-update', id: 'setup_1', requestId: 'setup_1', ts: 3, state: 'auto', lines: ['a'] },
    { kind: 'assistant-text', ts: 4, text: 'working' },
    { kind: 'setup-update', id: 'setup_1', requestId: 'setup_1', ts: 5, state: 'done', detail: 'ok', evidence: '/__artifacts/x/', lines: ['a', 'b'] },
    { kind: 'setup-update', id: 'setup_zzz', requestId: 'setup_zzz', ts: 6, state: 'done' }, // card not in this page
  ];
  const out = foldSetupUpdates(snap);
  expect(out.map((e) => e.kind)).toEqual(['user-text', 'setup', 'assistant-text']);
  expect(out[1]).toMatchObject({ id: 'setup_1', capability: 'composio:gmail', state: 'done', detail: 'ok', evidence: '/__artifacts/x/', lines: ['a', 'b'], ts: 2 });
  const plain = [{ kind: 'setup', requestId: 'r', ts: 1, state: 'pending' }];
  expect(foldSetupUpdates(plain)).toBe(plain); // untouched when there is nothing to fold
});
