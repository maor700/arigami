// CP_PERSONAL_WORKSPACES (auto | choose | never): who gets a personal workspace, the chooser at / and /workspaces,
// and the self-service create POST. Fake provisioner, sessions seeded into the store — no cluster, no IdP.
import { describe, test, expect } from 'bun:test';
import { loadConfig, type PersonalWorkspaces } from '../src/config.js';
import { openDb, createStore } from '../src/db.js';
import { createApp, type Provisioner, type AdminOps } from '../src/server.js';
import { createShared, addMember } from '../src/shared-ops.js';

const ORIGIN = 'https://lab.example.com';
const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(mode?: string) {
  const cfg = loadConfig({
    CP_PUBLIC_URL: ORIGIN, CP_ORG_DOMAIN: 'lab.example.com', CP_URL_SCHEME: 'https', CP_COOKIE_PARENT_DOMAIN: '1',
    ALLOWED_EMAIL_DOMAINS: 'example.com', CP_IMAGE_TAG: 'sha256:test', ...(mode ? { CP_PERSONAL_WORKSPACES: mode } : {}),
  } as unknown as NodeJS.ProcessEnv);
  const store = createStore(openDb(':memory:'));
  const calls: string[] = [];
  const prov: Provisioner = {
    async provisionTenant(_c, t) { calls.push(`provision:${t.subject}`); return { url: `https://${t.ns}.lab.example.com` }; },
    async deleteTenant() {}, async suspendTenant() {},
    async resumeTenant(_c, t) { calls.push(`resume:${t.subject}`); },
  };
  const adminOps: AdminOps = {
    async backupTenant() { return { name: 'x', bytes: 0 }; }, listBackups: () => [],
    async podSnapshot() { throw new Error('no cluster'); }, async pushRoster() {},
  };
  const app = createApp(cfg, store, prov, () => {}, adminOps);
  const cookieOf = (subject: string) => `arigami_cp_sid=${store.createSession(subject, 30).token}`;
  const user = (name: string, role: 'admin' | 'user' = 'user') => {
    store.createUser(name, `${name}@example.com`, role);
    return { subject: name, email: `${name}@example.com`, cookie: cookieOf(name) };
  };
  const shared = async (name: string) => {
    const { provisioned } = createShared(app.sharedDeps, { name, by: 'admin@example.com', orgHost: false });
    await provisioned;
  };
  const join = (name: string, who: { email: string }) => addMember(app.sharedDeps, name, who.email, 'member', 'admin@example.com');
  const personal = (who: { subject: string; email: string }, state: 'running' | 'dormant' | 'deleted' = 'running') => {
    store.createTenant(who.subject, who.email, { desiredDigest: 'sha256:test' });
    if (state === 'running') store.setTenantState(who.subject, 'running');
    if (state === 'dormant') { store.setTenantState(who.subject, 'running'); store.setTenantState(who.subject, 'dormant'); }
    if (state === 'deleted') store.setTenantState(who.subject, 'deleted');
  };
  const get = (p: string, cookie?: string) => app.handle(new Request(ORIGIN + p, { headers: cookie ? { cookie } : {} }));
  const post = (p: string, cookie: string, origin = ORIGIN) =>
    app.handle(new Request(ORIGIN + p, { method: 'POST', headers: { cookie, origin }, body: new URLSearchParams({ subject: 'someone-else' }) }));
  return { cfg, store, app, calls, user, shared, join, personal, get, post };
}

type S = ReturnType<typeof setup>;
type Who = ReturnType<S['user']>;
const states = ['none', 'shared', 'personal', 'both', 'deleted'] as const;
async function arrange(s: S, st: (typeof states)[number], who: Who) {
  if (st === 'shared' || st === 'both' || st === 'deleted') { await s.shared('eng'); s.join('eng', who); }
  if (st === 'personal' || st === 'both') s.personal(who);
  if (st === 'deleted') s.personal(who, 'deleted');
}
const loc = (r: Response) => r.headers.get('location');

