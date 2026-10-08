// Shared org workspaces (src/shared*.ts): migrations, the access decision, the gate, the picker/open handoff,
// the admin routes, the roster push (and its retry), the CLI and the provisioner's chart flags. No cluster, no
// IdP — a fake provisioner, sessions seeded into the store, and Bun.spawn intercepted for the helm/kubectl args.
import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb, createStore, tenantIdFor, type Tenant } from '../src/db.js';
import { createApp, type Provisioner, type AdminOps } from '../src/server.js';
import { decideAccess, rosterFor, sharedSubject, tenantRoleFor, type Member } from '../src/shared.js';
import { createShared, addMember, removeMember, setPolicy, deleteShared, syncRoster, rosterSyncTick, sharedHelmArgs, SharedError, type SharedDeps } from '../src/shared-ops.js';
import { runSharedCli } from '../src/shared-cli.js';
import * as provisioner from '../src/provisioner.js';

const decode = (tok: string): any => JSON.parse(Buffer.from(tok.split('.')[0], 'base64url').toString('utf8'));
const cfgOf = (env: Record<string, string> = {}) =>
  loadConfig({
    CP_PUBLIC_URL: 'https://lab.example.com',
    CP_ORG_DOMAIN: 'lab.example.com',
    CP_URL_SCHEME: 'https',
    CP_COOKIE_PARENT_DOMAIN: '1',
    ALLOWED_EMAIL_DOMAINS: 'example.com',
    CP_IMAGE_TAG: 'sha256:test',
    ...env,
  } as unknown as NodeJS.ProcessEnv);

const fakeProvisioner = (calls: string[] = []): Provisioner => ({
  async provisionTenant(_c, t) { calls.push(`provision:${t.ns}`); return { url: `https://${t.ns}.lab.example.com` }; },
  async deleteTenant(_c, t) { calls.push(`delete:${t.ns}`); },
  async suspendTenant(_c, t) { calls.push(`suspend:${t.ns}`); },
  async resumeTenant(_c, t) { calls.push(`resume:${t.ns}`); },
});

function setup(opts: { pushFails?: boolean } = {}) {
  const cfg = cfgOf();
  const store = createStore(openDb(':memory:'));
  const calls: string[] = [];
  const pushes: { ns: string; roster: any }[] = [];
  const state = { pushFails: !!opts.pushFails };
  const adminOps: AdminOps = {
    async backupTenant() { return { name: 'x', bytes: 0 }; },
    listBackups: () => [],
    async podSnapshot() { throw new Error('no cluster'); },
    async pushRoster(_c, t, token) {
      if (state.pushFails) throw new Error('pod unreachable');
      pushes.push({ ns: t.ns, roster: decode(token).roster });
    },
  };
  const app = createApp(cfg, store, fakeProvisioner(calls), () => {}, adminOps);
  const deps: SharedDeps = app.sharedDeps;
  const user = (subject: string, role: 'admin' | 'user' = 'user', personal = true) => {
    store.createUser(subject, `${subject}@example.com`, role);
    const t = personal ? store.createTenant(subject, `${subject}@example.com`, { desiredDigest: 'sha256:test' }) : null;
    if (t) store.setTenantState(subject, 'running');
    return { email: `${subject}@example.com`, cookie: `arigami_cp_sid=${store.createSession(subject, 30).token}`, host: t ? `${t.ns}.lab.example.com` : '' };
  };
  const shared = async (name: string, o: Partial<Parameters<typeof createShared>[1]> = {}) => {
    const { tenant, provisioned } = createShared(deps, { name, by: 'admin@example.com', orgHost: false, ...o });
    await provisioned;
    return { tenant: store.findShared(name)!, host: `${tenant.ns}.lab.example.com` };
  };
  const verify = (host: string, cookie?: string) =>
    app.handle(new Request('https://lab.example.com/auth/verify', {
      headers: { host, 'x-forwarded-host': host, 'x-forwarded-uri': '/__host/', ...(cookie ? { cookie } : {}) },
    }));
  const get = (p: string, cookie?: string) => app.handle(new Request(`https://lab.example.com${p}`, { headers: cookie ? { cookie } : {} }));
  const post = (p: string, cookie: string, form: Record<string, string> = {}, origin = 'https://lab.example.com') =>
    app.handle(new Request(`https://lab.example.com${p}`, { method: 'POST', headers: { cookie, origin }, body: new URLSearchParams(form) }));
  return { cfg, store, app, deps, calls, pushes, state, user, shared, verify, get, post };
}

