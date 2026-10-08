// Shared org workspace, end to end against an ISOLATED host started the way the tenant chart starts one
// (pairing auth + ARIGAMI_HANDOFF_SECRET + ARIGAMI_SHARED_WORKSPACE=1). Tokens come from the CONTROL PLANE's
// minting code, so this also pins the role/roster wire format between the two. What it proves:
//   - every member signs in as themselves, with their own role, on a short session; a role-less token is refused
//   - a viewer reads but cannot act (no POST, no desktop socket), and keeps the read-only event stream
//   - a page from another origin cannot use a member's cookie to write or open a socket
//   - a roster push without someone kills their cookie and their open websocket at once, and their next handoff
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as cp from '../control-plane/src/handoff.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'shared-host-test-secret-32-chars!';

let host: ChildProcess;
let dir: string;
let base: string;
let port: number;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 30000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error('condition not met in time');
}

const raw = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + p, { redirect: 'manual', ...init });
async function signIn(email: string, role?: 'admin' | 'user' | 'viewer'): Promise<{ status: number; cookie: string; maxAge: number }> {
  const r = await raw(`/__api/auth/handoff?t=${encodeURIComponent(cp.mint(SECRET, email, cp.DEFAULT_TTL_MS, role))}`);
  const sc = r.headers.get('set-cookie') || '';
  return { status: r.status, cookie: sc.split(';')[0], maxAge: Number(/Max-Age=(\d+)/.exec(sc)?.[1] || 0) };
}
let gen = 0;
const pushRoster = (members: Record<string, 'admin' | 'user' | 'viewer'>, g = ++gen) =>
  raw('/__api/auth/roster', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t: cp.mintRoster(SECRET, { gen: g, policy: 'explicit', defaultRole: null, members }) }),
  });

/** First status line of a websocket upgrade, raw (so a refusal is visible as a status, not an error event). */
function upgradeStatus(p: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const h = { host: `127.0.0.1:${port}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers };
      s.write(`GET ${p} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    });
    s.once('data', (d) => {
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(String(d))?.[1] || 0));
      s.destroy();
    });
    s.once('error', reject);
    setTimeout(() => reject(new Error('no upgrade answer')), 5000);
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-shared-host-'));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_PUBLIC_URL: base,
      ARIGAMI_AUTH: 'pairing',
      ARIGAMI_HANDOFF_SECRET: SECRET,
      ARIGAMI_SHARED_WORKSPACE: '1',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  host.stderr!.on('data', (d) => (err += d));
  await until(async () => {
    try {
      return (await fetch(base + '/__health', { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }).catch(() => {
    throw new Error('host did not start: ' + err.slice(-2000));
  });
}, 40000);

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a token that names no role is refused on a shared workspace — no admin by omission', async () => {
  const r = await signIn('alice@example.com');
  expect(r.status).toBe(403);
  expect(r.cookie).toBe('');
});

test('each member signs in as themselves with their own role, on a short session', async () => {
  const a = await signIn('alice@example.com', 'admin');
  const b = await signIn('bob@example.com', 'user');
  expect(a.status).toBe(302);
  expect(b.status).toBe(302);
  expect(b.maxAge).toBeGreaterThan(0);
  expect(b.maxAge).toBeLessThanOrEqual(12 * 3600);
  const me = await (await raw('/__api/auth/me', { headers: { cookie: b.cookie } })).json();
  expect(me.user).toMatchObject({ email: 'bob@example.com', role: 'user' });
  const users = (await (await raw('/__api/auth/users', { headers: { cookie: a.cookie } })).json()).users;
  expect(users.map((u: any) => [u.email, u.role]).sort()).toEqual([['alice@example.com', 'admin'], ['bob@example.com', 'user']]);
});

test('a viewer reads, but cannot act or touch the desktop', async () => {
  const v = await signIn('vera@example.com', 'viewer');
  expect((await raw('/__api/sessions', { headers: { cookie: v.cookie } })).status).toBe(200);
  const post = await raw('/__api/sessions', { method: 'POST', headers: { cookie: v.cookie, 'content-type': 'application/json' }, body: '{}' });
  expect(post.status).toBe(403);
  expect((await post.json()).error).toMatch(/viewers/);
  expect((await raw('/__api/auth/tokens', { method: 'POST', headers: { cookie: v.cookie }, body: '{}' })).status).toBe(403);
  expect(await upgradeStatus('/__vnc', { cookie: v.cookie })).toBe(403);
  expect(await upgradeStatus('/__ws', { cookie: v.cookie })).toBe(101);
});

