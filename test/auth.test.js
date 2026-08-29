// C1 — server/auth.ts: pairing (burn + lockout), the HTTP gate (401 matrix for
// REST/WS/pages, public allowlist), cookie sessions, internal bearer tokens
// (session-scoped + host), API tokens, OIDC email policy, and the fail-closed
// bind/auth sanity in config.ts. Everything runs in-process against a tmp
// ARIGAMI_DIR via createAuth(); the live-server boot cases run in a child.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAuth, emailAllowed, generatePairingCode, parseCookies, COOKIE } from '../server/auth.ts';
import { validateAuthBind, isLoopbackBind } from '../server/lib/config.ts';
import { rewriteSetCookie } from '../server/proxy.ts';
import { runInChild } from './_child.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-auth-'));
const mk = (over = {}) =>
  createAuth({ dir: tmp(), auth: { mode: 'pairing', cookieDays: 30 }, log: () => {}, ...over });

// ---- pure helpers -------------------------------------------------------------
describe('helpers', () => {
  test('pairing code is XXXX-XXXX from an unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) expect(generatePairingCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  });
  test('parseCookies', () => {
    expect(parseCookies('a=1; arigami_sid=abc%3D; b = 2')).toEqual({ a: '1', arigami_sid: 'abc=', b: '2' });
    expect(parseCookies(undefined)).toEqual({});
  });
  test('emailAllowed: exact email, domain, case-insensitive, nothing by default', () => {
    const o = { allowedEmails: ['Me@Example.com'], allowedDomains: ['@corp.example'] };
    expect(emailAllowed('me@example.com', o)).toBe(true);
    expect(emailAllowed('x@corp.example', o)).toBe(true);
    expect(emailAllowed('x@other.example', o)).toBe(false);
    expect(emailAllowed('me@example.com', undefined)).toBe(false);
    expect(emailAllowed('', o)).toBe(false);
  });
  test('proxy never lets an upstream overwrite the auth cookies', () => {
    expect(rewriteSetCookie(['arigami_sid=evil; Path=/', 'sess=ok; Secure', 'ARIGAMI_OIDC=x'])).toEqual(['sess=ok']);
  });
});

// ---- fail-closed bind × auth --------------------------------------------------
describe('validateAuthBind (SPEC §7.9)', () => {
  test('loopback + off is fine; 0.0.0.0 + off is refused; 0.0.0.0 + pairing is fine', () => {
    expect(validateAuthBind({ bind: '127.0.0.1', auth: { mode: 'off', cookieDays: 30 } })).toBeNull();
    expect(validateAuthBind({ bind: '0.0.0.0', auth: { mode: 'off', cookieDays: 30 } })).toMatch(/loopback/);
    expect(validateAuthBind({ bind: '0.0.0.0', auth: { mode: 'pairing', cookieDays: 30 } })).toBeNull();
    expect(validateAuthBind({ bind: '::', auth: { mode: 'off', cookieDays: 30 } })).toMatch(/loopback/);
  });
  test('oidc mode needs issuer + clientId', () => {
    expect(validateAuthBind({ bind: '127.0.0.1', auth: { mode: 'oidc', cookieDays: 30 } })).toMatch(/issuer/);
    expect(validateAuthBind({ bind: '127.0.0.1', auth: { mode: 'oidc', cookieDays: 30, oidc: { issuer: 'https://x', clientId: 'c', allowedEmails: [], allowedDomains: [], autoCreate: true } } })).toBeNull();
  });
  test('isLoopbackBind', () => {
    for (const b of ['127.0.0.1', '127.0.0.2', 'localhost', '::1']) expect(isLoopbackBind(b)).toBe(true);
    for (const b of ['0.0.0.0', '::', '10.0.0.1']) expect(isLoopbackBind(b)).toBe(false);
  });
  test('config defaults: bind 127.0.0.1, auth pairing, hostBase dials 127.0.0.1; env overrides', () => {
    const dir = tmp();
    const r = runInChild(
      "const {cfg}=await import('./server/lib/config.ts');emit({bind:cfg.bind,mode:cfg.auth.mode,hostBase:cfg.hostBase,pub:cfg.publicUrl});",
      { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_BIND: '', ARIGAMI_AUTH: '', ARIGAMI_PUBLIC_URL: '' }
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.out[0]).toEqual({ bind: '127.0.0.1', mode: 'pairing', hostBase: 'http://127.0.0.1:4099', pub: '' });
    const r2 = runInChild(
      "const {cfg}=await import('./server/lib/config.ts');emit({bind:cfg.bind,mode:cfg.auth.mode,pub:cfg.publicUrl});",
      { ARIGAMI_DIR: dir, ARIGAMI_PORT: '', ARIGAMI_BIND: '0.0.0.0', ARIGAMI_AUTH: 'off', ARIGAMI_PUBLIC_URL: 'https://example.test/' }
    );
    expect(r2.out[0]).toEqual({ bind: '0.0.0.0', mode: 'off', pub: 'https://example.test' });
  });
});

// ---- pairing ------------------------------------------------------------------
describe('pairing', () => {
  test('boot with no users issues a code (file 0600 + log); correct code → admin, burned; second use fails', () => {
    const logs = [];
    const a = mk({ log: (m) => logs.push(m) });
    expect(a.hasAdmin()).toBe(false);
    const pretty = a.announcePairing();
    expect(pretty).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(logs.join('\n')).toContain(pretty);
    expect(fs.existsSync(a.pairingFile)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(a.pairingFile).mode & 0o777).toBe(0o600);

    const r = a.pair(pretty.toLowerCase(), 'me@example.com'); // case/dash-insensitive
    expect(r.ok).toBe(true);
    expect(r.user.role).toBe('admin');
    expect(r.user.email).toBe('me@example.com');
    expect(a.hasAdmin()).toBe(true);
    expect(fs.existsSync(a.pairingFile)).toBe(false); // burned
    expect(JSON.parse(fs.readFileSync(a.files.usersFile, 'utf8')).users).toHaveLength(1);

    const again = a.pair(pretty);
    expect(again.ok).toBe(false);
    expect(again.status).toBe(401);
    // announce is a no-op once an admin exists
    expect(a.announcePairing()).toBeNull();
  });

  test('5 wrong codes → 429 lock for 60s, even for the right code', () => {
    const a = mk();
    const code = a.issuePairingCode();
    for (let i = 0; i < 4; i++) expect(a.pair('AAAA-AAAA').status).toBe(401);
    const fifth = a.pair('AAAA-AAAA');
    expect(fifth.status).toBe(429);
    expect(fifth.retryAfter).toBe(60);
    const locked = a.pair(code);
    expect(locked.ok).toBe(false);
    expect(locked.status).toBe(429);
  });

  test('re-issue (bin/host pair) replaces the pending code; pairing again with users present yields the existing admin', () => {
    const a = mk();
    const c1 = a.issuePairingCode();
    const c2 = a.issuePairingCode();
    expect(a.pair(c1).status).toBe(401);
    const r = a.pair(c2, 'admin@example.com');
    expect(r.ok).toBe(true);
    const c3 = a.issuePairingCode();
    const r2 = a.pair(c3); // no email → the existing admin, no duplicate
    expect(r2.ok).toBe(true);
    expect(r2.user.id).toBe(r.user.id);
    expect(a.listUsers()).toHaveLength(1);
  });

  test('mode off: pairing is refused, principal is "off" for everyone', () => {
    const a = mk({ auth: { mode: 'off', cookieDays: 30 } });
    expect(a.pair('X').status).toBe(400);
    expect(a.announcePairing()).toBeNull();
    expect(a.principal({ headers: {} }).kind).toBe('off');
  });
});

// ---- cookie sessions + tokens (no HTTP) -----------------------------------------
describe('sessions & tokens', () => {
  test('cookie attributes: HttpOnly, SameSite=Lax, Secure only when publicUrl is https', () => {
    const a = mk();
    expect(a.cookieHeader('t', 10)).toBe(`${COOKIE}=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=10`);
    const b = mk({ publicUrl: 'https://host.example' });
    expect(b.cookieHeader('t', 10)).toContain('; Secure');
  });
  test('web sessions persist to sessions.json and survive a re-create; expired ones are dropped', () => {
    const dir = tmp();
    const a = createAuth({ dir, auth: { mode: 'pairing', cookieDays: 30 }, log() {} });
    const u = a.createUser('x@example.com', 'admin');
    const s = a.createWebSession(u.id, 'ua');
    const b = createAuth({ dir, auth: { mode: 'pairing', cookieDays: 30 }, log() {} });
    expect(b.principal({ headers: { cookie: `${COOKIE}=${s.token}` } })?.user?.id).toBe(u.id);
    // expire on disk → gone
    const f = JSON.parse(fs.readFileSync(b.files.sessionsFile, 'utf8'));
    f.sessions[0].exp = Date.now() - 1;
    fs.writeFileSync(b.files.sessionsFile, JSON.stringify(f));
    const c = createAuth({ dir, auth: { mode: 'pairing', cookieDays: 30 }, log() {} });
    expect(c.principal({ headers: { cookie: `${COOKIE}=${s.token}` } })).toBeNull();
  });
  test('logout drops the session; removing a user drops their sessions', () => {
    const a = mk();
    const u = a.createUser('x@example.com', 'admin');
    const s = a.createWebSession(u.id);
    const req = { headers: { cookie: `${COOKIE}=${s.token}` } };
    expect(a.principal(req)).not.toBeNull();
    a.logout(req);
    expect(a.principal(req)).toBeNull();
    const s2 = a.createWebSession(u.id);
    a.removeUser('x@example.com');
    expect(a.principal({ headers: { cookie: `${COOKIE}=${s2.token}` } })).toBeNull();
  });
  test('session bearer token: stable per session, honoured only while the session exists, revocable', () => {
    const live = new Set(['sess_1']);
    const a = mk({ sessionExists: (id) => live.has(id) });
    const t = a.tokenForSession('sess_1');
    expect(a.tokenForSession('sess_1')).toBe(t);
    const p = a.principal({ headers: { authorization: `Bearer ${t}` } });
    expect(p).toEqual({ kind: 'session', sessionId: 'sess_1', user: null });
    expect(a.isAdmin(p)).toBe(false);
    live.delete('sess_1');
    expect(a.principal({ headers: { authorization: `Bearer ${t}` } })).toBeNull();
    const t2 = a.tokenForSession('sess_2');
    a.revokeSessionToken('sess_2');
    live.add('sess_2');
    expect(a.principal({ headers: { authorization: `Bearer ${t2}` } })).toBeNull();
  });
  test('host token is admin-equivalent; garbage bearers are rejected', () => {
    const a = mk();
    const p = a.principal({ headers: { authorization: `Bearer ${a.hostToken}` } });
    expect(p.kind).toBe('host');
    expect(a.isAdmin(p)).toBe(true);
    expect(a.principal({ headers: { authorization: 'Bearer nope' } })).toBeNull();
    expect(a.principal({ headers: { authorization: 'Basic abc' } })).toBeNull();
  });
  test('API tokens: only the hash is stored; token authenticates as its owner; delete revokes', () => {
    const a = mk();
    const u = a.createUser('x@example.com', 'admin');
    const { token, id } = a.createApiToken(u.id, 'cli');
    expect(token).toMatch(/^arigami_pat_/);
    expect(fs.readFileSync(a.files.usersFile, 'utf8')).not.toContain(token);
    const p = a.principal({ headers: { authorization: `Bearer ${token}` } });
    expect(p.kind).toBe('user');
    expect(p.via).toBe('api-token');
    expect(a.listApiTokens()[0]).toMatchObject({ id, label: 'cli', email: 'x@example.com' });
    expect(a.listApiTokens()[0].hash).toBeUndefined();
    expect(a.deleteApiToken(id)).toBe(true);
    expect(a.principal({ headers: { authorization: `Bearer ${token}` } })).toBeNull();
  });
});

// ---- HTTP gate matrix (real server on an ephemeral port) -----------------------
describe('gate', () => {
  let a, server, base, cookie, sessTok;
  const live = new Set(['sess_a']);
  beforeAll(async () => {
    a = mk({ sessionExists: (id) => live.has(id) });
    const u = a.createUser('me@example.com', 'admin');
    cookie = `${COOKIE}=${a.createWebSession(u.id).token}`;
    sessTok = a.tokenForSession('sess_a');
    server = http.createServer((req, res) => {
      if (a.gate(req, res)) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, principal: req.auth?.kind ?? null, path: req.url }));
    });
    server.on('upgrade', (req, socket) => {
      if (a.gateUpgrade(req, socket)) return;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => server.close());

  const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });

  test('no credential: /__api → 401 JSON, /__mcp → 401, page → 302 /__host/ (html) or 401', async () => {
    const r = await get('/__api/sessions');
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe('unauthorized');
    expect((await get('/__mcp/permission')).status).toBe(401);
    const page = await get('/__ticket/x', { accept: 'text/html' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/__host/');
    expect((await get('/some-proxied-asset.js')).status).toBe(401);
    expect((await get('/__artifacts/abc/index.html', { accept: 'text/html' })).status).toBe(302);
  });
  test('public allowlist passes without a credential and carries no principal', async () => {
    for (const p of ['/__api/auth/me', '/__api/config', '/__host/', '/__host/index.js', '/', '/__health', '/__poc-sw.js', '/__api/sms/inbound?body=x', '/__api/webhooks/x']) {
      const r = await get(p);
      expect([p, r.status]).toEqual([p, 200]);
      expect((await r.json()).principal).toBeNull();
    }
  });
  test('cookie passes; bogus cookie does not', async () => {
    const r = await get('/__api/sessions', { cookie });
    expect(r.status).toBe(200);
    expect((await r.json()).principal).toBe('user');
    expect((await get('/__api/sessions', { cookie: `${COOKIE}=bogus` })).status).toBe(401);
  });
  test('internal bearer (session token) bypasses the cookie — the MCP path', async () => {
    const r = await get('/__mcp/permission', { authorization: `Bearer ${sessTok}` });
    expect(r.status).toBe(200);
    expect((await r.json()).principal).toBe('session');
    const h = await get('/__api/sessions', { authorization: `Bearer ${a.hostToken}` });
    expect((await h.json()).principal).toBe('host');
    live.delete('sess_a');
    expect((await get('/__api/sessions', { authorization: `Bearer ${sessTok}` })).status).toBe(401);
    live.add('sess_a');
  });
  test('upgrade (/__ws, /__vnc): 401 without cookie, 101 with cookie or bearer', async () => {
    const tryUp = (headers) =>
      new Promise((resolve) => {
        const req = http.request(base + '/__ws', { headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } });
        req.on('upgrade', (res) => { resolve(res.statusCode); });
        req.on('response', (res) => { resolve(res.statusCode); res.resume(); });
        req.on('error', () => resolve('error'));
        req.end();
      });
    expect(await tryUp({})).toBe(401);
    expect(await tryUp({ cookie })).toBe(101);
    // sess_a's earlier token was purged when the session briefly "died" above;
    // a live session simply gets a fresh one.
    expect(await tryUp({ authorization: `Bearer ${a.tokenForSession('sess_a')}` })).toBe(101);
  });
  test('mode off: everything passes with principal "off"', async () => {
    const off = mk({ auth: { mode: 'off', cookieDays: 30 } });
    const s = http.createServer((req, res) => {
      if (off.gate(req, res)) return;
      res.end(JSON.stringify({ principal: req.auth?.kind }));
    });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${s.address().port}/__api/sessions`);
    expect((await r.json()).principal).toBe('off');
    s.close();
  });
});

// ---- the real server: fail-closed boot + 401 + pairing end-to-end ---------------
describe('server boot', () => {
  test('ARIGAMI_BIND=0.0.0.0 with auth off refuses to start (exit 2)', () => {
    const dir = tmp();
    const r = Bun.spawnSync(['bun', 'server/index.ts'], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env, ARIGAMI_DIR: dir, ARIGAMI_PORT: '0', ARIGAMI_BIND: '0.0.0.0', ARIGAMI_AUTH: 'off' },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('loopback');
  });
});