describe('config', () => {
  test('defaults to auto, accepts the three modes, refuses anything else on boot', () => {
    expect(setup().cfg.personalWorkspaces).toBe('auto');
    for (const m of ['auto', 'choose', 'never'] as PersonalWorkspaces[]) expect(setup(m).cfg.personalWorkspaces).toBe(m);
    expect(setup(' Choose ').cfg.personalWorkspaces).toBe('choose');
    expect(() => setup('sometimes')).toThrow(/CP_PERSONAL_WORKSPACES/);
  });
});

describe('auto (unchanged behaviour)', () => {
  test('/ provisions a personal workspace for a user with none, even when they are a shared member', async () => {
    for (const st of ['none', 'shared'] as const) {
      const s = setup('auto'); const bob = s.user('bob'); await arrange(s, st, bob);
      const res = await s.get('/', bob.cookie);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Setting up your workspace');
      await tick();
      expect(s.calls).toContain('provision:bob');
    }
  });
  test('/ with a running personal workspace hands off into it, shared membership or not', async () => {
    const s = setup('auto'); const bob = s.user('bob'); await arrange(s, 'both', bob);
    const res = await s.get('/', bob.cookie);
    expect(res.status).toBe(302);
    expect(loc(res)).toContain(s.store.findPersonalTenant('bob')!.ns);
  });
  test('/ after a deletion starts a fresh workspace', async () => {
    const s = setup('auto'); const bob = s.user('bob'); await arrange(s, 'personal', bob);
    s.store.setTenantState('bob', 'deleted');
    const res = await s.get('/', bob.cookie);
    expect(await res.text()).toContain('Setting up your workspace');
    expect(s.store.findPersonalTenant('bob')!.state).not.toBe('deleted');
  });
  test('/workspaces keeps "Open my workspace" next to the shared ones', async () => {
    const s = setup('auto'); const bob = s.user('bob'); await arrange(s, 'both', bob);
    const body = await (await s.get('/workspaces', bob.cookie)).text();
    expect(body).toContain('Open my workspace');
    expect(body).toContain('/workspaces/eng/open');
    expect(body).not.toContain('Create my workspace');
  });
});

