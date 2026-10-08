// Shared org workspaces, tenant side (server/org-access.ts) — in-process against createAuth() on a tmp dir:
// the viewer policy, the cross-origin guard, roster application (revocation, role moves, stale rosters) and
// who a handoff signs in. The live-host version of the same story is test/shared-workspace-host.test.ts.
import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createAuth } from '../server/auth.ts';
import * as oa from '../server/org-access.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-org-access-'));
const mk = (dir = tmp()) => ({ dir, auth: createAuth({ dir, auth: { mode: 'pairing', cookieDays: 30 }, log: () => {} }) });
const ORCH = { ARIGAMI_HANDOFF_SECRET: 'x'.repeat(32) } as NodeJS.ProcessEnv;
const req = (method: string, headers: Record<string, string> = {}) => ({ method, headers }) as any;
const cookieUser = (role: string) => ({ kind: 'user', via: 'cookie', user: { role } });

describe('viewer policy', () => {
  test('reads pass, every write and every MCP call is refused, logout is allowed', () => {
    expect(oa.viewerMayRequest('GET', '/__api/sessions')).toBe(true);
    expect(oa.viewerMayRequest('HEAD', '/__host/')).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(oa.viewerMayRequest(m, '/__api/sessions')).toBe(false);
      expect(oa.viewerMayRequest(m, '/__api/sessions/abc/message')).toBe(false);
    }
    expect(oa.viewerMayRequest('GET', '/__mcp/host')).toBe(false);
    expect(oa.viewerMayRequest('POST', '/__api/auth/logout')).toBe(true);
    expect(oa.viewerMayRequest('POST', '/__api/auth/pair')).toBe(false);
  });

  test('only the read-only event stream may be upgraded to', () => {
    expect(oa.viewerMayUpgrade('/__ws')).toBe(true);
    for (const p of ['/__vnc', '/__screencast', '/some/dev-server/hmr']) expect(oa.viewerMayUpgrade(p)).toBe(false);
  });

  test('refusal() applies it to cookie viewers only; members, admins and bearer callers are untouched', () => {
    expect(oa.refusal(req('POST'), cookieUser('viewer') as any, '/__api/sessions')).toMatch(/viewers/);
    expect(oa.refusal(req('GET'), cookieUser('viewer') as any, '/__vnc', { upgrade: true })).toMatch(/viewers/);
    expect(oa.refusal(req('GET'), cookieUser('viewer') as any, '/__ws', { upgrade: true })).toBeNull();
    expect(oa.refusal(req('POST'), cookieUser('user') as any, '/__api/sessions')).toBeNull();
    // an API token kept from before a downgrade does not outrank the viewer role
    expect(oa.refusal(req('POST'), { kind: 'user', via: 'api-token', user: { role: 'viewer' } } as any, '/__api/sessions')).toMatch(/viewers/);
    expect(oa.refusal(req('POST'), { kind: 'session', user: null } as any, '/__api/sessions')).toBeNull();
    expect(oa.refusal(req('POST'), null, '/__api/sessions')).toBeNull();
  });
});

describe('cross-origin guard (orchestrated hosts)', () => {
  const pub = 'https://u-aaaaaaaaaa.lab.example.com';
  test('a sibling tenant page cannot POST or open a websocket with the cookie', () => {
    const evil = { origin: 'https://u-bbbbbbbbbb.lab.example.com' };
    expect(oa.crossOriginWrite(req('POST', evil), { publicUrl: pub, env: ORCH })).toBe(true);
    expect(oa.crossOriginWrite(req('GET', evil), { publicUrl: pub, env: ORCH, upgrade: true })).toBe(true);
    expect(oa.refusal(req('POST', evil), cookieUser('admin') as any, '/__api/sessions', { publicUrl: pub, env: ORCH })).toMatch(/cross-origin/);
  });
  test('same origin, no Origin, and plain cross-origin GETs pass', () => {
    expect(oa.crossOriginWrite(req('POST', { origin: pub }), { publicUrl: pub, env: ORCH })).toBe(false);
    expect(oa.crossOriginWrite(req('POST'), { publicUrl: pub, env: ORCH })).toBe(false);
    expect(oa.crossOriginWrite(req('GET', { origin: 'https://elsewhere.example.com' }), { publicUrl: pub, env: ORCH })).toBe(false);
  });
  test('without a public URL the Host header is the reference', () => {
    expect(oa.crossOriginWrite(req('POST', { origin: 'https://a.example.com', host: 'a.example.com' }), { env: ORCH })).toBe(false);
    expect(oa.crossOriginWrite(req('POST', { origin: 'https://b.example.com', host: 'a.example.com' }), { env: ORCH })).toBe(true);
    expect(oa.crossOriginWrite(req('POST', { origin: 'null', host: 'a.example.com' }), { env: ORCH })).toBe(true);
  });
  test('a standalone host (no handoff secret) is unchanged', () => {
    expect(oa.crossOriginWrite(req('POST', { origin: 'https://b.example.com' }), { publicUrl: pub, env: {} as any })).toBe(false);
  });
});

