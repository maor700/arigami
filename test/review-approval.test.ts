// One approve action, and a merge offer only when the viewer can merge
// (docs/REVIEW-AND-MERGE.md). Pure rules + a fake `gh` — no GitHub is touched.
import { test, expect, beforeEach } from 'bun:test';
import * as ra from '../server/lib/review-approval.ts';

const PR = { pr: 'https://github.com/acme/widgets/pull/42' };
const facts = (o: Partial<ra.PrFacts> = {}): ra.PrFacts => ({
  ok: true, author: 'alice', viewer: 'alice', permission: 'WRITE', state: 'OPEN', draft: false, mergeable: 'MERGEABLE', base: 'main', headSha: 'h1', ...o,
});

beforeEach(() => ra.clearPrFactsCache());

test('prRefOf: a PR url, or repo + prNumber; nothing for a plain session', () => {
  expect(ra.prRefOf(PR)).toEqual({ owner: 'acme', repo: 'widgets', number: 42, url: 'https://github.com/acme/widgets/pull/42' });
  expect(ra.prRefOf({ repo: 'acme/widgets', prNumber: 7 })?.number).toBe(7);
  expect(ra.prRefOf({ branch: 'child/x' })).toBeNull();
  expect(ra.prRefOf({ repo: 'not a repo', prNumber: 7 })).toBeNull();
});

test('approvalMode: the session decides — local / own PR / someone else\'s PR / unknown', () => {
  expect(ra.approvalMode({ branch: 'child/x' }, null)).toBe('local');
  expect(ra.approvalMode(PR, facts())).toBe('pr-own');
  expect(ra.approvalMode(PR, facts({ viewer: 'ALICE' }))).toBe('pr-own');
  expect(ra.approvalMode(PR, facts({ author: 'bob' }))).toBe('pr-review');
  expect(ra.approvalMode(PR, { ...facts(), ok: false, author: null })).toBe('unknown');
  expect(ra.approvalMode(PR, null)).toBe('unknown');
});

test('approvalCurrent: same commit = already approved; new commits or the other kind of approval = not', () => {
  const local = { review: { state: 'approved', at: 'T1', sha: 'a1' } };
  expect(ra.approvalCurrent(local, { sha: 'a1', mode: 'local' })).toBe(true);
  expect(ra.approvalCurrent(local, { sha: 'a2', mode: 'local' })).toBe(false);
  expect(ra.approvalCurrent(local, { sha: 'a1', mode: 'pr-review' })).toBe(false); // a local stamp is not a posted review
  const posted = { review: { state: 'approved', at: 'T1', target: 'github', sha: 'h1' } };
  expect(ra.approvalCurrent(posted, { sha: 'h1', mode: 'pr-review' })).toBe(true);
  expect(ra.approvalCurrent(posted, { sha: 'h2', mode: 'pr-review' })).toBe(false);
  expect(ra.approvalCurrent(posted, { sha: 'h1', mode: 'pr-own' })).toBe(false);
  // no branch → no SHA: current until a newer review card is raised
  const plain = { review: { state: 'approved', at: '2026-01-02T00:00:00Z' } };
  expect(ra.approvalCurrent(plain, { mode: 'local' })).toBe(true);
  expect(ra.approvalCurrent(plain, { mode: 'local', actionAt: '2026-01-01T00:00:00Z' })).toBe(true);
  expect(ra.approvalCurrent(plain, { mode: 'local', actionAt: '2026-01-03T00:00:00Z' })).toBe(false);
  expect(ra.approvalCurrent({ review: { state: 'changes-requested', sha: 'a1' } }, { sha: 'a1', mode: 'local' })).toBe(false);
});