describe('migrations', () => {
  test('a K8S-3 database gains the shared columns and table; existing rows stay personal; re-open is a no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-shared-mig-'));
    const file = path.join(dir, 'cp.db');
    const old = new Database(file, { create: true });
    old.exec(`
      CREATE TABLE users (subject TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE tenants (subject TEXT PRIMARY KEY REFERENCES users(subject), email TEXT NOT NULL, ns TEXT NOT NULL UNIQUE,
        release TEXT NOT NULL, desired_digest TEXT NOT NULL DEFAULT '', running_digest TEXT NOT NULL DEFAULT '',
        ring TEXT NOT NULL DEFAULT 'stable', state TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        handoff_secret TEXT NOT NULL DEFAULT '');
      CREATE TABLE sessions (token TEXT PRIMARY KEY, subject TEXT NOT NULL, exp INTEGER NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO tenants VALUES ('old', 'old@example.com', 'u-0123456789', 'u-0123456789', 'd', 'd', 'stable', 'running', 'x', 'x', 'secret-secret-secret');
    `);
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = openDb(file);
      const cols = (db.query('PRAGMA table_info(tenants)').all() as { name: string }[]).map((c) => c.name);
      for (const c of ['kind', 'name', 'member_policy', 'default_role', 'org_host', 'roster_gen', 'roster_synced_gen']) expect(cols).toContain(c);
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'tenant_members'").get()).toBeTruthy();
      const store = createStore(db);
      const t = store.findPersonalTenant('old')!;
      expect(t.kind).toBe('personal');
      expect(t.handoff_secret).toBe('secret-secret-secret');
      expect(store.listShared()).toEqual([]);
      db.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('two shared workspaces cannot share a name (DB-level, not just a pre-check)', () => {
    const store = createStore(openDb(':memory:'));
    store.createTenant(sharedSubject('a'), '', { desiredDigest: 'x' });
    store.markShared(sharedSubject('a'), { name: 'eng', policy: 'explicit', defaultRole: 'member', orgHost: false });
    store.createTenant(sharedSubject('b'), '', { desiredDigest: 'x' });
    expect(() => store.markShared(sharedSubject('b'), { name: 'eng', policy: 'explicit', defaultRole: 'member', orgHost: false })).toThrow();
  });
});

