import { describe, test, expect } from 'bun:test';
import { openDb, createStore, tenantIdFor } from '../src/db.js';
import { IllegalTransitionError } from '../src/state-machine.js';

function freshStore() {
  return createStore(openDb(':memory:'));
}

describe('tenantIdFor', () => {
  test('is deterministic and DNS-label safe', () => {
    const a = tenantIdFor('oidc|sub-123');
    const b = tenantIdFor('oidc|sub-123');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9]{10}$/);
  });

  test('different subjects get different ids', () => {
    expect(tenantIdFor('subject-a')).not.toBe(tenantIdFor('subject-b'));
  });
});

describe('store: users', () => {
  test('first user created has no admin bootstrap side effect by itself — caller decides the role', () => {
    const store = freshStore();
    expect(store.hasAdmin()).toBe(false);
    store.createUser('sub-1', 'admin@example.com', 'admin');
    expect(store.hasAdmin()).toBe(true);
  });

  test('findUserByEmail is case-insensitive on the stored (lower-cased) email', () => {
    const store = freshStore();
    store.createUser('sub-1', 'Alice@Example.com', 'user');
    expect(store.findUserByEmail('alice@example.com')?.subject).toBe('sub-1');
  });
});

describe('store: tenants', () => {
  test('createTenant starts in provisioning, ns derived from subject', () => {
    const store = freshStore();
    const t = store.createTenant('sub-1', 'a@example.com', { desiredDigest: 'sha256:abc' });
    expect(t.state).toBe('provisioning');
    expect(t.ns).toBe(`u-${tenantIdFor('sub-1')}`);
    expect(t.release).toBe(t.ns);
  });

  test('setTenantState follows the state machine and persists', () => {
    const store = freshStore();
    const t = store.createTenant('sub-1', 'a@example.com', { desiredDigest: 'sha256:abc' });
    store.setTenantState(t.subject, 'running');
    expect(store.findTenantBySubject(t.subject)?.state).toBe('running');
  });

  test('setTenantState rejects an illegal edge and leaves state untouched', () => {
    const store = freshStore();
    const t = store.createTenant('sub-1', 'a@example.com', { desiredDigest: 'sha256:abc' });
    expect(() => store.setTenantState(t.subject, 'archived')).toThrow(IllegalTransitionError);
    expect(store.findTenantBySubject(t.subject)?.state).toBe('provisioning');
  });

  test('listTenants returns every tenant, including deleted ones (audit trail, not a hard delete)', () => {
    const store = freshStore();
    const t = store.createTenant('sub-1', 'a@example.com', { desiredDigest: 'sha256:abc' });
    store.setTenantState(t.subject, 'running');
    store.setTenantState(t.subject, 'deleted');
    expect(store.listTenants().map((x) => x.state)).toEqual(['deleted']);
  });
});

describe('store: sessions', () => {
  test('a session is retrievable until it expires', () => {
    const store = freshStore();
    store.createUser('sub-1', 'a@example.com', 'user');
    const s = store.createSession('sub-1', 30);
    expect(store.findSession(s.token)?.subject).toBe('sub-1');
  });

  test('an expired session is treated as absent and cleaned up', () => {
    const store = freshStore();
    store.createUser('sub-1', 'a@example.com', 'user');
    const s = store.createSession('sub-1', -1); // already expired
    expect(store.findSession(s.token)).toBeNull();
  });
});
