// The PR tab's merge box (server/lib/gh-merge.ts): GitHub's merge facts become one row per requirement, the green
// button is live only when GitHub would merge, and "Merge via chat" is offered only for what an agent can fix.
import { test, expect } from 'bun:test';
import { mergeModel, requiredChecks } from '../server/lib/gh-merge.ts';

const repo = (pr: any, extra: any = {}) => ({ viewerPermission: 'WRITE', squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: true, viewerDefaultMergeMethod: 'MERGE', ...extra, pullRequest: { state: 'OPEN', merged: false, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', headRefOid: 'abc1234', reviewThreads: { nodes: [] }, ...pr } });
const opts = (checks: any[] = []) => ({ number: 7, title: 'Fix it', base: 'main', head: 'feat', checks });

test('clean: every row green, the button live, nothing for the chat to fix', () => {
  const m: any = mergeModel(repo({}), opts([{ name: 'ci', state: 'ok', required: true }]));
  expect(m.canMerge).toBe(true);
  expect(m.rows.map((r: any) => [r.id, r.s])).toEqual([['reviews', 'ok'], ['checks', 'ok'], ['conflicts', 'ok']]);
  expect(m.methods).toEqual(['squash', 'merge']);
  expect(m.method).toBe('merge'); // the viewer's default, when the repo allows it
  expect(m.defaultTitle.squash).toBe('Fix it (#7)');
  expect(m.fixable).toEqual([]);
});

test('conflicts and a failing required check block it — and are what "Merge via chat" fixes; a missing approval is not', () => {
  const m: any = mergeModel(repo({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'REVIEW_REQUIRED' }), opts([{ name: 'test', state: 'bad', required: true }, { name: 'lint', state: 'ok', required: true }]));
  expect(m.canMerge).toBe(false);
  expect(m.rows.find((r: any) => r.id === 'reviews').s).toBe('bad');
  expect(m.rows.find((r: any) => r.id === 'checks').detail).toContain('Required: test failed');
  expect(m.fixable).toEqual(['Some checks were not successful', 'This branch has conflicts that must be resolved']);
});

test('a failing check nobody requires is a warning: still mergeable (UNSTABLE), nothing to fix', () => {
  const m: any = mergeModel(repo({ mergeStateStatus: 'UNSTABLE' }), opts([{ name: 'preview', state: 'bad', required: false }]));
  expect(m.canMerge).toBe(true);
  expect(m.unstable).toBe(true);
  expect(m.rows.find((r: any) => r.id === 'checks').s).toBe('warn');
  expect(m.fixable).toEqual([]);
});

test('behind the base: update-branch offered when GitHub lets this viewer, and the chat can bring it up to date', () => {
  const m: any = mergeModel(repo({ mergeStateStatus: 'BEHIND', viewerCanUpdateBranch: true }), opts());
  const row = m.rows.find((r: any) => r.id === 'conflicts');
  expect(row).toMatchObject({ s: 'warn', action: 'update' });
  expect(m.fixable).toEqual(['This branch is out-of-date with the base branch']);
});

test('blocked with every row green says a rule blocks it; auto-merge and admin bypass follow GitHub', () => {
  const m: any = mergeModel(repo({ mergeStateStatus: 'BLOCKED', viewerCanEnableAutoMerge: true, viewerCanMergeAsAdmin: true }), opts());
  expect(m.canMerge).toBe(false);
  expect(m.rows.at(-1)).toMatchObject({ id: 'rules', s: 'bad' });
  expect(m.canAuto).toBe(true);
  expect(m.canAdmin).toBe(true);
  const on: any = mergeModel(repo({ mergeStateStatus: 'BLOCKED', viewerCanEnableAutoMerge: true, viewerCanDisableAutoMerge: true, autoMergeRequest: { mergeMethod: 'SQUASH', enabledBy: { login: 'jo' } } }), opts());
  expect(on.canAuto).toBe(false);
  expect(on.auto).toEqual({ method: 'squash', by: 'jo' });
  expect(on.canDisableAuto).toBe(true);
});

test('a viewer without write access sees what blocks it, but no button, no auto-merge and nothing for the chat', () => {
  for (const viewerPermission of ['READ', 'TRIAGE', undefined]) {
    const clean: any = mergeModel(repo({ viewerCanEnableAutoMerge: true, viewerCanMergeAsAdmin: true }, { viewerPermission }), opts());
    expect(clean).toMatchObject({ canWrite: false, canMerge: false, canAuto: false, canAdmin: false });
    const dirty: any = mergeModel(repo({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, { viewerPermission }), opts([{ name: 'test', state: 'bad', required: true }]));
    expect(dirty.rows.find((r: any) => r.id === 'conflicts').s).toBe('bad');
    expect(dirty.fixable).toEqual([]);
  }
  expect((mergeModel(repo({ isDraft: true }, { viewerPermission: 'READ' }), opts()) as any).rows[0].action).toBeUndefined();
  for (const viewerPermission of ['WRITE', 'MAINTAIN', 'ADMIN']) expect((mergeModel(repo({}, { viewerPermission }), opts()) as any).canMerge).toBe(true);
});

test('draft, merged and closed', () => {
  const d: any = mergeModel(repo({ isDraft: true, viewerCanUpdate: true }), opts());
  expect(d.canMerge).toBe(false);
  expect(d.rows[0]).toMatchObject({ id: 'draft', action: 'ready' });
  expect(mergeModel(repo({ merged: true, mergedBy: { login: 'jo' } }), opts())).toMatchObject({ status: 'merged', by: 'jo' });
  expect(mergeModel(repo({ state: 'CLOSED' }), opts())).toEqual({ status: 'closed' });
  expect(mergeModel(null, opts())).toBeNull();
});

test('required checks come from the rollup contexts (check runs and statuses)', () => {
  const info = { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: 'build', isRequired: true }, { name: 'gate', isRequired: false }, { context: 'UI Tests', isRequired: true }] } } } }] } } };
  expect([...requiredChecks(info)].sort()).toEqual(['UI Tests', 'build']);
  expect(requiredChecks(null).size).toBe(0);
});