describe('decideAccess — the decision table', () => {
  const base = (over: Partial<Tenant> = {}): Tenant => ({
    subject: 'alice', email: 'alice@example.com', ns: 'u-aaaaaaaaaa', release: 'u-aaaaaaaaaa', desired_digest: '', running_digest: '',
    ring: 'stable', state: 'running', created_at: '', last_seen_at: '', handoff_secret: 's'.repeat(20),
    kind: 'personal', name: '', member_policy: 'explicit', default_role: 'member', org_host: 0, roster_gen: 0, roster_synced_gen: 0, ...over,
  });
  const shared = (over: Partial<Tenant> = {}) => base({ subject: 'shared:eng', email: '', ns: 'u-bbbbbbbbbb', kind: 'shared', name: 'eng', ...over });
  const mem = (email: string, role: Member['role'], ns = 'u-bbbbbbbbbb'): Member => ({ ns, email, role, added_by: 'x', added_at: '' });
  const alice = { subject: 'alice', email: 'alice@example.com' };
  const bob = { subject: 'bob', email: 'bob@example.com' };

  const rows: [string, Tenant | null, { subject: string; email: string }, Member | null, boolean, string?][] = [
    ['no tenant', null, alice, null, false],
    ['personal, owner', base(), alice, null, true, 'owner'],
    ['personal, someone else', base(), bob, null, false],
    ['personal, someone else even with a stray member row', base(), bob, mem('bob@example.com', 'admin', 'u-aaaaaaaaaa'), false],
    ['personal tenant without kind (pre-migration literal) is personal', base({ kind: undefined }), alice, null, true, 'owner'],
    ['shared, listed member', shared(), bob, mem('bob@example.com', 'member'), true, 'member'],
    ['shared, listed viewer', shared(), bob, mem('bob@example.com', 'viewer'), true, 'viewer'],
    ['shared, not listed (explicit)', shared(), bob, null, false],
    ['shared, member row of ANOTHER workspace', shared(), bob, mem('bob@example.com', 'admin', 'u-cccccccccc'), false],
    ['shared, member row for another e-mail', shared(), bob, mem('carol@example.com', 'admin'), false],
    ['shared, subject equals the tenant subject (IdP look-alike)', shared(), { subject: 'shared:eng', email: 'x@example.com' }, null, false],
    ['shared org policy, anyone signed in gets the default', shared({ member_policy: 'org', default_role: 'viewer' }), bob, null, true, 'viewer'],
    ['shared org policy, explicit row overrides', shared({ member_policy: 'org', default_role: 'viewer' }), bob, mem('bob@example.com', 'admin'), true, 'admin'],
    ['shared org policy with a corrupt default role', shared({ member_policy: 'org', default_role: 'root' as any }), bob, null, false],
    ['shared, member with a corrupt role', shared(), bob, mem('bob@example.com', 'root' as any), false],
    ['shared, deleted', shared({ state: 'deleted' }), bob, mem('bob@example.com', 'owner'), false],
    ['personal, deleted', base({ state: 'deleted' }), alice, null, false],
  ];
  for (const [name, t, who, m, allow, role] of rows) {
    test(name, () => {
      const a = decideAccess(t, who, m);
      expect(a.allow).toBe(allow);
      if (allow && a.allow) expect(a.role).toBe(role as any);
    });
  }

  test('role mapping onto the tenant host (owner/admin -> admin, member -> user, viewer -> viewer)', () => {
    expect(['owner', 'admin', 'member', 'viewer'].map((r) => tenantRoleFor(r as any))).toEqual(['admin', 'admin', 'user', 'viewer']);
  });
});