describe('roster', () => {
  const roster = (gen: number, members: Record<string, string>, policy: 'explicit' | 'org' = 'explicit', defaultRole: string | null = null) =>
    oa.parseRoster({ gen, policy, defaultRole, members })!;

  test('parseRoster rejects anything malformed', () => {
    expect(oa.parseRoster(null)).toBeNull();
    expect(oa.parseRoster({ gen: 1, policy: 'everyone', members: {} })).toBeNull();
    expect(oa.parseRoster({ gen: 1, policy: 'explicit', members: { 'a@x.y': 'root' } })).toBeNull();
    expect(oa.parseRoster({ gen: 1, policy: 'org', members: {} })).toBeNull(); // org needs a default role
    expect(oa.parseRoster({ policy: 'explicit', members: {} })).toBeNull();
    expect(oa.parseRoster({ gen: 1, policy: 'explicit', members: { 'A@X.Y': 'user' } })!.members).toEqual({ 'a@x.y': 'user' });
  });

  test('a removed member loses every session and API token; the row (and its settings) stays, parked as viewer', () => {
    const { dir, auth } = mk();
    const bob = auth.createUser('bob@example.com', 'user');
    const alice = auth.createUser('alice@example.com', 'admin');
    const s1 = auth.createWebSession(bob.id);
    const s2 = auth.createWebSession(bob.id);
    const sa = auth.createWebSession(alice.id);
    auth.createApiToken(bob.id, 'cli');
    const r = oa.applyRoster(roster(1, { 'alice@example.com': 'admin' }), auth, dir);
    expect(r).toMatchObject({ ok: true, gen: 1, revoked: ['bob@example.com'], changed: [] });
    const cookie = (t: string) => ({ headers: { cookie: `arigami_sid=${t}` } }) as any;
    expect(auth.sessionFromCookie(cookie(s1.token))).toBeNull();
    expect(auth.sessionFromCookie(cookie(s2.token))).toBeNull();
    expect(auth.sessionFromCookie(cookie(sa.token))).not.toBeNull();
    expect(auth.listApiTokens().filter((t: any) => t.userId === bob.id)).toEqual([]);
    expect(auth.getUser(bob.id)!.role).toBe('viewer');
    // persisted, not just in memory: a restart does not bring the sessions back
    const again = createAuth({ dir, auth: { mode: 'pairing', cookieDays: 30 }, log: () => {} });
    expect(again.sessionFromCookie(cookie(s1.token))).toBeNull();
  });

  test('role moves follow the roster, and the user’s open sockets are closed on any change', () => {
    const { dir, auth } = mk();
    const bob = auth.createUser('bob@example.com', 'admin');
    const sock = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; this.emit('close'); } });
    oa.trackSocket(bob.id, sock as any);
    const r = oa.applyRoster(roster(1, { 'bob@example.com': 'viewer' }), auth, dir);
    expect(r).toMatchObject({ ok: true, changed: [{ email: 'bob@example.com', from: 'admin', to: 'viewer' }] });
    expect(auth.getUser(bob.id)!.role).toBe('viewer');
    expect(sock.destroyed).toBe(true);
    expect(oa.closeSocketsOf(bob.id)).toBe(0); // forgotten once closed
  });

  test('revocation closes the revoked user’s sockets and nobody else’s', () => {
    const { dir, auth } = mk();
    const bob = auth.createUser('bob@example.com', 'user');
    const alice = auth.createUser('alice@example.com', 'user');
    const mkSock = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; this.emit('close'); } });
    const b = mkSock(), a = mkSock();
    oa.trackSocket(bob.id, b as any);
    oa.trackSocket(alice.id, a as any);
    oa.applyRoster(roster(1, { 'alice@example.com': 'user' }), auth, dir);
    expect(b.destroyed).toBe(true);
    expect(a.destroyed).toBe(false);
  });

  test('org policy keeps unlisted users at the default role instead of revoking them', () => {
    const { dir, auth } = mk();
    const bob = auth.createUser('bob@example.com', 'user');
    auth.createWebSession(bob.id);
    const r = oa.applyRoster(roster(1, {}, 'org', 'viewer'), auth, dir);
    expect(r).toMatchObject({ ok: true, revoked: [], changed: [{ email: 'bob@example.com', to: 'viewer' }] });
  });

  test('a roster older than the applied one is refused; the same generation re-applies (a retried push)', () => {
    const { dir, auth } = mk();
    auth.createUser('bob@example.com', 'user');
    expect(oa.applyRoster(roster(5, {}), auth, dir).ok).toBe(true);
    const stale = oa.applyRoster(roster(4, { 'bob@example.com': 'admin' }), auth, dir);
    expect(stale).toMatchObject({ ok: false, status: 409 });
    expect(auth.findByEmail('bob@example.com')!.role).toBe('viewer');
    expect(oa.applyRoster(roster(5, {}), auth, dir).ok).toBe(true);
  });
});

