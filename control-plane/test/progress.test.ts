// The progress view's brain (src/progress.ts stepsFor) — pure, so every state
// a user can be parked in is asserted here rather than discovered by staring
// at a spinner. The rule this file protects: a phase is only shown when
// Kubernetes actually reports it, and anything unrecoverable says so instead
// of spinning forever.
import { describe, test, expect } from 'bun:test';
import { stepsFor, EMPTY_SNAPSHOT, SLOW_MS, type PodSnapshot } from '../src/progress.js';

const snap = (over: Partial<PodSnapshot> = {}): PodSnapshot => ({ ...EMPTY_SNAPSHOT, ...over });
const active = (p: ReturnType<typeof stepsFor>) => p.steps.find((s) => s.state === 'active')?.key;
const stateOf = (p: ReturnType<typeof stepsFor>, key: string) => p.steps.find((s) => s.key === key)?.state;

describe('stepsFor', () => {
  test('no pod yet → reserving the space', () => {
    const p = stepsFor('provisioning', snap(), 1000);
    expect(p.phase).toBe('space');
    expect(active(p)).toBe('space');
    expect(stateOf(p, 'account')).toBe('done'); // they just signed in — never a pending step
    expect(p.failed).toBe(false);
  });

  test('pod pending / creating → fetching the image, with the honest "first time is slowest" note', () => {
    for (const s of [snap({ exists: true, phase: 'Pending' }), snap({ exists: true, phase: 'Pending', waitingReason: 'ContainerCreating' })]) {
      const p = stepsFor('provisioning', s, 1000);
      expect(p.phase).toBe('image');
      expect(active(p)).toBe('image');
      expect(stateOf(p, 'space')).toBe('done');
    }
  });

  test('container running but not ready and no bundle line yet → applying the org setup', () => {
    const p = stepsFor('provisioning', snap({ exists: true, phase: 'Running' }), 1000);
    expect(p.phase).toBe('configuring');
    expect(active(p)).toBe('configure');
    expect(stateOf(p, 'image')).toBe('done');
  });

  test('bundle line seen → the org step is done and we are on the last leg', () => {
    const p = stepsFor('provisioning', snap({ exists: true, phase: 'Running', bundleApplied: true }), 1000);
    expect(p.phase).toBe('starting');
    expect(stateOf(p, 'configure')).toBe('done');
  });

  test('the org name is used in the label when configured', () => {
    const p = stepsFor('provisioning', snap({ exists: true, phase: 'Running' }), 1000, 'Fake Org');
    expect(p.steps.find((s) => s.key === 'configure')!.label).toContain('Fake Org');
  });

  test('running → ready, everything ticked', () => {
    const p = stepsFor('running', snap(), 1000);
    expect(p.phase).toBe('ready');
    expect(p.steps.every((s) => s.state === 'done')).toBe(true);
    expect(p.slow).toBe(false); // a finished setup is never "slow"
  });

  test('an unpullable image is reported as failed, not spun on forever', () => {
    for (const reason of ['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName']) {
      const p = stepsFor('provisioning', snap({ exists: true, phase: 'Pending', waitingReason: reason }), 5000);
      expect(p.phase).toBe('stuck');
      expect(p.failed).toBe(true);
      expect(stateOf(p, 'image')).toBe('failed');
      expect(p.detail).toMatch(/administrator/);
    }
  });

  test('a crash-looping pod is reported as failed at the start step', () => {
    const p = stepsFor('provisioning', snap({ exists: true, phase: 'Running', waitingReason: 'CrashLoopBackOff' }), 5000);
    expect(p.phase).toBe('stuck');
    expect(p.failed).toBe(true);
    expect(stateOf(p, 'start')).toBe('failed');
  });

  test('slow only adds a caveat — it never invents progress or failure', () => {
    const fast = stepsFor('provisioning', snap({ exists: true, phase: 'Running' }), 1000);
    const slow = stepsFor('provisioning', snap({ exists: true, phase: 'Running' }), SLOW_MS + 1000);
    expect(slow.slow).toBe(true);
    expect(slow.failed).toBe(false);
    expect(slow.phase).toBe(fast.phase);
    expect(slow.steps.map((s) => s.state)).toEqual(fast.steps.map((s) => s.state));
  });

  test('deleted/archived tenants get a plain explanation, not a progress bar', () => {
    for (const st of ['deleted', 'archived']) {
      const p = stepsFor(st, snap(), 1000);
      expect(p.phase).toBe('unavailable');
      expect(p.failed).toBe(true);
      expect(p.title).toContain(st);
    }
  });
});
