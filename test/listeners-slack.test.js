// Unit tests for the pure slack listener logic in server/listeners-slack.ts
// (diffSlack + classifySlackError). The scheduler and Web API I/O are NOT tested
// here — importing the pure module avoids booting the state singleton (which
// would race other test files for the ARIGAMI_STATE_FILE env binding).
// Mirrors listeners.test.js / listeners-linear.test.js.
import { test, expect } from 'bun:test';

const { diffSlack, classifySlackError } = await import('../server/listeners-slack.ts');

// ts helper: a monotonic "seconds.micros" string.
const at = (n) => `17000000${String(n).padStart(2, '0')}.000100`;
const msg = (n, over = {}) => ({ ts: at(n), user: over.user || 'UTHEM', text: over.text ?? 'hello', ...over });
const snap = (over = {}) => ({
  channelId: over.channelId || 'C123',
  channelName: over.channelName,
  isDm: over.isDm,
  messages: over.messages || [],
});
const FIRE = ['new_message'];

test('classifySlackError: auth/gone/transient buckets', () => {
  expect(classifySlackError(200, 'invalid_auth')).toBe('auth');
  expect(classifySlackError(200, 'missing_scope')).toBe('auth');
  expect(classifySlackError(200, 'token_revoked')).toBe('auth');
  expect(classifySlackError(200, 'channel_not_found')).toBe('gone');
  expect(classifySlackError(200, 'not_in_channel')).toBe('gone');
  expect(classifySlackError(429, 'ratelimited')).toBe('transient');
  expect(classifySlackError(200, 'ratelimited')).toBe('transient');
  expect(classifySlackError(500)).toBe('transient');
  expect(classifySlackError(0, 'network_error')).toBe('transient');
});

test('diffSlack: fresh channel with no messages does not fire, watermark empty', () => {
  const d = diffSlack(snap(), {}, { fireOn: FIRE });
  expect(d.shouldFire).toBe(false);
  expect(d.nextWatermark.seenTs).toEqual([]);
  expect(d.nextWatermark.lastTs).toBeUndefined();
});

test('diffSlack: a new message past the watermark fires and advances the cursor', () => {
  const base = diffSlack(snap({ messages: [msg(1)] }), {}, { fireOn: FIRE });
  // simulate arming (discard shouldFire, keep watermark), then a new message
  const d = diffSlack(snap({ messages: [msg(1), msg(2, { user: 'UREVIEWER', text: 'ping' })] }), base.nextWatermark, {
    fireOn: FIRE,
  });
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('new message from <@UREVIEWER>');
  expect(d.summary).toContain('ping');
  expect(d.nextWatermark.lastTs).toBe(at(2));
  expect(d.nextWatermark.seenTs).toEqual([at(1), at(2)]);
});

test('diffSlack: an already-seen message does not re-fire', () => {
  const d = diffSlack(snap({ messages: [msg(1)] }), { seenTs: [at(1)], lastTs: at(1) }, { fireOn: FIRE });
  expect(d.shouldFire).toBe(false);
});

test("diffSlack: the token's own message advances the watermark but never fires", () => {
  const d = diffSlack(
    snap({ messages: [msg(2, { user: 'UME' })] }),
    { seenTs: [], lastTs: at(1) },
    { fireOn: FIRE, ignoreUserId: 'UME' }
  );
  expect(d.shouldFire).toBe(false);
  expect(d.nextWatermark.seenTs).toEqual([at(2)]); // advanced, so we don't re-evaluate it
});

test('diffSlack: system messages (subtypes / no user) never fire', () => {
  const d = diffSlack(
    snap({ messages: [{ ts: at(2), subtype: 'channel_join', user: 'UME' }, { ts: at(3), text: 'x' }] }),
    { seenTs: [], lastTs: at(1) },
    { fireOn: FIRE }
  );
  expect(d.shouldFire).toBe(false); // join is a subtype; the second has no user
});

test('diffSlack: an older message that slides back into the window cannot re-fire', () => {
  const d = diffSlack(
    snap({ messages: [msg(1, { user: 'UREVIEWER' })] }),
    { seenTs: [], lastTs: at(9) }, // high-water ahead of msg #1
    { fireOn: FIRE }
  );
  expect(d.shouldFire).toBe(false);
});

test('diffSlack: multiple new messages collapse into a count', () => {
  const d = diffSlack(
    snap({ messages: [msg(2, { user: 'A' }), msg(3, { user: 'B' }), msg(4, { user: 'C' })] }),
    { seenTs: [], lastTs: at(1) },
    { fireOn: FIRE }
  );
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('3 new messages');
});

test('diffSlack: mention-only fire ignores a plain message but fires on an @-mention', () => {
  const wm = { seenTs: [], lastTs: at(1) };
  const plain = diffSlack(snap({ messages: [msg(2, { user: 'UREVIEWER', text: 'hi there' })] }), wm, {
    fireOn: ['mention'],
    ignoreUserId: 'UME',
  });
  expect(plain.shouldFire).toBe(false);
  const mentioned = diffSlack(
    snap({ messages: [msg(2, { user: 'UREVIEWER', text: 'hey <@UME> look' })] }),
    wm,
    { fireOn: ['mention'], ignoreUserId: 'UME' }
  );
  expect(mentioned.shouldFire).toBe(true);
  expect(mentioned.summary).toContain('<@UREVIEWER>');
});

test('diffSlack: reply-only fire ignores a top-level message but fires on a thread reply', () => {
  const wm = { seenTs: [], lastTs: at(1) };
  const top = diffSlack(snap({ messages: [msg(2, { user: 'UREVIEWER' })] }), wm, { fireOn: ['reply'] });
  expect(top.shouldFire).toBe(false);
  const reply = diffSlack(
    snap({ messages: [msg(3, { user: 'UREVIEWER', thread_ts: at(1) })] }),
    wm,
    { fireOn: ['reply'] }
  );
  expect(reply.shouldFire).toBe(true);
});

test('diffSlack: DM label appears in the summary', () => {
  const d = diffSlack(
    snap({ isDm: true, channelName: undefined, messages: [msg(2, { user: 'UREVIEWER' })] }),
    { seenTs: [], lastTs: at(1) },
    { fireOn: FIRE }
  );
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('DM —');
});