describe('choose', () => {
  test('/ never provisions: every starting state lands where it should', async () => {
    const want: Record<(typeof states)[number], (r: Response, s: S) => void> = {
      none: (r) => expect(loc(r)).toBe('/workspaces'),
      shared: (r) => expect(loc(r)).toBe('/workspaces/eng/open'),
      personal: (r, s) => expect(loc(r)).toContain(s.store.findPersonalTenant('bob')!.ns),
      both: (r) => expect(loc(r)).toBe('/workspaces'),
      deleted: (r) => expect(loc(r)).toBe('/workspaces/eng/open'),
    };
    for (const st of states) {
      const s = setup('choose'); const bob = s.user('bob'); await arrange(s, st, bob);
      const before = s.store.findPersonalTenant('bob')?.state;
      const res = await s.get('/', bob.cookie);
      expect(res.status).toBe(302);
      want[st](res, s);
      await tick();
      expect(s.calls.filter((c) => c.startsWith('provision:bob'))).toEqual([]);
      expect(s.store.findPersonalTenant('bob')?.state).toBe(before);
    }
  });
  test('two shared memberships and no personal -> the chooser', async () => {
    const s = setup('choose'); const bob = s.user('bob');
    await s.shared('eng'); await s.shared('ops'); s.join('eng', bob); s.join('ops', bob);
    expect(loc(await s.get('/', bob.cookie))).toBe('/workspaces');
  });
  test('the chooser: first sign-in shows only the personal card with the invite hint', async () => {
    const s = setup('choose'); const bob = s.user('bob');
    const body = await (await s.get('/workspaces', bob.cookie)).text();
    expect(body).toContain('Where do you want to work?');
    expect(body).toContain('Your own workspace');
    expect(body).toContain('action="/workspaces/personal"');
    expect(body).toContain('Create my workspace');
    expect(body).toContain('invite you to a shared workspace');
    expect(body).not.toContain('/open"');
  });
  test('the chooser: shared-only member sees Open with role + state and Create my workspace', async () => {
    const s = setup('choose'); const bob = s.user('bob'); await arrange(s, 'shared', bob);
    const body = await (await s.get('/workspaces', bob.cookie)).text();
    expect(body).toContain('/workspaces/eng/open');
    expect(body).toContain('your role: member');
    expect(body).toContain('running');
    expect(body).toContain('Create my workspace');
  });
  test('the chooser: personal + shared side by side, no create button', async () => {
    const s = setup('choose'); const bob = s.user('bob'); await arrange(s, 'both', bob);
    const body = await (await s.get('/workspaces', bob.cookie)).text();
    expect(body).toContain('/workspaces/eng/open');
    expect(body).toContain('Open my workspace');
    expect(body).not.toContain('Create my workspace');
  });
  test('the chooser: a deleted personal workspace can be created again', async () => {
    const s = setup('choose'); const bob = s.user('bob'); await arrange(s, 'deleted', bob);
    const body = await (await s.get('/workspaces', bob.cookie)).text();
    expect(body).toContain('Create my workspace');
    expect(body).not.toContain('>deleted<');
    const res = await s.post('/workspaces/personal', bob.cookie);
    expect(res.status).toBe(303);
    await tick();
    expect(s.store.findPersonalTenant('bob')!.state).toBe('running');
    expect(s.calls.filter((c) => c === 'provision:bob')).toHaveLength(1);
  });
  test('/workspace without a personal workspace goes to the chooser and does not provision', async () => {
    const s = setup('choose'); const bob = s.user('bob'); await arrange(s, 'shared', bob);
    expect(loc(await s.get('/workspace', bob.cookie))).toBe('/workspaces');
    await tick();
    expect(s.store.findPersonalTenant('bob')).toBeNull();
  });
  test('/workspace with a personal workspace resumes a dormant one (the gate redirect target)', async () => {
    const s = setup('choose'); const bob = s.user('bob'); await arrange(s, 'both', bob); s.store.setTenantState('bob', 'dormant');
    const res = await s.get('/workspace', bob.cookie);
    expect(await res.text()).toContain('Setting up your workspace');
    await tick();
    expect(s.calls).toContain('resume:bob');
  });
  test('POST create: the first press provisions, a double click / refresh does not make a second, and lands on the starting page', async () => {
    const s = setup('choose'); const bob = s.user('bob'); await arrange(s, 'shared', bob);
    const a = await s.post('/workspaces/personal', bob.cookie);
    const b = await s.post('/workspaces/personal', bob.cookie);
    expect([a.status, loc(a)]).toEqual([303, '/workspace']);
    expect([b.status, loc(b)]).toEqual([303, '/workspace']);
    await tick();
    expect(s.calls.filter((c) => c === 'provision:bob')).toEqual(['provision:bob']);
    expect(s.store.listTenants().filter((t) => t.kind !== 'shared')).toHaveLength(1);
    expect(await (await s.get('/workspace', bob.cookie)).text()).not.toContain('Where do you want');
  });
  test('POST create: only for the signed-in user, signed-out and cross-origin posts do nothing', async () => {
    const s = setup('choose'); const bob = s.user('bob'); const eve = s.user('eve');
    await s.post('/workspaces/personal', bob.cookie);
    expect(s.store.findPersonalTenant('bob')).toBeTruthy();
    expect(s.store.findPersonalTenant('eve')).toBeNull();
    expect(s.store.findPersonalTenant('someone-else')).toBeNull();
    const anon = await s.app.handle(new Request(ORIGIN + '/workspaces/personal', { method: 'POST', headers: { origin: ORIGIN } }));
    expect(loc(anon)).toBe('/');
    expect((await s.post('/workspaces/personal', eve.cookie, 'https://evil.example.net')).status).toBe(403);
    expect(s.store.findPersonalTenant('eve')).toBeNull();
  });
  test('an org-admin: / still goes to /admin, /workspace is their own workspace as ever', async () => {
    const s = setup('choose'); const root = s.user('root', 'admin');
    expect(loc(await s.get('/', root.cookie))).toBe('/admin');
    expect(await (await s.get('/workspace', root.cookie)).text()).toContain('Setting up your workspace');
    expect(s.store.findPersonalTenant('root')).toBeTruthy();
  });
  test('the admin page explains that personal workspaces are created by the user, and has no admin-side create', async () => {
    const s = setup('choose'); const root = s.user('root', 'admin');
    const body = await (await s.get('/admin', root.cookie)).text();
    expect(body).toContain('created by the users themselves');
    expect(body).not.toContain('/workspaces/personal');
  });
});

