import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAutonomy, autonomyDirective, reviewCheckpoint } from './autonomy-prototype.mjs';

test('new sessions default to supervised and await review after checks', () => {
  const policy = resolveAutonomy();
  assert.deepEqual(policy, { mode: 'supervised', source: 'default' });
  assert.equal(reviewCheckpoint(policy, { checksPassed: true }).outcome, 'await-human');
});

test('explicit supervised session overrides a full project and parent', () => {
  assert.deepEqual(resolveAutonomy({ session: 'supervised', project: 'full', parent: 'full' }),
    { mode: 'supervised', source: 'session' });
});

test('project wins over parent; unassigned children inherit their parent', () => {
  assert.deepEqual(resolveAutonomy({ project: 'supervised', parent: 'full' }),
    { mode: 'supervised', source: 'project' });
  assert.deepEqual(resolveAutonomy({ parent: 'full' }), { mode: 'full', source: 'parent' });
});

test('invalid modes cannot silently enable autonomy, even in shadowed inputs', () => {
  for (const value of [true, false, null, '', 'FULL', 'auto']) {
    assert.throws(() => resolveAutonomy({ session: value }), TypeError);
    assert.throws(() => resolveAutonomy({ session: 'full', project: value }), TypeError);
  }
});

test('full review continues with policy provenance, not a forged human verdict', () => {
  assert.deepEqual(reviewCheckpoint(resolveAutonomy({ project: 'full' }), { checksPassed: true }),
    { outcome: 'continue', source: 'autonomy-policy' });
});

test('failed or missing verification blocks in either mode without asking', () => {
  for (const session of ['full', 'supervised']) {
    for (const checksPassed of [false, undefined]) {
      assert.deepEqual(reviewCheckpoint(resolveAutonomy({ session }), { checksPassed }),
        { outcome: 'blocked', reason: 'checks-incomplete-or-failed' });
    }
  }
});

test('an explicit task requiring human review remains binding in full mode', () => {
  assert.equal(reviewCheckpoint(resolveAutonomy({ session: 'full' }), {
    checksPassed: true, explicitlyRequiresHumanReview: true,
  }).outcome, 'await-human');
});

test('re-resolving owner policy on the next turn/action reflects revocation', () => {
  const before = resolveAutonomy({ project: 'full' });
  const after = resolveAutonomy({ project: 'supervised' });
  assert.match(autonomyDirective(before), /Do not ask workflow questions/);
  assert.doesNotMatch(autonomyDirective(after), /Do not ask workflow questions/);
  assert.equal(reviewCheckpoint(before, { checksPassed: true }).outcome, 'continue');
  assert.equal(reviewCheckpoint(after, { checksPassed: true }).outcome, 'await-human');
});