describe('handoffUser', () => {
  const SHARED = { ARIGAMI_SHARED_WORKSPACE: '1' } as NodeJS.ProcessEnv;

  test('personal host, no role: the K8S-3 behaviour (admin of your own instance, long session)', () => {
    const { dir, auth } = mk();
    const r = oa.handoffUser({ email: 'me@example.com' }, auth, {} as any, dir);
    expect(r.ok && r.user.role).toBe('admin');
    expect(r.ok && r.ttlMs).toBeUndefined();
  });

  test('shared host refuses a token that names no role (never an admin by omission)', () => {
    const { dir, auth } = mk();
    const r = oa.handoffUser({ email: 'me@example.com' }, auth, SHARED, dir);
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(auth.findByEmail('me@example.com')).toBeUndefined();
  });

  test('each member signs in as themselves with the role in the token, on a short session', () => {
    const { dir, auth } = mk();
    const a = oa.handoffUser({ email: 'a@example.com', role: 'viewer' }, auth, SHARED, dir);
    const b = oa.handoffUser({ email: 'b@example.com', role: 'user' }, auth, SHARED, dir);
    expect(a.ok && [a.user.email, a.user.role]).toEqual(['a@example.com', 'viewer']);
    expect(b.ok && [b.user.email, b.user.role]).toEqual(['b@example.com', 'user']);
    expect(a.ok && a.ttlMs).toBe(12 * 3_600_000);
    expect(oa.sharedSessionTtlMs({ ARIGAMI_SHARED_SESSION_HOURS: '2' } as any)).toBe(2 * 3_600_000);
    // and the role is re-applied at every sign-in
    const again = oa.handoffUser({ email: 'b@example.com', role: 'viewer' }, auth, SHARED, dir);
    expect(again.ok && again.user.role).toBe('viewer');
    expect(auth.listUsers().length).toBe(2);
  });

  test('once a roster is applied, a token for someone not on it opens nothing', () => {
    const { dir, auth } = mk();
    oa.applyRoster(oa.parseRoster({ gen: 1, policy: 'explicit', defaultRole: null, members: { 'a@example.com': 'user' } })!, auth, dir);
    expect(oa.handoffUser({ email: 'a@example.com', role: 'user' }, auth, SHARED, dir).ok).toBe(true);
    expect(oa.handoffUser({ email: 'gone@example.com', role: 'admin' }, auth, SHARED, dir)).toMatchObject({ ok: false, status: 403 });
  });

  test('createWebSession honours a shorter ttl and never exceeds cookieDays', () => {
    const { auth } = mk();
    const u = auth.createUser('x@example.com', 'user');
    const short = auth.createWebSession(u.id, '', 3_600_000);
    expect(short.exp - short.createdAt).toBeLessThanOrEqual(3_600_000 + 5);
    const capped = auth.createWebSession(u.id, '', 365 * 86_400_000);
    expect(capped.exp - capped.createdAt).toBeLessThanOrEqual(30 * 86_400_000 + 5);
  });
});