test('another origin cannot write or open a socket with a member’s cookie', async () => {
  const m = await signIn('mo@example.com', 'admin');
  const evil = 'https://u-bbbbbbbbbb.lab.example.com';
  const r = await raw('/__api/auth/tokens', { method: 'POST', headers: { cookie: m.cookie, origin: evil, 'content-type': 'text/plain' }, body: '{"label":"x"}' });
  expect(r.status).toBe(403);
  expect(await upgradeStatus('/__ws', { cookie: m.cookie, origin: evil })).toBe(403);
  // the same requests from the workspace's own origin go through
  expect(await upgradeStatus('/__ws', { cookie: m.cookie, origin: base })).toBe(101);
  const ok = await raw('/__api/auth/tokens', { method: 'POST', headers: { cookie: m.cookie, origin: base, 'content-type': 'application/json' }, body: '{"label":"x"}' });
  expect(ok.status).toBe(201);
});

test('removal: the roster push kills the cookie, the open socket and the next sign-in', async () => {
  const keep = await signIn('keep@example.com', 'admin');
  const gone = await signIn('gone@example.com', 'user');
  expect((await raw('/__api/sessions', { headers: { cookie: gone.cookie } })).status).toBe(200);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/__ws`, { headers: { cookie: gone.cookie } } as any);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws did not open')); });
  const closed = new Promise<boolean>((res) => { ws.onclose = () => res(true); setTimeout(() => res(false), 5000); });

  const r = await pushRoster({ 'keep@example.com': 'admin', 'alice@example.com': 'admin', 'bob@example.com': 'user', 'vera@example.com': 'viewer', 'mo@example.com': 'admin' });
  expect(r.status).toBe(200);
  expect((await r.json()).revoked).toContain('gone@example.com');

  expect(await closed).toBe(true);
  expect((await raw('/__api/sessions', { headers: { cookie: gone.cookie } })).status).toBe(401);
  expect((await raw('/__api/sessions', { headers: { cookie: keep.cookie } })).status).toBe(200);
  expect((await signIn('gone@example.com', 'user')).status).toBe(403);
});

test('a roster changes roles in place: a downgraded member is a viewer on their next request', async () => {
  const b = await signIn('bob@example.com', 'user');
  const r = await pushRoster({ 'keep@example.com': 'admin', 'bob@example.com': 'viewer' });
  expect(r.status).toBe(200);
  const post = await raw('/__api/sessions', { method: 'POST', headers: { cookie: b.cookie, 'content-type': 'application/json' }, body: '{}' });
  expect(post.status).toBe(403);
});

test('roster tokens: replay, stale generation, wrong secret and a handoff token in its place are all refused', async () => {
  const tok = cp.mintRoster(SECRET, { gen: ++gen, policy: 'explicit', defaultRole: null, members: { 'keep@example.com': 'admin' } });
  const send = (t: string) => raw('/__api/auth/roster', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t }) });
  expect((await send(tok)).status).toBe(200);
  expect((await send(tok)).status).toBe(403);
  expect((await pushRoster({ 'mallory@example.com': 'admin' }, 1)).status).toBe(409);
  expect((await send(cp.mintRoster('another-secret-another-secret!!', { gen: 999, policy: 'explicit', defaultRole: null, members: {} }))).status).toBe(403);
  expect((await send(cp.mint(SECRET, 'keep@example.com', cp.DEFAULT_TTL_MS, 'admin'))).status).toBe(403);
  // and a roster token is not a sign-in
  const asHandoff = await raw(`/__api/auth/handoff?t=${encodeURIComponent(cp.mintRoster(SECRET, { gen: 1, policy: 'explicit', defaultRole: null, members: {} }))}`);
  expect(asHandoff.status).toBe(403);
  expect(asHandoff.headers.get('set-cookie')).toBeNull();
});
