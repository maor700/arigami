// HTTP routing/gating with a FAKE provisioner (no k8s involved) and sessions
// seeded directly into the store — this exercises everything except the
// actual OIDC network round-trip (which needs a real IdP; see
// test/provisioner.k3d.test.ts and docs/CONTROL-PLANE.md for what's proved
// live instead).
import { describe, test, expect, beforeEach } from 'bun:test';
import { loadConfig } from '../src/config.js';
import { openDb, createStore, type Tenant } from '../src/db.js';
import { createApp, type Provisioner } from '../src/server.js';

function fakeProvisioner() {
  const calls: string[] = [];
  const p: Provisioner = {
    async provisionTenant(_cfg, t: Tenant) {
      calls.push(`provision:${t.subject}`);
      return { url: `http://${t.ns}.example.test` };
    },
    async deleteTenant(_cfg, t: Tenant) {
      calls.push(`delete:${t.subject}`);
    },
    async suspendTenant(_cfg, t: Tenant) {
      calls.push(`suspend:${t.subject}`);
    },
    async resumeTenant(_cfg, t: Tenant) {
      calls.push(`resume:${t.subject}`);
    },
  };
  return { p, calls };
}

function setup() {
  const cfg = loadConfig({
    CP_PUBLIC_URL: 'http://localhost:8090',
    CP_ORG_DOMAIN: 'example.test',
    CP_URL_SCHEME: 'http',
    ALLOWED_EMAIL_DOMAINS: 'example.com',
    CP_IMAGE_TAG: 'sha256:test',
  } as unknown as NodeJS.ProcessEnv);
  const store = createStore(openDb(':memory:'));
  const { p, calls } = fakeProvisioner();
  const app = createApp(cfg, store, p, () => {});
  return { cfg, store, app, calls };
}