describe('GET /auth/verify with shared workspaces', () => {
  test('member 200, non-member 403, org-admin non-member 403', async () => {
    const s = setup();
    const bob = s.user('bob');
    const eve = s.user('eve');
    const boss = s.user('boss', 'admin');
    const eng = await s.shared('eng');
    await addMember(s.deps, 'eng', bob.email, 'member', 'boss@example.com');
    expect((await s.verify(eng.host, bob.cookie)).status).toBe(200);
    expect((await s.verify(eng.host, eve.cookie)).status).toBe(403);
    expect((await s.verify(eng.host, boss.cookie)).status).toBe(403);
    // personal tenants are unchanged
    expect((await s.verify(bob.host, bob.cookie)).status).toBe(200);
    expect((await s.verify(bob.host, eve.cookie)).status).toBe(403);
  });

  test('a member of one workspace reaches neither another shared workspace nor anyone’s personal tenant', async () => {
    const s = setup();
    const bob = s.user('bob');
    const carol = s.user('carol');
    const eng = await s.shared('eng');
    const ops = await s.shared('ops');
    await addMember(s.deps, 'eng', bob.email, 'owner', 'x');
    await addMember(s.deps, 'ops', carol.email, 'member', 'x');
    expect((await s.verify(eng.host, bob.cookie)).status).toBe(200);
    expect((await s.verify(ops.host, bob.cookie)).status).toBe(403);
    expect((await s.verify(carol.host, bob.cookie)).status).toBe(403);
  });

  test('removing a member shuts them out on the very next request (no cached decision)', async () => {
    const s = setup();
    const bob = s.user('bob');
    const eng = await s.shared('eng');
    await addMember(s.deps, 'eng', bob.email, 'member', 'x');
    expect((await s.verify(eng.host, bob.cookie)).status).toBe(200);
    await removeMember(s.deps, 'eng', bob.email, 'x');
    expect((await s.verify(eng.host, bob.cookie)).status).toBe(403);
  });

  test('org policy admits every signed-in org user; switching back to explicit shuts the unlisted out', async () => {
    const s = setup();
    const bob = s.user('bob');
    const eng = await s.shared('eng', { policy: 'org', defaultRole: 'viewer' });
    expect((await s.verify(eng.host, bob.cookie)).status).toBe(200);
    await setPolicy(s.deps, 'eng', 'explicit', 'member', 'x');
    expect((await s.verify(eng.host, bob.cookie)).status).toBe(403);
  });

  test('no session -> login redirect, like a personal tenant', async () => {
    const s = setup();
    const eng = await s.shared('eng');
    const res = await s.verify(eng.host);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toStartWith('https://lab.example.com/auth/login?rd=');
  });

  test('shared and not running -> its own open page; deleted -> 403', async () => {
    const s = setup();
    const bob = s.user('bob');
    const eng = await s.shared('eng');
    await addMember(s.deps, 'eng', bob.email, 'member', 'x');
    s.store.setTenantState(eng.tenant.subject, 'dormant');
    const res = await s.verify(eng.host, bob.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://lab.example.com/workspaces/eng/open');
    s.store.setTenantState(eng.tenant.subject, 'deleted');
    expect((await s.verify(eng.host, bob.cookie)).status).toBe(403);
  });

  test('an IdP subject that looks like a shared one does not own it, and gets no personal tenant in its place', async () => {
    const s = setup();
    const eng = await s.shared('eng');
    s.store.createUser('shared:eng', 'mallory@example.com', 'user');
    const cookie = `arigami_cp_sid=${s.store.createSession('shared:eng', 30).token}`;
    expect((await s.verify(eng.host, cookie)).status).toBe(403);
    expect(() => s.app.ensureTenant('shared:eng', 'mallory@example.com')).toThrow();
    expect(s.store.findShared('eng')!.kind).toBe('shared');
  });
});

describe('picker and open', () => {
  test('/workspaces lists exactly the shared workspaces you may open, with your role', async () => {
    const s = setup();
    const bob = s.user('bob');
    await s.shared('eng');
    await s.shared('ops');
    await s.shared('all', { policy: 'org', defaultRole: 'viewer' });
    await addMember(s.deps, 'eng', bob.email, 'admin', 'x');
    const body = await (await s.get('/workspaces', bob.cookie)).text();
    expect(body).toContain('/workspaces/eng/open');
    expect(body).toContain('/workspaces/all/open');
    expect(body).not.toContain('/workspaces/ops/open');
    expect(body).toContain('Open my workspace');
  });

  test('/ still lands a normal user in their personal workspace', async () => {
    const s = setup();
    const bob = s.user('bob');
    await s.shared('eng');
    await addMember(s.deps, 'eng', bob.email, 'member', 'x');
    const res = await s.get('/', bob.cookie);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).host).toBe(bob.host);
  });

  test('open signs each member in AS THEMSELVES with their mapped role', async () => {
    const s = setup();
    const bob = s.user('bob');
    const carol = s.user('carol');
    const eng = await s.shared('eng');
    await addMember(s.deps, 'eng', bob.email, 'viewer', 'x');
    await addMember(s.deps, 'eng', carol.email, 'owner', 'x');
    for (const [who, role] of [[bob, 'viewer'], [carol, 'admin']] as const) {
      const res = await s.get('/workspaces/eng/open', who.cookie);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.host).toBe(eng.host);
      expect(loc.pathname).toBe('/__api/auth/handoff');
      const payload = decode(loc.searchParams.get('t')!);
      expect(payload).toMatchObject({ kind: 'handoff', email: who.email, role });
    }
  });

  test('open refuses a non-member with the same answer as an unknown name', async () => {
    const s = setup();
    const eve = s.user('eve');
    await s.shared('eng');
    const a = await s.get('/workspaces/eng/open', eve.cookie);
    const b = await s.get('/workspaces/nope/open', eve.cookie);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(await a.text()).toBe(await b.text());
    expect(a.headers.get('location')).toBeNull();
  });

  test('open on a dormant workspace wakes it and shows the wait page', async () => {
    const s = setup();
    const bob = s.user('bob');
    const eng = await s.shared('eng');
    await addMember(s.deps, 'eng', bob.email, 'member', 'x');
    s.store.setTenantState(eng.tenant.subject, 'dormant');
    const res = await s.get('/workspaces/eng/open', bob.cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Starting eng');
    expect(s.calls).toContain(`resume:${eng.tenant.ns}`);
  });

  test('signed out -> login with a return path back to the open route', async () => {
    const s = setup();
    const res = await s.get('/workspaces/eng/open');
    expect(res.headers.get('location')).toBe('/auth/login?rd=%2Fworkspaces%2Feng%2Fopen');
  });
});

