// Unit tests for the pure listener logic in server/listeners-pr.ts (diffPr +
// classifyGhError). The scheduler and gh I/O are intentionally NOT tested here.
// Importing the pure module avoids booting the state singleton (which would race
// other test files for the ARIGAMI_STATE_FILE env binding).
import { test, expect } from 'bun:test';

const { diffPr, classifyGhError } = await import('../server/listeners-pr.ts');

const meta = (over = {}) => ({
  number: 123,
  html_url: 'https://github.com/o/r/pull/123',
  state: 'open',
  merged: false,
  user: { login: 'me' },
  base: { repo: { name: 'r', owner: { login: 'o' } } },
  ...over,
});
const snap = (over = {}) => ({
  meta: meta(over.meta),
  reviews: over.reviews || [],
  issueComments: over.issueComments || [],
  reviewComments: over.reviewComments || [],
});
const FIRE = ['new_review', 'new_comment'];

test('classifyGhError: 404/410 → gone, 401/403 → auth, rate-limit 403 → transient, 5xx/0 → transient', () => {
  expect(classifyGhError(404)).toBe('gone');
  expect(classifyGhError(410)).toBe('gone');
  expect(classifyGhError(401)).toBe('auth');
  expect(classifyGhError(403, 'Bad credentials')).toBe('auth');
  expect(classifyGhError(403, 'API rate limit exceeded')).toBe('transient');
  expect(classifyGhError(500)).toBe('transient');
  expect(classifyGhError(0, 'ETIMEDOUT')).toBe('transient');
});

test('diffPr: fresh PR with no activity does not fire, watermark stays at 0', () => {
  const d = diffPr(snap(), {}, { fireOn: FIRE });
  expect(d.terminal).toBeNull();
  expect(d.shouldFire).toBe(false);
  expect(d.nextWatermark).toMatchObject({ reviewId: 0, issueCommentId: 0, reviewCommentId: 0 });
});

test('diffPr: a new review past the watermark fires and advances the cursor', () => {
  const d = diffPr(
    snap({ reviews: [{ id: 50, state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } }] }),
    { reviewId: 10 },
    { fireOn: FIRE }
  );
  expect(d.shouldFire).toBe(true);
  expect(d.nextWatermark.reviewId).toBe(50);
  expect(d.summary).toContain('requested changes by @reviewer1');
});

test('diffPr: a review at-or-below the watermark does not re-fire', () => {
  const d = diffPr(
    snap({ reviews: [{ id: 50, state: 'APPROVED', user: { login: 'reviewer1' } }] }),
    { reviewId: 50 },
    { fireOn: FIRE }
  );
  expect(d.shouldFire).toBe(false);
});

test("diffPr: the author's own comment advances the watermark but never fires", () => {
  const d = diffPr(
    snap({ issueComments: [{ id: 7, user: { login: 'me' } }] }),
    {},
    { fireOn: FIRE, ignoreLogin: 'me' }
  );
  expect(d.shouldFire).toBe(false);
  expect(d.nextWatermark.issueCommentId).toBe(7); // advanced, so we don't re-evaluate it
});

test('diffPr: fire_on filtering — approved-only ignores a plain comment review', () => {
  const d = diffPr(
    snap({ reviews: [{ id: 5, state: 'COMMENTED', user: { login: 'reviewer1' } }] }),
    {},
    { fireOn: ['approved'] }
  );
  expect(d.shouldFire).toBe(false);
  const d2 = diffPr(
    snap({ reviews: [{ id: 6, state: 'APPROVED', user: { login: 'reviewer1' } }] }),
    {},
    { fireOn: ['approved'] }
  );
  expect(d2.shouldFire).toBe(true);
});

test('diffPr: merged/closed is terminal and always fires once', () => {
  const merged = diffPr(snap({ meta: { merged: true } }), {}, { fireOn: [] });
  expect(merged.terminal).toBe('merged');
  expect(merged.shouldFire).toBe(true);
  const closed = diffPr(snap({ meta: { state: 'closed' } }), {}, { fireOn: [] });
  expect(closed.terminal).toBe('closed');
});

test('diffPr: new inline review comments fire and combine in the count', () => {
  const d = diffPr(
    snap({
      issueComments: [{ id: 3, user: { login: 'reviewer1' } }],
      reviewComments: [{ id: 9, user: { login: 'reviewer2' } }],
    }),
    {},
    { fireOn: FIRE, ignoreLogin: 'me' }
  );
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('2 new comment(s)');
  expect(d.nextWatermark).toMatchObject({ reviewId: 0, issueCommentId: 3, reviewCommentId: 9 });
});

// ---- CI + conflicts ----------------------------------------------------------

const CI_FIRE = ['ci_failed', 'ci_passed', 'conflicts'];
const ciSnap = (over = {}) => ({
  ...snap({
    meta: { head: { sha: over.sha || 'abc123', repo: { name: 'r', owner: { login: 'o' } } }, mergeable_state: over.mergeable_state || 'clean', ...(over.meta || {}) },
  }),
  checkRuns: over.checkRuns || [],
  statusContexts: over.statusContexts || [],
});

