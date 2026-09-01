import { describe, test, expect } from 'bun:test';
import { canTransition, transition, IllegalTransitionError, TENANT_STATES, type TenantState } from '../src/state-machine.js';

describe('tenant state machine', () => {
  test('the happy path is legal end to end', () => {
    expect(canTransition('provisioning', 'running')).toBe(true);
    expect(canTransition('running', 'dormant')).toBe(true);
    expect(canTransition('dormant', 'archived')).toBe(true);
    expect(canTransition('archived', 'deleted')).toBe(true);
  });

  test('deleted is reachable from every non-deleted state', () => {
    for (const s of TENANT_STATES) {
      if (s === 'deleted') continue;
      expect(canTransition(s, 'deleted')).toBe(true);
    }
  });

  test('nothing transitions out of deleted', () => {
    for (const s of TENANT_STATES) {
      expect(canTransition('deleted', s)).toBe(false);
    }
  });

  test('a tenant can wake up from dormant back to running', () => {
    expect(canTransition('dormant', 'running')).toBe(true);
  });

  test('an archived tenant can be restored to running', () => {
    expect(canTransition('archived', 'running')).toBe(true);
  });

  test('rejects skipping states forward', () => {
    expect(canTransition('provisioning', 'dormant')).toBe(false);
    expect(canTransition('provisioning', 'archived')).toBe(false);
    expect(canTransition('running', 'archived')).toBe(false);
  });

  test('rejects going backward past running', () => {
    expect(canTransition('running', 'provisioning')).toBe(false);
    expect(canTransition('dormant', 'provisioning')).toBe(false);
  });

  test('rejects a self-loop', () => {
    for (const s of TENANT_STATES) expect(canTransition(s, s)).toBe(false);
  });

  test('transition() returns the target state on success', () => {
    expect(transition('provisioning', 'running')).toBe('running');
  });

  test('transition() throws IllegalTransitionError on an illegal edge, naming both states', () => {
    expect(() => transition('deleted', 'running')).toThrow(IllegalTransitionError);
    try {
      transition('deleted', 'running');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('deleted');
      expect((e as Error).message).toContain('running');
    }
  });

  test('every declared state has at least one outgoing or is the sole terminal state', () => {
    const nonTerminal: TenantState[] = ['provisioning', 'running', 'dormant', 'archived'];
    for (const s of nonTerminal) {
      const hasEdge = TENANT_STATES.some((to) => canTransition(s, to));
      expect(hasEdge).toBe(true);
    }
  });
});