describe('admin routes', () => {
  test('create / add / change role / remove / policy / delete, all as org-admin', async () => {
    const s = setup();
    const boss = s.user('boss', 'admin');
    expect((await s.post('/admin/shared', boss.cookie, { name: 'eng', policy: 'explicit', default_role: 'member', org_host: '1' })).status).toBe(302);
    await new Promise((r) => setTimeout(r, 5)); // provisioning is fire-and-forget on the page
    const t = s.store.findShared('eng')!;
    expect(t.state).toBe('running');
    expect(t.org_host).toBe(1);
    expect(s.store.listMembers(t.ns)).toEqual([]); // creating it does NOT make the admin a member
    await s.post('/admin/shared/eng/members', boss.cookie, { email: 'Bob@Example.com', role: 'member' });
    await s.post('/admin/shared/eng/members', boss.cookie, { email: 'bob@example.com', role: 'viewer' });
    expect(s.store.listMembers(t.ns).map((m) => [m.email, m.role, m.added_by])).toEqual([['bob@example.com', 'viewer', 'boss@example.com']]);
    await s.post('/admin/shared/eng/policy', boss.cookie, { policy: 'org', default_role: 'viewer' });
    expect(s.store.findShared('eng')!.member_policy).toBe('org');
    await s.post('/admin/shared/eng/members/remove', boss.cookie, { email: 'bob@example.com' });
    expect(s.store.listMembers(t.ns)).toEqual([]);
    const page = await (await s.get('/admin', boss.cookie)).text();
    expect(page).toContain('Shared workspaces');
    expect(page).toContain('shared:</em> eng');
    expect((await s.post('/admin/shared/eng/delete', boss.cookie)).status).toBe(302);
    expect(s.store.findShared('eng')!.state).toBe('deleted');
    expect(s.calls).toContain(`delete:${t.ns}`);
  });

  test('a plain user cannot manage shared workspaces', async () => {
    const s = setup();
    const bob = s.user('bob');
    await s.shared('eng');
    expect((await s.post('/admin/shared', bob.cookie, { name: 'mine' })).status).toBe(403);
    expect((await s.post('/admin/shared/eng/members', bob.cookie, { email: 'bob@example.com', role: 'owner' })).status).toBe(403);
    expect(s.store.listMembers(s.store.findShared('eng')!.ns)).toEqual([]);
    expect(s.store.findShared('mine')).toBeNull();
  });

  test('a form posted from a tenant origin is refused (Origin check covers the shared routes)', async () => {
    const s = setup();
    const boss = s.user('boss', 'admin');
    const eng = await s.shared('eng');
    const res = await s.post('/admin/shared/eng/members', boss.cookie, { email: 'mallory@example.com', role: 'owner' }, `https://${eng.host}`);
    expect(res.status).toBe(403);
    expect(s.store.listMembers(eng.tenant.ns)).toEqual([]);
  });

  test('bad input is a 4xx page, not a crash', async () => {
    const s = setup();
    const boss = s.user('boss', 'admin');
    await s.shared('eng');
    expect((await s.post('/admin/shared', boss.cookie, { name: 'Bad Name!' })).status).toBe(400);
    expect((await s.post('/admin/shared', boss.cookie, { name: 'eng' })).status).toBe(409);
    expect((await s.post('/admin/shared/eng/members', boss.cookie, { email: 'not-an-email', role: 'member' })).status).toBe(400);
    expect((await s.post('/admin/shared/eng/members', boss.cookie, { email: 'a@example.com', role: 'root' })).status).toBe(400);
    expect((await s.post('/admin/shared/nope/members', boss.cookie, { email: 'a@example.com', role: 'member' })).status).toBe(404);
    expect((await s.post('/admin/shared/%E0%A4%A/members', boss.cookie, { email: 'a@example.com', role: 'member' })).status).toBe(404);
    expect((await s.get('/workspaces/%E0%A4%A/open', boss.cookie)).status).toBe(403);
  });
});