test('diffPr: a failed check fires ci_failed once per sha, not on every poll', () => {
  const failing = { checkRuns: [{ name: 'UI Tests', status: 'completed', conclusion: 'failure' }] };
  const d1 = diffPr(ciSnap(failing), {}, { fireOn: CI_FIRE });
  expect(d1.shouldFire).toBe(true);
  expect(d1.summary).toContain('CI failed: UI Tests');
  expect(d1.nextWatermark.headSha).toBe('abc123');
  expect(d1.nextWatermark.firedChecks).toEqual(['UI Tests']);
  // same sha, same failure → silent
  const d2 = diffPr(ciSnap(failing), d1.nextWatermark, { fireOn: CI_FIRE });
  expect(d2.shouldFire).toBe(false);
  // a SECOND check failing on the same sha still fires (it's new)
  const d3 = diffPr(
    ciSnap({ checkRuns: [
      { name: 'UI Tests', status: 'completed', conclusion: 'failure' },
      { name: 'build', status: 'completed', conclusion: 'timed_out' },
    ] }),
    d1.nextWatermark,
    { fireOn: CI_FIRE }
  );
  expect(d3.shouldFire).toBe(true);
  expect(d3.summary).toContain('CI failed: build');
});

test('diffPr: a new push (sha change) resets the CI cursor — same check fires again', () => {
  const failing = { checkRuns: [{ name: 'UI Tests', status: 'completed', conclusion: 'failure' }] };
  const d1 = diffPr(ciSnap(failing), {}, { fireOn: CI_FIRE });
  const d2 = diffPr(ciSnap({ ...failing, sha: 'def456' }), d1.nextWatermark, { fireOn: CI_FIRE });
  expect(d2.shouldFire).toBe(true);
  expect(d2.nextWatermark.headSha).toBe('def456');
});

test('diffPr: legacy status contexts count as CI failures too', () => {
  const d = diffPr(
    ciSnap({ statusContexts: [{ context: 'chromatic', state: 'failure' }] }),
    {},
    { fireOn: ['ci_failed'] }
  );
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('CI failed: chromatic');
});

test('diffPr: in-progress checks do not fire, all-green fires ci_passed once per sha', () => {
  const running = { checkRuns: [{ name: 'build', status: 'in_progress', conclusion: null }] };
  expect(diffPr(ciSnap(running), {}, { fireOn: CI_FIRE }).shouldFire).toBe(false);
  const green = { checkRuns: [
    { name: 'build', status: 'completed', conclusion: 'success' },
    { name: 'lint', status: 'completed', conclusion: 'skipped' },
  ] };
  const d1 = diffPr(ciSnap(green), {}, { fireOn: CI_FIRE });
  expect(d1.shouldFire).toBe(true);
  expect(d1.summary).toContain('CI is green');
  expect(diffPr(ciSnap(green), d1.nextWatermark, { fireOn: CI_FIRE }).shouldFire).toBe(false);
});

test('diffPr: no checks at all never fires ci_passed', () => {
  expect(diffPr(ciSnap({}), {}, { fireOn: ['ci_passed'] }).shouldFire).toBe(false);
});

test('diffPr: conflicts fire once while dirty, re-fire after becoming clean then dirty again', () => {
  const d1 = diffPr(ciSnap({ mergeable_state: 'dirty' }), {}, { fireOn: CI_FIRE });
  expect(d1.shouldFire).toBe(true);
  expect(d1.summary).toContain('merge conflicts');
  // still dirty → silent
  const d2 = diffPr(ciSnap({ mergeable_state: 'dirty' }), d1.nextWatermark, { fireOn: CI_FIRE });
  expect(d2.shouldFire).toBe(false);
  // resolved → flag clears (no fire)
  const d3 = diffPr(ciSnap({ mergeable_state: 'clean' }), d2.nextWatermark, { fireOn: CI_FIRE });
  expect(d3.shouldFire).toBe(false);
  expect(d3.nextWatermark.conflictFired).toBe(false);
  // base moved and broke it again → fires again
  const d4 = diffPr(ciSnap({ mergeable_state: 'dirty' }), d3.nextWatermark, { fireOn: CI_FIRE });
  expect(d4.shouldFire).toBe(true);
});

test('diffPr: CI/conflict events are gated by fire_on', () => {
  const bad = ciSnap({
    checkRuns: [{ name: 'x', status: 'completed', conclusion: 'failure' }],
    mergeable_state: 'dirty',
  });
  const d = diffPr(bad, {}, { fireOn: ['new_review', 'new_comment'] });
  expect(d.shouldFire).toBe(false);
  // watermark still tracks state so opting in later doesn't replay history
  expect(d.nextWatermark.firedChecks).toEqual(['x']);
  expect(d.nextWatermark.conflictFired).toBe(true);
});