test('mergeOffer: shown only when this viewer can merge now; otherwise a passive reason (or nothing before approval)', () => {
  const base = { approved: true, merged: false, viewerMayMerge: true };
  // local child branch
  expect(ra.mergeOffer({ ...base, kind: 'local', localReason: null })).toEqual({ show: true, reason: null });
  expect(ra.mergeOffer({ ...base, kind: 'local', localReason: 'dirty' })).toEqual({ show: false, reason: 'dirty' });
  expect(ra.mergeOffer({ ...base, approved: false, kind: 'local', localReason: 'not-approved' })).toEqual({ show: false, reason: null });
  expect(ra.mergeOffer({ ...base, viewerMayMerge: false, kind: 'local', localReason: null })).toEqual({ show: false, reason: 'no-permission' });
  expect(ra.mergeOffer({ ...base, merged: true, kind: 'local' })).toEqual({ show: false, reason: 'merged' });
  // remote PR
  const pr = (mode: ra.ApprovalMode, f: Partial<ra.PrFacts> = {}) => ra.mergeOffer({ ...base, kind: 'pr', mode, facts: facts(f) });
  expect(pr('pr-own')).toEqual({ show: true, reason: null });
  expect(pr('pr-review', { author: 'bob' })).toEqual({ show: false, reason: 'not-your-pr' });
  expect(pr('pr-own', { permission: 'READ' })).toEqual({ show: false, reason: 'no-permission' });
  expect(pr('pr-own', { permission: 'TRIAGE' })).toEqual({ show: false, reason: 'no-permission' });
  expect(pr('pr-own', { permission: 'ADMIN' })).toEqual({ show: true, reason: null });
  expect(pr('pr-own', { mergeable: 'CONFLICTING' })).toEqual({ show: false, reason: 'conflict' });
  expect(pr('pr-own', { mergeable: 'UNKNOWN' })).toEqual({ show: false, reason: 'pr-checking' });
  expect(pr('pr-own', { draft: true })).toEqual({ show: false, reason: 'pr-draft' });
  expect(pr('pr-own', { state: 'CLOSED' })).toEqual({ show: false, reason: 'pr-closed' });
  expect(pr('pr-own', { state: 'MERGED' })).toEqual({ show: false, reason: 'merged' });
  expect(ra.mergeOffer({ ...base, kind: 'pr', mode: 'unknown', facts: { ...facts(), ok: false } })).toEqual({ show: false, reason: 'github-unknown' });
});

test('fetchPrFacts: reads author, viewer, permission and mergeability through gh; caches successes only', async () => {
  const calls: string[][] = [];
  let fail = false;
  const run: ra.GhRunner = async (args) => {
    calls.push(args);
    if (fail) return { ok: false, out: 'HTTP 502' };
    if (args[0] === 'pr') return { ok: true, out: JSON.stringify({ author: { login: 'bob' }, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'develop', headRefOid: 'ff00' }) };
    if (args[0] === 'api') return { ok: true, out: 'alice\n' };
    return { ok: true, out: 'MAINTAIN\n' };
  };
  const ref = ra.prRefOf(PR)!;
  const f = await ra.fetchPrFacts(ref, { run });
  expect(f).toEqual({ ok: true, author: 'bob', viewer: 'alice', permission: 'MAINTAIN', state: 'OPEN', draft: false, mergeable: 'MERGEABLE', base: 'develop', headSha: 'ff00' });
  expect(calls[0]).toEqual(['pr', 'view', '42', '--repo', 'acme/widgets', '--json', 'author,state,isDraft,mergeable,baseRefName,headRefOid']);
  await ra.fetchPrFacts(ref, { run });
  expect(calls.length).toBe(3); // cached
  fail = true;
  const g = await ra.fetchPrFacts(ref, { run, fresh: true });
  expect(g.ok).toBe(false);
  expect(g.error).toBe('HTTP 502');
  expect(ra.approvalMode(PR, g)).toBe('unknown');
  fail = false;
  expect((await ra.fetchPrFacts(ref, { run })).ok).toBe(true); // the failure was not cached
});

test('mergePr merges exactly the approved head (--match-head-commit) with the chosen strategy', async () => {
  const calls: string[][] = [];
  const run: ra.GhRunner = async (args) => { calls.push(args); return { ok: true, out: '' }; };
  const ref = ra.prRefOf(PR)!;
  expect(await ra.mergePr(ref, { strategy: 'squash', sha: 'abc', run })).toEqual({ ok: true });
  expect(await ra.mergePr(ref, { strategy: 'no-ff', sha: 'abc', run })).toEqual({ ok: true });
  expect(calls).toEqual([
    ['pr', 'merge', '42', '--repo', 'acme/widgets', '--squash', '--match-head-commit', 'abc'],
    ['pr', 'merge', '42', '--repo', 'acme/widgets', '--merge', '--match-head-commit', 'abc'],
  ]);
  const bad: ra.GhRunner = async () => ({ ok: false, out: 'Head branch was modified' });
  expect(await ra.mergePr(ref, { strategy: 'squash', sha: 'abc', run: bad })).toEqual({ ok: false, error: 'Head branch was modified' });
});