describe('create rules', () => {
  test('one org host per organisation', async () => {
    const s = setup();
    await s.shared('org', { orgHost: true });
    expect(() => createShared(s.deps, { name: 'second', by: 'x', orgHost: true })).toThrow(SharedError);
    expect(() => createShared(s.deps, { name: 'second', by: 'x', orgHost: false })).not.toThrow();
  });

  test('a deleted name is not reused (the address would come back to life)', async () => {
    const s = setup();
    await s.shared('eng');
    await deleteShared(s.deps, 'eng', 'x');
    expect(() => createShared(s.deps, { name: 'eng', by: 'x' })).toThrow(/already exists/);
  });

  test('a shared workspace keeps the u-<hex> namespace scheme and gets its own handoff secret', async () => {
    const s = setup();
    const eng = await s.shared('eng');
    expect(eng.tenant.ns).toBe(`u-${tenantIdFor('shared:eng')}`);
    expect(eng.tenant.handoff_secret.length).toBeGreaterThanOrEqual(16);
    expect(eng.tenant.email).toBe('');
  });
});

describe('roster push', () => {
  test('every membership change pushes the full roster with a growing generation', async () => {
    const s = setup();
    const eng = await s.shared('eng', { members: [{ email: 'owner@example.com', role: 'owner' }] });
    expect(s.pushes.at(-1)!.roster).toEqual({ gen: 1, policy: 'explicit', defaultRole: null, members: { 'owner@example.com': 'admin' } });
    await addMember(s.deps, 'eng', 'bob@example.com', 'viewer', 'x');
    expect(s.pushes.at(-1)!.roster.members).toEqual({ 'owner@example.com': 'admin', 'bob@example.com': 'viewer' });
    await removeMember(s.deps, 'eng', 'bob@example.com', 'x');
    const last = s.pushes.at(-1)!;
    expect(last.ns).toBe(eng.tenant.ns);
    expect(last.roster.gen).toBe(3);
    expect(last.roster.members).toEqual({ 'owner@example.com': 'admin' });
    const t = s.store.findShared('eng')!;
    expect(t.roster_synced_gen).toBe(t.roster_gen);
  });

  test('a failed push stays dirty and the retry tick delivers it', async () => {
    const s = setup({ pushFails: true });
    await s.shared('eng');
    const r = await addMember(s.deps, 'eng', 'bob@example.com', 'member', 'x');
    expect(r.sync.pushed).toBe(false);
    expect(s.store.rosterDirty().map((t) => t.name)).toEqual(['eng']);
    expect(await rosterSyncTick(s.deps)).toEqual([]);
    s.state.pushFails = false;
    expect(await rosterSyncTick(s.deps)).toEqual(['eng']);
    expect(s.store.rosterDirty()).toEqual([]);
  });

  test('a stopped workspace is not pushed to; it is once it runs again', async () => {
    const s = setup();
    const eng = await s.shared('eng');
    s.store.setTenantState(eng.tenant.subject, 'dormant');
    expect((await addMember(s.deps, 'eng', 'bob@example.com', 'member', 'x')).sync.pushed).toBe(false);
    s.store.setTenantState(eng.tenant.subject, 'running');
    expect(await rosterSyncTick(s.deps)).toEqual(['eng']);
  });

  test('synced generation never moves backwards', () => {
    const store = createStore(openDb(':memory:'));
    store.createTenant(sharedSubject('eng'), '', { desiredDigest: 'x' });
    store.markShared(sharedSubject('eng'), { name: 'eng', policy: 'explicit', defaultRole: 'member', orgHost: false });
    const ns = store.findShared('eng')!.ns;
    store.bumpRoster(ns); store.bumpRoster(ns);
    store.markRosterSynced(ns, 2);
    store.markRosterSynced(ns, 1);
    expect(store.findShared('eng')!.roster_synced_gen).toBe(2);
  });

  test('org policy rosters carry the default role in tenant vocabulary', () => {
    const t = { ns: 'u-1', member_policy: 'org', default_role: 'member', roster_gen: 7 } as any;
    expect(rosterFor(t, [])).toEqual({ gen: 7, policy: 'org', defaultRole: 'user', members: {} });
  });

  test('no transport -> reported, not thrown', async () => {
    const s = setup();
    await s.shared('eng');
    const r = await syncRoster({ ...s.deps, pushRoster: undefined }, 'eng');
    expect(r).toEqual({ pushed: false, reason: 'no roster transport configured' });
  });
});