function cookieFor(store: ReturnType<typeof createStore>, subject: string): string {
  const s = store.createSession(subject, 30);
  return `arigami_cp_sid=${s.token}`;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('GET /', () => {
  test('shows a login page with no session', async () => {
    const { app } = setup();
    const res = await app.handle(new Request('http://localhost:8090/'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Sign in');
  });

  test('an admin is redirected to /admin', async () => {
    const { app, store } = setup();
    store.createUser('admin-1', 'admin@example.com', 'admin');
    const res = await app.handle(new Request('http://localhost:8090/', { headers: { cookie: cookieFor(store, 'admin-1') } }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
  });

  test('a plain user with no tenant yet gets one created and sees the starting page', async () => {
    const { app, store, calls } = setup();
    store.createUser('user-1', 'bob@example.com', 'user');
    const res = await app.handle(new Request('http://localhost:8090/', { headers: { cookie: cookieFor(store, 'user-1') } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('starting');
    await tick();
    expect(calls).toContain('provision:user-1');
    expect(store.findTenantBySubject('user-1')?.state).toBe('running');
  });

  test('a running tenant redirects straight to its URL', async () => {
    const { app, store } = setup();
    store.createUser('user-1', 'bob@example.com', 'user');
    const t = store.createTenant('user-1', 'bob@example.com', { desiredDigest: 'sha256:test' });
    store.setTenantState(t.subject, 'running');
    const res = await app.handle(new Request('http://localhost:8090/', { headers: { cookie: cookieFor(store, 'user-1') } }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`http://${t.ns}.example.test`);
  });

  test('a dormant tenant triggers resume and shows the starting page', async () => {
    const { app, store, calls } = setup();
    store.createUser('user-1', 'bob@example.com', 'user');
    const t = store.createTenant('user-1', 'bob@example.com', { desiredDigest: 'sha256:test' });
    store.setTenantState(t.subject, 'running');
    store.setTenantState(t.subject, 'dormant');
    const res = await app.handle(new Request('http://localhost:8090/', { headers: { cookie: cookieFor(store, 'user-1') } }));
    expect(res.status).toBe(200);
    await tick();
    expect(calls).toContain('resume:user-1');
    expect(store.findTenantBySubject('user-1')?.state).toBe('running');
  });

  test('a deleted tenant shows the unavailable page, not a redirect', async () => {
    const { app, store } = setup();
    store.createUser('user-1', 'bob@example.com', 'user');
    const t = store.createTenant('user-1', 'bob@example.com', { desiredDigest: 'sha256:test' });
    store.setTenantState(t.subject, 'deleted');
    const res = await app.handle(new Request('http://localhost:8090/', { headers: { cookie: cookieFor(store, 'user-1') } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('deleted');
  });
});

describe('GET /admin', () => {
  test('anonymous is redirected to /', async () => {
    const { app } = setup();
    const res = await app.handle(new Request('http://localhost:8090/admin'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  test('a plain user is forbidden', async () => {
    const { app, store } = setup();
    store.createUser('user-1', 'bob@example.com', 'user');
    const res = await app.handle(new Request('http://localhost:8090/admin', { headers: { cookie: cookieFor(store, 'user-1') } }));
    expect(res.status).toBe(403);
  });

  test('an admin sees the tenant table', async () => {
    const { app, store } = setup();
    store.createUser('admin-1', 'admin@example.com', 'admin');
    store.createTenant('user-1', 'bob@example.com', { desiredDigest: 'sha256:test' });
    const res = await app.handle(new Request('http://localhost:8090/admin', { headers: { cookie: cookieFor(store, 'admin-1') } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('bob@example.com');
  });
});

describe('POST /admin/tenants/:subject/:action', () => {
  test('suspend on a running tenant calls the provisioner and flips state', async () => {
    const { app, store, calls } = setup();
    store.createUser('admin-1', 'admin@example.com', 'admin');
    const t = store.createTenant('user-1', 'bob@example.com', { desiredDigest: 'sha256:test' });
    store.setTenantState(t.subject, 'running');
    const res = await app.handle(
      new Request(`http://localhost:8090/admin/tenants/${t.subject}/suspend`, { method: 'POST', headers: { cookie: cookieFor(store, 'admin-1') } }),
    );
    expect(res.status).toBe(302);
    expect(calls).toContain(`suspend:${t.subject}`);
    expect(store.findTenantBySubject(t.subject)?.state).toBe('dormant');
  });

  test('suspend on a still-provisioning tenant is rejected (409), no provisioner call', async () => {
    const { app, store, calls } = setup();
    store.createUser('admin-1', 'admin@example.com', 'admin');
    const t = store.createTenant('user-1', 'bob@example.com', { desiredDigest: 'sha256:test' });
    const res = await app.handle(
      new Request(`http://localhost:8090/admin/tenants/${t.subject}/suspend`, { method: 'POST', headers: { cookie: cookieFor(store, 'admin-1') } }),
    );
    expect(res.status).toBe(409);
    expect(calls).not.toContain(`suspend:${t.subject}`);
    expect(store.findTenantBySubject(t.subject)?.state).toBe('provisioning');
  });

  test('delete calls the provisioner and marks the tenant deleted from any live state', async () => {
    const { app, store, calls } = setup();
    store.createUser('admin-1', 'admin@example.com', 'admin');
    const t = store.createTenant('user-1', 'bob@example.com', { desiredDigest: 'sha256:test' });
    store.setTenantState(t.subject, 'running');
    const res = await app.handle(
      new Request(`http://localhost:8090/admin/tenants/${t.subject}/delete`, { method: 'POST', headers: { cookie: cookieFor(store, 'admin-1') } }),
    );
    expect(res.status).toBe(302);
    expect(calls).toContain(`delete:${t.subject}`);
    expect(store.findTenantBySubject(t.subject)?.state).toBe('deleted');
  });

  test('a non-admin cannot suspend/delete/resume anyone', async () => {
    const { app, store, calls } = setup();
    store.createUser('user-1', 'bob@example.com', 'user');
    const t = store.createTenant('user-1', 'bob@example.com', { desiredDigest: 'sha256:test' });
    store.setTenantState(t.subject, 'running');
    const res = await app.handle(
      new Request(`http://localhost:8090/admin/tenants/${t.subject}/delete`, { method: 'POST', headers: { cookie: cookieFor(store, 'user-1') } }),
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('GET /__health', () => {
  test('is public and returns ok', async () => {
    const { app } = setup();
    const res = await app.handle(new Request('http://localhost:8090/__health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
