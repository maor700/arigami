// The tenant gate: GET /auth/verify (the edge's forward_auth subrequest), the shared session cookie, and the
// return URL a sign-in may send the browser back to. Fake provisioner, sessions seeded into the store, OIDC
// state cookie built by hand — no IdP or edge involved (the live Caddy run is described in
// docs/CONTROL-PLANE.md "Org SSO in front of every cockpit").
import { describe, test, expect } from 'bun:test';
import { loadConfig } from '../src/config.js';
import { openDb, createStore } from '../src/db.js';
import { createApp, type Provisioner } from '../src/server.js';
import { createAuthService } from '../src/auth.js';
import { tenantNsForHost, safeReturnUrl } from '../src/gate.js';

const noop: Provisioner = {
  async provisionTenant(_c, t) { return { url: `https://${t.ns}.lab.example.com` }; },
  async deleteTenant() {},
  async suspendTenant() {},
  async resumeTenant() {},
};

function setup(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    CP_PUBLIC_URL: 'https://lab.example.com',
    CP_ORG_DOMAIN: 'lab.example.com',
    CP_URL_SCHEME: 'https',
    CP_COOKIE_PARENT_DOMAIN: '1',
    ALLOWED_EMAIL_DOMAINS: 'example.com',
    CP_IMAGE_TAG: 'sha256:test',
    ...env,
  } as unknown as NodeJS.ProcessEnv);
  const store = createStore(openDb(':memory:'));
  const app = createApp(cfg, store, noop, () => {});
  const user = (subject: string, role: 'admin' | 'user' = 'user', state: 'running' | 'dormant' | null = 'running') => {
    store.createUser(subject, `${subject}@example.com`, role);
    const t = state ? store.createTenant(subject, `${subject}@example.com`, { desiredDigest: 'sha256:test' }) : null;
    if (t) store.setTenantState(subject, 'running');
    if (t && state === 'dormant') store.setTenantState(subject, 'dormant');
    const cookie = `arigami_cp_sid=${store.createSession(subject, 30).token}`;
    return { cookie, host: t ? `${t.ns}.lab.example.com` : '' };
  };
  // What Caddy's forward_auth sends: the browser's headers, plus X-Forwarded-Host / -Uri.
  const verify = (host: string, cookie?: string, uri = '/__host/?session=abc') =>
    app.handle(new Request('https://lab.example.com/auth/verify', {
      headers: { host, 'x-forwarded-host': host, 'x-forwarded-uri': uri, 'x-forwarded-method': 'GET', ...(cookie ? { cookie } : {}) },
    }));
  return { cfg, store, app, user, verify };
}

