// Pure linear-issue listener logic: error classification + event diffing against
// a watermark. No I/O, no state singleton — mirrors listeners-pr.ts so it can be
// unit-tested without booting the rest of the host.

export type LinearErrorKind = 'transient' | 'auth' | 'gone';

// Classify a failed Linear GraphQL call. Linear reports most domain errors as
// HTTP 200 + an errors[] body (and rate limits as 429), so we match on the
// message text as well as the status.
export function classifyLinearError(status: number, message = ''): LinearErrorKind {
  if (status === 404 || status === 410) return 'gone';
  if (/entity not found|could not find|does not exist/i.test(message)) return 'gone';
  if (status === 429 || /rate ?limit/i.test(message)) return 'transient';
  if (status === 401 || status === 403) return 'auth';
  if (/authentication|unauthorized|access token|forbidden/i.test(message)) return 'auth';
  return 'transient'; // 0/5xx/unknown
}

export interface LinearComment {
  id: string; // UUID
  createdAt: string; // ISO 8601
  body?: string;
  user?: { id?: string; name?: string; displayName?: string } | null;
}

export interface LinearIssueSnapshot {
  id: string; // UUID
  identifier: string; // e.g. ENG-1234
  title?: string;
  url?: string;
  state?: { id?: string; name?: string; type?: string } | null;
  assignee?: { id?: string; name?: string; displayName?: string } | null;
  comments: LinearComment[]; // the newest window, i.e. comments(last: N)
}

// Comment ids are UUIDs (not monotonic like GitHub's), so the cursor is
// createdAt plus the ids currently in the fetched window: a comment is new when
// it's unseen AND not older than the newest comment already processed — old
// comments that slide out of the window can't re-fire because of the date guard.
// stateId/assigneeId are recorded on every diff; `undefined` (key absent) means
// "not tracked yet", so the first observation never fires a change event.
export interface LinearIssueWatermark {
  lastCommentAt?: string;
  seenCommentIds?: string[];
  stateId?: string;
  stateName?: string;
  assigneeId?: string; // '' = unassigned
  assigneeName?: string;
}

export interface LinearIssueDiff {
  terminal: 'completed' | 'canceled' | null;
  shouldFire: boolean;
  summary: string;
  nextWatermark: LinearIssueWatermark;
}

const who = (u?: LinearComment['user']): string =>
  u?.displayName || u?.name ? `@${u!.displayName || u!.name}` : 'someone';

// Compute what's new past the watermark and whether it should wake the session.
// ignoreUserId (the session's own Linear user) is filtered for *firing* but still
// advances the watermark, so the agent's own comments never self-wake the loop.
export function diffLinearIssue(
  snap: LinearIssueSnapshot,
  wm: LinearIssueWatermark,
  opts: { fireOn: string[]; ignoreUserId?: string }
): LinearIssueDiff {
  const { fireOn, ignoreUserId } = opts;
  const tag = snap.identifier || snap.id;
  const url = snap.url || '';

  const seen = wm.seenCommentIds || [];
  const fresh = snap.comments.filter(
    (c) => !seen.includes(c.id) && (!wm.lastCommentAt || c.createdAt >= wm.lastCommentAt)
  );

  const stateName = snap.state?.name || '';
  const assigneeId = snap.assignee?.id || '';
  const assigneeName = snap.assignee?.displayName || snap.assignee?.name || '';

  const nextWatermark: LinearIssueWatermark = {
    lastCommentAt: snap.comments.reduce(
      (mx, c) => (c.createdAt > mx ? c.createdAt : mx),
      wm.lastCommentAt || ''
    ) || undefined,
    seenCommentIds: snap.comments.map((c) => c.id),
    stateId: snap.state?.id || '',
    stateName,
    assigneeId,
    assigneeName,
  };

  // A completed/canceled issue always wakes once, then the listener stops
  // (registration rejects already-done issues, so this is always a transition).
  const terminal: LinearIssueDiff['terminal'] =
    snap.state?.type === 'completed' ? 'completed' : snap.state?.type === 'canceled' ? 'canceled' : null;
  if (terminal) {
    return {
      terminal,
      shouldFire: true,
      nextWatermark,
      summary: `🔔 Listener: ${tag} was ${terminal}${stateName ? ` (${stateName})` : ''}. ${url}\nThe watch has ended — wrap up or follow up as needed.`,
    };
  }

  const notMe = (c: LinearComment) => !ignoreUserId || c.user?.id !== ignoreUserId;
  const commentFires = fireOn.includes('new_comment') ? fresh.filter(notMe) : [];
  const statusFires =
    fireOn.includes('status_changed') && wm.stateId !== undefined && wm.stateId !== (snap.state?.id || '');
  const assigneeFires =
    fireOn.includes('assignee_changed') && wm.assigneeId !== undefined && wm.assigneeId !== assigneeId;
  const shouldFire = commentFires.length > 0 || statusFires || assigneeFires;

  const parts: string[] = [];
  if (commentFires.length === 1) parts.push(`new comment by ${who(commentFires[0].user)}`);
  else if (commentFires.length) parts.push(`${commentFires.length} new comments`);
  if (statusFires) parts.push(`status changed: ${wm.stateName || '?'} → ${stateName || '?'}`);
  if (assigneeFires)
    parts.push(`assignee changed: ${wm.assigneeName || 'unassigned'} → ${assigneeName || 'unassigned'}`);

  return {
    terminal: null,
    shouldFire,
    nextWatermark,
    summary: shouldFire
      ? `🔔 Listener: ${tag} — ${parts.join('; ')}. ${url}\nFetch the latest details from Linear and decide your next step.`
      : '',
  };
}