describe('never', () => {
  test('/ and /workspace: no personal workspace is provisioned for any state', async () => {
    for (const st of states) {
      const s = setup('never'); const bob = s.user('bob'); await arrange(s, st, bob);
      const hadPersonal = !!s.store.findPersonalTenant('bob');
      for (const p of ['/', '/workspace']) await s.get(p, bob.cookie);
      await tick();
      expect(s.calls).not.toContain('provision:bob');
      expect(!!s.store.findPersonalTenant('bob')).toBe(hadPersonal);
    }
  });
  test('/workspace for a non-admin answers the shared-only page', async () => {
    const s = setup('never'); const bob = s.user('bob');
    const res = await s.get('/workspace', bob.cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('uses shared workspaces');
    expect(body).toContain('invite');
  });
  test('/ : none -> shared-only page, one shared -> straight in, two -> chooser', async () => {
    const s = setup('never'); const bob = s.user('bob');
    expect(await (await s.get('/', bob.cookie)).text()).toContain('uses shared workspaces');
    await s.shared('eng'); s.join('eng', bob);
    expect(loc(await s.get('/', bob.cookie))).toBe('/workspaces/eng/open');
    await s.shared('ops'); s.join('ops', bob);
    expect(loc(await s.get('/', bob.cookie))).toBe('/workspaces');
  });
  test('/workspaces has no personal card, with the invite hint when empty', async () => {
    const s = setup('never'); const bob = s.user('bob');
    let body = await (await s.get('/workspaces', bob.cookie)).text();
    expect(body).not.toContain('Your own workspace');
    expect(body).not.toContain('Create my workspace');
    expect(body).toContain('Ask an organisation admin');
    await arrange(s, 'shared', bob);
    body = await (await s.get('/workspaces', bob.cookie)).text();
    expect(body).toContain('/workspaces/eng/open');
    expect(body).not.toContain('Your own workspace');
  });
  test('the create POST is refused for users (403, nothing made) but an org-admin keeps their own', async () => {
    const s = setup('never'); const bob = s.user('bob'); const root = s.user('root', 'admin');
    expect((await s.post('/workspaces/personal', bob.cookie)).status).toBe(403);
    expect(s.store.findPersonalTenant('bob')).toBeNull();
    expect((await s.post('/workspaces/personal', root.cookie)).status).toBe(303);
    expect(s.store.findPersonalTenant('root')).toBeTruthy();
  });
  test('the admin page says the org is shared-only; the admin still sees Open my workspace on /workspaces', async () => {
    const s = setup('never'); const root = s.user('root', 'admin');
    expect(await (await s.get('/admin', root.cookie)).text()).toContain('shared-only');
    expect(await (await s.get('/workspaces', root.cookie)).text()).toContain('Open my workspace');
  });
});

describe('the edge gate lands on the chooser path, not on a provisioning one', () => {
  test('choose: a personal workspace that is not running -> /workspace, which resumes it; a shared one -> its open route', async () => {
    const s = setup('choose'); const bob = s.user('bob'); await arrange(s, 'both', bob); s.store.setTenantState('bob', 'dormant');
    const ns = s.store.findPersonalTenant('bob')!.ns;
    const host = `${ns}.lab.example.com`;
    const r = await s.app.handle(new Request(ORIGIN + '/auth/verify', { headers: { host, 'x-forwarded-host': host, cookie: bob.cookie } }));
    expect(loc(r)).toBe(`${ORIGIN}/workspace`);
    const res = await s.get('/workspace', bob.cookie);
    expect(res.status).toBe(200); // starting page, no loop back to the gate
  });
});
