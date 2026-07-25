// Pure slack listener logic: error classification + event diffing against a
// watermark. No I/O, no state singleton — mirrors listeners-pr.ts / -linear.ts
// so it can be unit-tested without booting the rest of the host.

export type SlackErrorKind = 'transient' | 'auth' | 'gone';

// Classify a failed Slack Web API call. Slack returns HTTP 200 with { ok:false,
// error } for domain failures, and 429 for rate limits — so we match on the
// `error` string as well as the status.
const AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'no_permission',
  'missing_scope',
  'not_allowed_token_type',
]);
const GONE_ERRORS = new Set([
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'thread_not_found',
  'method_deprecated',
]);

export function classifySlackError(status: number, error = ''): SlackErrorKind {
  if (status === 429 || /ratelimited/i.test(error)) return 'transient';
  if (AUTH_ERRORS.has(error)) return 'auth';
  if (GONE_ERRORS.has(error)) return 'gone';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 410) return 'gone';
  return 'transient'; // 0/5xx/unknown domain errors
}

export interface SlackMessage {
  ts: string; // "1699999999.123456" — Slack's monotonic message id
  user?: string; // author user id (absent on some system messages)
  text?: string;
  thread_ts?: string; // present on threaded messages; === ts on a thread root
  subtype?: string; // set on non-plain messages (joins, bot posts, edits…)
}

export interface SlackSnapshot {
  channelId: string;
  channelName?: string; // "#general" / "DM" — for the label/summary only
  isDm?: boolean;
  messages: SlackMessage[]; // the newest window (conversations.history/replies)
}

// Slack ts is unique + monotonic, but comment-style dedup still guards the
// window boundary: a message is new when it is unseen AND not older than the
// high-water ts already processed (an old message that slides back into the
// window can't re-fire because of the numeric ts guard).
export interface SlackWatermark {
  lastTs?: string;
  seenTs?: string[];
}

export interface SlackDiff {
  // Slack conversations have no terminal state (a channel doesn't "close" — an
  // archived/deleted one surfaces as a `gone` error). Kept as a literal null so
  // the scheduler can treat every diff type uniformly.
  terminal: null;
  shouldFire: boolean;
  summary: string;
  nextWatermark: SlackWatermark;
}

// Subtypes that are still "a person said something" and worth a wake. Everything
// else (channel_join, channel_topic, bot_message, message_changed/deleted, …) is
// noise the listener advances past without firing.
const FIREABLE_SUBTYPES = new Set(['', 'thread_broadcast', 'me_message', 'file_share']);

const num = (ts?: string): number => (ts ? Number(ts) || 0 : 0);
const isHuman = (m: SlackMessage): boolean => !!m.user && FIREABLE_SUBTYPES.has(m.subtype || '');
const isReply = (m: SlackMessage): boolean => !!m.thread_ts && m.thread_ts !== m.ts;
const mentions = (m: SlackMessage, id?: string): boolean => !!id && !!m.text && m.text.includes(`<@${id}>`);

// Compute what's new past the watermark and whether it should wake the session.
// ignoreUserId (the token's own Slack user) is filtered for *firing* but still
// advances the watermark, so the agent's own messages never self-wake the loop.
// The same id is the mention target — "someone mentioned me".
export function diffSlack(
  snap: SlackSnapshot,
  wm: SlackWatermark,
  opts: { fireOn: string[]; ignoreUserId?: string }
): SlackDiff {
  const { fireOn, ignoreUserId } = opts;
  const tag = snap.channelName || (snap.isDm ? 'DM' : `channel ${snap.channelId}`);

  const seen = wm.seenTs || [];
  const fresh = snap.messages.filter(
    (m) => !seen.includes(m.ts) && (!wm.lastTs || num(m.ts) >= num(wm.lastTs))
  );

  const nextWatermark: SlackWatermark = {
    lastTs:
      snap.messages.reduce((mx, m) => (num(m.ts) > num(mx) ? m.ts : mx), wm.lastTs || '') || undefined,
    seenTs: snap.messages.map((m) => m.ts),
  };

  const fireable = fresh.filter((m) => isHuman(m) && m.user !== ignoreUserId);
  const fires = fireable.filter(
    (m) =>
      fireOn.includes('new_message') ||
      (fireOn.includes('mention') && mentions(m, ignoreUserId)) ||
      (fireOn.includes('reply') && isReply(m))
  );

  const shouldFire = fires.length > 0;
  const first = fires[0];
  const preview = (first?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const parts: string[] = [];
  if (fires.length === 1) parts.push(`new message from <@${first!.user}>${preview ? `: "${preview}"` : ''}`);
  else if (fires.length) parts.push(`${fires.length} new messages`);

  return {
    terminal: null,
    shouldFire,
    nextWatermark,
    summary: shouldFire
      ? `🔔 Listener: ${tag} — ${parts.join('; ')}. Fetch the latest messages from Slack and decide your next step.`
      : '',
  };
}
