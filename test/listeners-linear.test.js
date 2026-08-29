// Unit tests for the pure linear-issue listener logic in
// server/listeners-linear.ts (diffLinearIssue + classifyLinearError). The
// scheduler and HTTP I/O are intentionally NOT tested here — importing the pure
// module avoids booting the state singleton (which would race other test files
// for the ARIGAMI_STATE_FILE env binding). Mirrors listeners.test.js.
import { test, expect } from 'bun:test';

const { diffLinearIssue, classifyLinearError } = await import('../server/listeners-linear.ts');

const comment = (id, over = {}) => ({
  id: String(id),
  createdAt: over.createdAt || `2026-07-16T10:0${id}:00.000Z`,
  user: over.user || { id: 'them', displayName: 'reviewer' },
  body: over.body || 'hi',
});
const snap = (over = {}) => ({
  id: 'uuid-1',
  identifier: 'ENG-1234',
  url: 'https://linear.app/x/issue/ENG-1234',
  state: over.state || { id: 'st-open', name: 'In Progress', type: 'started' },
  assignee: over.assignee === undefined ? { id: 'me', displayName: 'alice' } : over.assignee,
  comments: over.comments || [],
});
const FIRE = ['new_comment'];

test('classifyLinearError: 404/410 + not-found text → gone, 401/403 + auth text → auth, 429/rate → transient, 5xx/0 → transient', () => {
  expect(classifyLinearError(404)).toBe('gone');
  expect(classifyLinearError(410)).toBe('gone');
  expect(classifyLinearError(200, 'Entity not found: Issue')).toBe('gone');
  expect(classifyLinearError(401)).toBe('auth');
  expect(classifyLinearError(403)).toBe('auth');
  expect(classifyLinearError(200, 'Authentication required')).toBe('auth');
  expect(classifyLinearError(429)).toBe('transient');
  expect(classifyLinearError(200, 'Ratelimit exceeded')).toBe('transient');
  expect(classifyLinearError(500)).toBe('transient');
  expect(classifyLinearError(0, 'ETIMEDOUT')).toBe('transient');
});

test('diffLinearIssue: fresh issue with no comments does not fire, watermark captures state', () => {
  const d = diffLinearIssue(snap(), {}, { fireOn: FIRE });
  expect(d.terminal).toBeNull();
  expect(d.shouldFire).toBe(false);
  expect(d.nextWatermark).toMatchObject({ seenCommentIds: [], stateId: 'st-open', assigneeId: 'me' });
});

test('diffLinearIssue: a new comment past the baseline fires and records the id', () => {
  const base = diffLinearIssue(snap(), {}, { fireOn: FIRE });
  const d = diffLinearIssue(
    snap({ comments: [comment(1)] }),
    base.nextWatermark,
    { fireOn: FIRE }
  );
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('new comment by @reviewer');
  expect(d.nextWatermark.seenCommentIds).toEqual(['1']);
});

test('diffLinearIssue: an already-seen comment does not re-fire', () => {
  const d = diffLinearIssue(
    snap({ comments: [comment(1)] }),
    { seenCommentIds: ['1'], lastCommentAt: '2026-07-16T10:01:00.000Z' },
    { fireOn: FIRE }
  );
  expect(d.shouldFire).toBe(false);
});

test("diffLinearIssue: the session's own comment advances the watermark but never fires", () => {
  const d = diffLinearIssue(
    snap({ comments: [comment(1, { user: { id: 'me', displayName: 'alice' } })] }),
    { seenCommentIds: [], lastCommentAt: '2026-07-16T09:00:00.000Z' },
    { fireOn: FIRE, ignoreUserId: 'me' }
  );
  expect(d.shouldFire).toBe(false);
  expect(d.nextWatermark.seenCommentIds).toEqual(['1']); // advanced, so we don't re-evaluate it
});

test('diffLinearIssue: multiple new comments collapse into a count', () => {
  const d = diffLinearIssue(
    snap({ comments: [comment(1), comment(2), comment(3)] }),
    { seenCommentIds: [], lastCommentAt: '2026-07-16T09:00:00.000Z' },
    { fireOn: FIRE }
  );
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('3 new comments');
});

test('diffLinearIssue: a comment older than lastCommentAt cannot re-fire when it slid out and back', () => {
  // lastCommentAt is ahead of comment #1 → even though it is unseen, the date
  // guard keeps it silent (it was already processed before sliding out of the window).
  const d = diffLinearIssue(
    snap({ comments: [comment(1, { createdAt: '2026-07-16T08:00:00.000Z' })] }),
    { seenCommentIds: [], lastCommentAt: '2026-07-16T12:00:00.000Z' },
    { fireOn: FIRE }
  );
  expect(d.shouldFire).toBe(false);
});

test('diffLinearIssue: status_changed fires only when opted in and the state id moved', () => {
  const moved = snap({ state: { id: 'st-review', name: 'In Review', type: 'started' } });
  // not opted in → silent even though state changed
  expect(diffLinearIssue(moved, { stateId: 'st-open' }, { fireOn: ['new_comment'] }).shouldFire).toBe(false);
  const d = diffLinearIssue(
    moved,
    { stateId: 'st-open', stateName: 'In Progress' },
    { fireOn: ['status_changed'] }
  );
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('status changed: In Progress → In Review');
});

test('diffLinearIssue: first observation of status/assignee (no prior watermark) never fires a change', () => {
  const d = diffLinearIssue(snap(), {}, { fireOn: ['status_changed', 'assignee_changed'] });
  expect(d.shouldFire).toBe(false);
});

test('diffLinearIssue: assignee_changed fires and renders unassigned transitions', () => {
  const unassigned = snap({ assignee: null });
  const d = diffLinearIssue(
    unassigned,
    { assigneeId: 'me', assigneeName: 'alice' },
    { fireOn: ['assignee_changed'] }
  );
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('assignee changed: alice → unassigned');
  expect(d.nextWatermark.assigneeId).toBe('');
});

test('diffLinearIssue: completed/canceled is terminal and always fires once', () => {
  const done = diffLinearIssue(
    snap({ state: { id: 'st-done', name: 'Done', type: 'completed' } }),
    { stateId: 'st-open' },
    { fireOn: [] }
  );
  expect(done.terminal).toBe('completed');
  expect(done.shouldFire).toBe(true);
  expect(done.summary).toContain('was completed');
  const canceled = diffLinearIssue(
    snap({ state: { id: 'st-x', name: 'Canceled', type: 'canceled' } }),
    { stateId: 'st-open' },
    { fireOn: [] }
  );
  expect(canceled.terminal).toBe('canceled');
});

test('diffLinearIssue: comment + status change combine in one summary', () => {
  const d = diffLinearIssue(
    snap({ comments: [comment(1)], state: { id: 'st-review', name: 'In Review', type: 'started' } }),
    { seenCommentIds: [], lastCommentAt: '2026-07-16T09:00:00.000Z', stateId: 'st-open', stateName: 'In Progress' },
    { fireOn: ['new_comment', 'status_changed'] }
  );
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('new comment by @reviewer');
  expect(d.summary).toContain('status changed');
});
