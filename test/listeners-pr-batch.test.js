// Unit tests for the batched GraphQL path of the github-pr listener (pure parts
// of server/listeners-pr.ts). The gh call and the scheduler are not exercised.
import { test, expect } from 'bun:test';

const { buildPrBatchQuery, snapshotFromGraphql, parsePrBatch, quotaPausedUntil, prKey, diffPr, PR_BATCH_SIZE } =
  await import('../server/listeners-pr.ts');

const node = (over = {}) => ({
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  merged: false,
  mergeable: 'MERGEABLE',
  headRefOid: 'abc123',
  author: { login: 'me' },
  baseRepository: { name: 'r', owner: { login: 'o' } },
  reviews: { nodes: [] },
  comments: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
  ...over,
});
const FIRE = ['new_review', 'new_comment', 'ci_failed', 'ci_passed', 'conflicts', 'approved', 'changes_requested'];

test('buildPrBatchQuery: one alias per PR, values travel as variables not query text', () => {
  const { query, vars } = buildPrBatchQuery([
    { owner: 'o', repo: 'r', number: 1 },
    { owner: 'x"}) { evil', repo: 'y', number: 2 },
  ]);
  expect(query).toContain('p0: repository(owner: $o0, name: $r0)');
  expect(query).toContain('p1: repository(owner: $o1, name: $r1)');
  expect(query).toContain('rateLimit { cost remaining resetAt }');
  expect(query).not.toContain('evil');
  expect(vars).toEqual({ o0: 'o', r0: 'r', n0: 1, o1: 'x"}) { evil', r1: 'y', n1: 2 });
});

test('prKey / PR_BATCH_SIZE are stable', () => {
  expect(prKey({ owner: 'o', repo: 'r', number: 3 })).toBe('o/r#3');
  expect(PR_BATCH_SIZE).toBeGreaterThan(0);
});

test('snapshotFromGraphql: maps a PR node onto the REST-shaped snapshot (databaseId → id)', () => {
  const s = snapshotFromGraphql(
    node({
      reviews: { nodes: [{ databaseId: 11, state: 'APPROVED', author: { login: 'rev' } }] },
      comments: { nodes: [{ databaseId: 21, author: { login: 'c' } }] },
      reviewThreads: { nodes: [{ comments: { nodes: [{ databaseId: 31, author: { login: 't' } }] } }] },
    })
  );
  expect(s.meta).toMatchObject({
    number: 7,
    html_url: 'https://github.com/o/r/pull/7',
    state: 'open',
    merged: false,
    head: { sha: 'abc123' },
    user: { login: 'me' },
    base: { repo: { name: 'r', owner: { login: 'o' } } },
  });
  expect(s.reviews).toEqual([{ id: 11, state: 'APPROVED', user: { login: 'rev' } }]);
  expect(s.issueComments.map((c) => c.id)).toEqual([21]);
  expect(s.reviewComments.map((c) => c.id)).toEqual([31]);
});

test('snapshotFromGraphql: merged / closed / conflicting map to the REST vocabulary', () => {
  expect(snapshotFromGraphql(node({ state: 'MERGED', merged: true })).meta).toMatchObject({ state: 'closed', merged: true });
  expect(snapshotFromGraphql(node({ state: 'CLOSED' })).meta).toMatchObject({ state: 'closed', merged: false });
  expect(snapshotFromGraphql(node({ mergeable: 'CONFLICTING' })).meta.mergeable_state).toBe('dirty');
  expect(snapshotFromGraphql(node({ mergeable: 'UNKNOWN' })).meta.mergeable_state).toBe('unknown');
  expect(snapshotFromGraphql(null)).toBeNull();
});

test('snapshotFromGraphql: check runs and status contexts split and lower-cased', () => {
  const ctx = [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    { __typename: 'StatusContext', context: 'vercel', state: 'ERROR' },
  ];
  const s = snapshotFromGraphql(node({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: ctx } } } }] } }));
  expect(s.checkRuns).toEqual([
    { name: 'build', status: 'completed', conclusion: 'failure' },
    { name: 'lint', status: 'completed', conclusion: 'timed_out' },
  ]);
  expect(s.statusContexts).toEqual([{ context: 'vercel', state: 'error' }]);
  // a commit with no rollup yet (CI not started) yields no checks, not a crash
  expect(snapshotFromGraphql(node({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })).checkRuns).toEqual([]);
});

