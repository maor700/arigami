import { test, expect } from 'bun:test';
import { failureOf } from '../server/lib/ext-result.ts';

const text = (o: unknown) => [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }];

test('a result that carries { error } is a failure, whether it is the text or the structured content', () => {
  expect(failureOf(text({ error: 'chat.postMessage failed: channel_not_found' }))).toBe('chat.postMessage failed: channel_not_found');
  expect(failureOf(text('ignored'), { error: 'invalid_auth' })).toBe('invalid_auth');
});

test('a result that says ok, or has no error, is not a failure', () => {
  expect(failureOf(text({ ok: true, channel: 'D1', ts: '1.2' }))).toBeNull();
  expect(failureOf(text({ ok: true, error: 'warning only' }))).toBeNull();
  expect(failureOf(text({ count: 0, matches: [] }))).toBeNull();
  expect(failureOf(text({ error: '' }))).toBeNull();
});

test('plain text, bad JSON and odd shapes never throw and are not failures', () => {
  expect(failureOf(text('Sent!'))).toBeNull();
  expect(failureOf(text('{not json'))).toBeNull();
  expect(failureOf(undefined)).toBeNull();
  expect(failureOf(null, null)).toBeNull();
  expect(failureOf([{ type: 'image' }])).toBeNull();
});