describe('CLI: bun src/cli.ts shared …', () => {
  const cli = async (s: ReturnType<typeof setup>, ...argv: string[]) => {
    const outs: any[] = [];
    let err = '';
    const code = await runSharedCli(argv, s.deps, (o) => outs.push(o), (e) => (err += e), { USER: 'op' } as any);
    return { code, out: outs[0], err };
  };

  test('create (awaits provisioning) with an owner, add, change role, list, remove, delete', async () => {
    const s = setup();
    let r = await cli(s, 'create', 'eng', '--owner', 'Alice@Example.com', '--policy', 'explicit');
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, name: 'eng', state: 'running', orgHost: true, members: [{ email: 'alice@example.com', role: 'owner', addedBy: 'cli:op' }] });
    r = await cli(s, 'add-member', 'eng', 'bob@example.com', '--role=viewer');
    expect(r.out.member.role).toBe('viewer');
    expect(r.out.roster.pushed).toBe(true);
    r = await cli(s, 'add-member', 'eng', 'bob@example.com', '--role', 'member', '--by', 'boss@example.com');
    expect(s.store.getMember(s.store.findShared('eng')!.ns, 'bob@example.com')!.role).toBe('member');
    r = await cli(s, 'list');
    expect(r.out.map((w: any) => w.name)).toEqual(['eng']);
    r = await cli(s, 'remove-member', 'eng', 'bob@example.com');
    expect(r.code).toBe(0);
    r = await cli(s, 'remove-member', 'eng', 'bob@example.com');
    expect(r.code).toBe(4);
    r = await cli(s, 'delete', 'eng');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--yes/);
    r = await cli(s, 'delete', 'eng', '--yes');
    expect(r.code).toBe(0);
    expect(s.store.findShared('eng')!.state).toBe('deleted');
  });

  test('--no-org-host, set-policy, bad role, usage', async () => {
    const s = setup();
    expect((await cli(s, 'create', 'eng', '--no-org-host')).out.orgHost).toBe(false);
    expect((await cli(s, 'set-policy', 'eng', 'org', '--default-role', 'viewer')).code).toBe(0);
    expect(s.store.findShared('eng')).toMatchObject({ member_policy: 'org', default_role: 'viewer' });
    expect((await cli(s, 'add-member', 'eng', 'a@example.com', '--role', 'root')).code).toBe(1);
    expect((await cli(s, 'frobnicate')).code).toBe(2);
  });

  test('the real entry point runs against a DB file (no cluster needed for list)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-shared-cli-'));
    const db = path.join(dir, 'cp.db');
    const store = createStore(openDb(db));
    store.createTenant(sharedSubject('eng'), '', { desiredDigest: 'x' });
    store.markShared(sharedSubject('eng'), { name: 'eng', policy: 'explicit', defaultRole: 'member', orgHost: true });
    store.upsertMember(store.findShared('eng')!.ns, 'bob@example.com', 'viewer', 'x');
    const p = Bun.spawnSync(['bun', 'src/cli.ts', 'shared', 'list', 'eng'], {
      cwd: path.join(import.meta.dir, '..'),
      env: { ...process.env, CP_DB_PATH: db, CP_RECONCILE_SEC: '0' },
    });
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString())).toMatchObject({ name: 'eng', orgHost: true, members: [{ email: 'bob@example.com', role: 'viewer' }] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('provisioner: chart flags and the roster transport', () => {
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => { spy?.mockRestore(); spy = null; });
  const capture = () => {
    const seen: string[][] = [];
    spy = spyOn(Bun, 'spawn').mockImplementation(((cmd: string[]) => {
      seen.push(cmd);
      return { stdout: new Response('').body, stderr: new Response('').body, exited: Promise.resolve(0), kill() {} } as any;
    }) as any);
    return seen;
  };
  const tenant = (over: Partial<Tenant>): Tenant => ({
    subject: 's', email: '', ns: 'u-abcdef0123', release: 'u-abcdef0123', desired_digest: 'sha256:x', running_digest: '', ring: 'stable',
    state: 'running', created_at: '', last_seen_at: '', handoff_secret: 'h'.repeat(20), ...over,
  });

  test('a shared org-host tenant renders sharedWorkspace + orgHost; a personal one neither', async () => {
    const seen = capture();
    const cfg = cfgOf({ CP_INGRESS_NAMESPACES: 'edge' });
    await provisioner.provisionTenant(cfg, tenant({ kind: 'shared', org_host: 1 }));
    await provisioner.provisionTenant(cfg, tenant({ kind: 'shared', org_host: 0 }));
    await provisioner.provisionTenant(cfg, tenant({ kind: 'personal', org_host: 1 }));
    await provisioner.provisionTenant(cfg, tenant({}));
    const flags = seen.map((c) => c.filter((a, i) => c[i - 1] === '--set' && /^(sharedWorkspace|orgHost)=/.test(a)));
    expect(flags).toEqual([['sharedWorkspace=true', 'orgHost=true'], ['sharedWorkspace=true'], [], []]);
    // the rest of the install is the same command for every kind (no forked provisioning)
    const strip = (c: string[]) => c.filter((a, i) => !/^(sharedWorkspace|orgHost)=/.test(a) && !/^(sharedWorkspace|orgHost)=/.test(c[i + 1] || ''));
    expect(strip(seen[0])).toEqual(strip(seen[3]));
    expect(sharedHelmArgs({ kind: 'shared', org_host: 1 })).toEqual(['--set', 'sharedWorkspace=true', '--set', 'orgHost=true']);
  });

  test('pushRoster posts the token to the tenant over loopback inside its own pod', async () => {
    const seen = capture();
    const cfg = cfgOf();
    await provisioner.pushRoster(cfg, tenant({ kind: 'shared' }), 'tok.sig');
    const c = seen[0];
    expect(c.slice(0, 6)).toEqual(['kubectl', '-n', 'u-abcdef0123', 'exec', 'arigami-abcdef0123-0', '--']);
    expect(c).toContain('http://127.0.0.1:3099/__api/auth/roster');
    expect(c[c.indexOf('--data') + 1]).toBe('{"t":"tok.sig"}');
  });
});