test('mapped snapshot drives diffPr exactly as the REST one did', () => {
  const s = snapshotFromGraphql(
    node({
      reviews: { nodes: [{ databaseId: 11, state: 'CHANGES_REQUESTED', author: { login: 'rev' } }] },
      comments: { nodes: [{ databaseId: 21, author: { login: 'me' } }] },
      commits: {
        nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }] } } } }],
      },
    })
  );
  const d = diffPr(s, {}, { fireOn: FIRE, ignoreLogin: 'me' });
  expect(d.shouldFire).toBe(true);
  expect(d.summary).toContain('requested changes by @rev');
  expect(d.summary).toContain('CI failed: build');
  expect(d.summary).toContain('PR #7 (o/r)');
  expect(d.nextWatermark).toMatchObject({ reviewId: 11, issueCommentId: 21, headSha: 'abc123', firedChecks: ['build'] });
  // own comment advances the watermark but never fires by itself
  // second poll with that watermark: nothing new → quiet
  expect(diffPr(s, d.nextWatermark, { fireOn: FIRE, ignoreLogin: 'me' }).shouldFire).toBe(false);
});

test('two listeners on one PR share a snapshot but keep separate watermarks', () => {
  const s = snapshotFromGraphql(node({ reviews: { nodes: [{ databaseId: 11, state: 'APPROVED', author: { login: 'rev' } }] } }));
  const fresh = diffPr(s, {}, { fireOn: ['approved'], ignoreLogin: 'me' });
  const caughtUp = diffPr(s, { reviewId: 11 }, { fireOn: ['approved'], ignoreLogin: 'me' });
  expect(fresh.shouldFire).toBe(true);
  expect(caughtUp.shouldFire).toBe(false);
});

test('parsePrBatch: results line up with aliases; missing PR is gone for that one only', () => {
  const data = {
    rateLimit: { cost: 1, remaining: 4321, resetAt: '2026-10-22T12:00:00Z' },
    p0: { pullRequest: node({ number: 1 }) },
    p1: { pullRequest: null },
    p2: { pullRequest: node({ number: 3 }) },
  };
  const errors = [{ type: 'NOT_FOUND', path: ['p1', 'pullRequest'], message: 'Could not resolve to a PullRequest' }];
  const { results, rate } = parsePrBatch(data, errors, 3);
  expect(results[0].snap.meta.number).toBe(1);
  expect(results[1].err.kind).toBe('gone');
  expect(results[2].snap.meta.number).toBe(3);
  expect(rate).toEqual({ remaining: 4321, resetAt: Date.parse('2026-10-22T12:00:00Z') });
});

test('parsePrBatch: unknown per-alias error is transient; absent data is transient; repo not found is gone', () => {
  const r = parsePrBatch({ p0: null }, [{ type: 'NOT_FOUND', path: ['p0'], message: 'repo' }], 1);
  expect(r.results[0].err.kind).toBe('gone');
  const t = parsePrBatch({ p0: null }, [{ type: 'INTERNAL', path: ['p0'], message: 'boom' }], 1);
  expect(t.results[0].err).toEqual({ kind: 'transient', message: 'boom' });
  const none = parsePrBatch(undefined, [{ message: 'timeout' }], 2);
  expect(none.results.map((x) => x.err.kind)).toEqual(['transient', 'transient']);
  expect(none.rate).toBeNull();
});

test('quotaPausedUntil: pauses below the floor until reset, otherwise goes ahead', () => {
  const now = Date.parse('2026-10-22T11:00:00Z');
  const resetAt = Date.parse('2026-10-22T11:40:00Z');
  expect(quotaPausedUntil(null, now)).toBeNull();
  expect(quotaPausedUntil({ remaining: 4000, resetAt }, now)).toBeNull();
  expect(quotaPausedUntil({ remaining: 199, resetAt }, now)).toBe(resetAt);
  expect(quotaPausedUntil({ remaining: 0, resetAt }, now)).toBe(resetAt);
  // window already reset since the last reading → stale low number must not block
  expect(quotaPausedUntil({ remaining: 5, resetAt: now - 1 }, now)).toBeNull();
  expect(quotaPausedUntil({ remaining: 50, resetAt }, now, 10)).toBeNull();
});