describe('GET /auth/verify', () => {
  test('own session, own running tenant -> 200', async () => {
    const { user, verify } = setup();
    const bob = user('bob');
    const res = await verify(bob.host, bob.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test("another user's tenant -> 403, no redirect", async () => {
    const { user, verify } = setup();
    const bob = user('bob');
    const eve = user('eve');
    const res = await verify(bob.host, eve.cookie);
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
  });

  test('no session -> 302 to the control-plane login, carrying the URL the user wanted', async () => {
    const { user, verify } = setup();
    const bob = user('bob');
    const res = await verify(bob.host, undefined, '/__host/?session=abc');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin).toBe('https://lab.example.com');
    expect(loc.pathname).toBe('/auth/login');
    expect(loc.searchParams.get('rd')).toBe(`https://${bob.host}/__host/?session=abc`);
  });

  test('an expired/unknown session cookie is the same as none', async () => {
    const { user, verify } = setup();
    const bob = user('bob');
    const res = await verify(bob.host, 'arigami_cp_sid=not-a-session');
    expect(res.status).toBe(302);
  });

  test("an org-admin is denied someone else's cockpit, but passes into their own", async () => {
    const { user, verify } = setup();
    const bob = user('bob');
    const root = user('root', 'admin');
    expect((await verify(bob.host, root.cookie)).status).toBe(403);
    expect((await verify(root.host, root.cookie)).status).toBe(200);
  });

  test('bad hosts -> 403: the apex, look-alikes, other domains, a tenant that does not exist', async () => {
    const { user, verify } = setup();
    const bob = user('bob');
    for (const h of ['lab.example.com', `${bob.host}.evil.example.net`, 'u-zz.lab.example.com', 'u-abc.other.example.com', 'x.u-abc.lab.example.com', '']) {
      expect([h, (await verify(h, bob.cookie)).status]).toEqual([h, 403]);
    }
    expect((await verify('u-0123456789.lab.example.com', bob.cookie)).status).toBe(403); // well-formed, no such tenant
  });

  test('a tenant that is not running -> 302 to /workspace (resume + starting page), not 200', async () => {
    const { user, verify } = setup();
    const bob = user('bob', 'user', 'dormant');
    const res = await verify(bob.host, bob.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://lab.example.com/workspace');
  });

  test('a stale host-only cookie next to a valid domain cookie still passes (both values are tried)', async () => {
    const { user, verify } = setup();
    const bob = user('bob');
    const res = await verify(bob.host, `arigami_cp_sid=stale; ${bob.cookie}`);
    expect(res.status).toBe(200);
  });

  test('fails CLOSED without the shared cookie: 503, never a login redirect (that would loop)', async () => {
    const { user, verify } = setup({ CP_COOKIE_PARENT_DOMAIN: '0' });
    const bob = user('bob');
    expect((await verify(bob.host, bob.cookie)).status).toBe(503);
    expect((await verify(bob.host)).status).toBe(503);
  });
});

describe('return URL (open-redirect guard)', () => {
  const { cfg } = setup();
  test('accepts a tenant URL, a local path, and this service', () => {
    expect(safeReturnUrl(cfg, 'https://u-0a1b2c3d4e.lab.example.com/__host/?session=1')).toBe('https://u-0a1b2c3d4e.lab.example.com/__host/?session=1');
    expect(safeReturnUrl(cfg, '/admin')).toBe('/admin');
    expect(safeReturnUrl(cfg, 'https://lab.example.com/workspace')).toBe('https://lab.example.com/workspace');
  });

  test('rejects every off-domain or smuggled target', () => {
    for (const bad of [
      'https://evil.example.net/',
      '//evil.example.net/',
      '/\\evil.example.net/',
      'https://u-0a1b2c3d4e.lab.example.com.evil.example.net/',
      'https://evil.example.net/?x=u-0a1b2c3d4e.lab.example.com',
      'https://u-0a1b2c3d4e.lab.example.com@evil.example.net/',
      'https://user:pw@u-0a1b2c3d4e.lab.example.com/',
      'http://u-0a1b2c3d4e.lab.example.com/', // wrong scheme
      'https://u-0a1b2c3d4e.lab.example.com:8443/', // non-default port
      'https://www.lab.example.com/', // under the org domain but not a tenant
      'javascript:alert(1)',
      'data:text/html,hi',
      '',
    ]) expect([bad, safeReturnUrl(cfg, bad)]).toEqual([bad, null]);
  });

  test('tenant targets are refused while the cookie is host-only (loop guard)', () => {
    const { cfg: off } = setup({ CP_COOKIE_PARENT_DOMAIN: '0' });
    expect(safeReturnUrl(off, 'https://u-0a1b2c3d4e.lab.example.com/')).toBeNull();
    expect(safeReturnUrl(off, '/admin')).toBe('/admin');
  });

  test('/auth/callback sends the browser to a validated rd — and to "/" when the state cookie carries a bad one', async () => {
    // Drive the callback's tail without an IdP: stub oidcCallback on the app's auth service.
    const { app, store } = setup();
    store.createUser('bob', 'bob@example.com', 'user');
    for (const [rd, expected] of [
      ['https://u-0a1b2c3d4e.lab.example.com/__host/', 'https://u-0a1b2c3d4e.lab.example.com/__host/'],
      ['https://evil.example.net/', '/'],
    ]) {
      (app.auth as any).oidcCallback = async () => ({ ok: true, subject: 'bob', email: 'bob@example.com', role: 'user', isNewUser: false, returnTo: rd });
      const res = await app.handle(new Request('https://lab.example.com/auth/callback?code=x&state=y'));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(expected);
    }
  });
});

describe('session cookie scope', () => {
  test('flag on: Domain=<orgDomain>, HttpOnly, Secure, SameSite=Lax — and the host-only twin is cleared', () => {
    const { cfg, store } = setup();
    store.createUser('bob', 'bob@example.com', 'user');
    const [main, clearHostOnly] = createAuthService(cfg, store).login('bob', true).setCookie;
    expect(main).toMatch(/^arigami_cp_sid=[^;]+; Path=\/; Domain=lab\.example\.com; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    expect(clearHostOnly).toBe('arigami_cp_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
  });

  test('flag off (default): host-only, exactly as before', () => {
    const { cfg, store } = setup({ CP_COOKIE_PARENT_DOMAIN: '' });
    store.createUser('bob', 'bob@example.com', 'user');
    const cookies = createAuthService(cfg, store).login('bob', true).setCookie;
    expect(cookies.length).toBe(1);
    expect(cookies[0]).not.toContain('Domain=');
  });

  test('logout clears both scopes and kills every session it was shown', async () => {
    const { app, user, verify } = setup();
    const bob = user('bob');
    const res = await app.handle(new Request('https://lab.example.com/auth/logout', { headers: { cookie: bob.cookie } }));
    const set = res.headers.getSetCookie();
    expect(set.some((c) => c.includes('Domain=lab.example.com') && c.includes('Max-Age=0'))).toBe(true);
    expect(set.some((c) => !c.includes('Domain=') && c.includes('Max-Age=0'))).toBe(true);
    expect((await verify(bob.host, bob.cookie)).status).toBe(302);
  });

  test('refuses to boot when the public URL is not under the org domain (the browser would drop the cookie)', () => {
    expect(() => loadConfig({ CP_PUBLIC_URL: 'https://cp.example.net', CP_ORG_DOMAIN: 'lab.example.com', CP_COOKIE_PARENT_DOMAIN: '1' } as any)).toThrow(/CP_COOKIE_PARENT_DOMAIN/);
    expect(() => loadConfig({ CP_PUBLIC_URL: 'https://cp.lab.example.com', CP_ORG_DOMAIN: 'lab.example.com', CP_COOKIE_PARENT_DOMAIN: '1' } as any)).not.toThrow();
  });
});

describe('cross-origin admin POST', () => {
  test('a form posted from a tenant host is refused; same-origin still works', async () => {
    const { app, store, user } = setup();
    const root = user('root', 'admin', null);
    store.createUser('bob', 'bob@example.com', 'user');
    store.createTenant('bob', 'bob@example.com', { desiredDigest: 'sha256:test' });
    store.setTenantState('bob', 'running');
    const post = (origin: string) => app.handle(new Request('https://lab.example.com/admin/tenants/bob/suspend', { method: 'POST', headers: { cookie: root.cookie, origin } }));
    expect((await post('https://u-0a1b2c3d4e.lab.example.com')).status).toBe(403);
    expect(store.findTenantBySubject('bob')!.state).toBe('running');
    expect((await post('https://lab.example.com')).status).toBe(302);
    expect(store.findTenantBySubject('bob')!.state).toBe('dormant');
  });
});

describe('tenantNsForHost', () => {
  const { cfg } = setup();
  test('maps exactly one label under the org domain, case- and port-insensitively', () => {
    expect(tenantNsForHost(cfg, 'U-0A1B2C3D4E.Lab.Example.Com:443')).toBe('u-0a1b2c3d4e');
    expect(tenantNsForHost(cfg, 'u-0a1b2c3d4e.labXexample.com')).toBeNull(); // dots are literal
  });
});
