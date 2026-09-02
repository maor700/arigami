// K8S-3 handoff, end to end against an ISOLATED host running the REAL auth
// mode a tenant runs (`pairing`, not `off`): a control-plane-minted token must
// get a browser a session cookie with no pairing code, and everything else must
// still be locked. This is the test that would catch "the bypass bypasses too
// much".
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ho from '../server/handoff.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'handoff-host-test-secret-32-chars';

let host: ChildProcess;
let dir: string;
let base: string;

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

/** Follow nothing: we assert on the 302 + Set-Cookie itself. */
const raw = (p: string, headers: Record<string, string> = {}) =>
  fetch(base + p, { redirect: 'manual', headers });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-handoff-host-'));
  const port = await freePort();
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
      ARIGAMI_AUTH: 'pairing', // what a real tenant runs
      ARIGAMI_HANDOFF_SECRET: SECRET,
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
      // A bounded probe: an unbounded fetch against a port that accepts but
      // never answers hangs the poll loop past its own deadline.
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

test('without a cookie the API is locked (the baseline the handoff must not weaken)', async () => {
  const r = await raw('/__api/sessions');
  expect(r.status).toBe(401);
});

test('a valid handoff token 302s to the cockpit and sets a session cookie', async () => {
  const r = await raw(`/__api/auth/handoff?t=${encodeURIComponent(ho.mint(SECRET, 'alice@fake-org.test'))}`);
  expect(r.status).toBe(302);
  expect(r.headers.get('location')).toBe('/__host/');
  const setCookie = r.headers.get('set-cookie') || '';
  expect(setCookie).toMatch(/arigami_sid=/);
  expect(setCookie).toMatch(/HttpOnly/);
  // and that cookie is a real, working principal
  const cookie = setCookie.split(';')[0];
  const sessions = await raw('/__api/sessions', { cookie });
  expect(sessions.status).toBe(200);
});

test('the user row is created from the token email, as admin of their own instance', async () => {
  const r = await raw(`/__api/auth/handoff?t=${encodeURIComponent(ho.mint(SECRET, 'bob@fake-org.test'))}`);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const users = await (await fetch(base + '/__api/auth/users', { headers: { cookie } })).json();
  const bob = users.users.find((u: any) => u.email === 'bob@fake-org.test');
  expect(bob).toBeTruthy();
  expect(bob.role).toBe('admin');
});

test('signing in twice with the same email reuses the row, it does not pile up users', async () => {
  const before = await (async () => {
    const r = await raw(`/__api/auth/handoff?t=${encodeURIComponent(ho.mint(SECRET, 'carol@fake-org.test'))}`);
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    return (await (await fetch(base + '/__api/auth/users', { headers: { cookie } })).json()).users;
  })();
  const r2 = await raw(`/__api/auth/handoff?t=${encodeURIComponent(ho.mint(SECRET, 'carol@fake-org.test'))}`);
  const cookie2 = (r2.headers.get('set-cookie') || '').split(';')[0];
  const after = (await (await fetch(base + '/__api/auth/users', { headers: { cookie: cookie2 } })).json()).users;
  expect(after.length).toBe(before.length);
  expect(after.filter((u: any) => u.email === 'carol@fake-org.test').length).toBe(1);
});

test('a replayed token is refused by the live host, with no cookie', async () => {
  const tok = ho.mint(SECRET, 'dave@fake-org.test');
  const first = await raw(`/__api/auth/handoff?t=${encodeURIComponent(tok)}`);
  expect(first.status).toBe(302);
  const second = await raw(`/__api/auth/handoff?t=${encodeURIComponent(tok)}`);
  expect(second.status).toBe(403);
  expect(second.headers.get('set-cookie')).toBeNull();
  expect(await second.text()).toMatch(/already used/);
});

test('a token signed with the wrong secret gets no session', async () => {
  const r = await raw(`/__api/auth/handoff?t=${encodeURIComponent(ho.mint('a-totally-different-secret!!', 'mallory@evil.test'))}`);
  expect(r.status).toBe(403);
  expect(r.headers.get('set-cookie')).toBeNull();
});

test('garbage and a missing token are refused, not 500s', async () => {
  expect((await raw('/__api/auth/handoff')).status).toBe(400);
  expect((await raw('/__api/auth/handoff?t=nonsense')).status).toBe(400);
});
