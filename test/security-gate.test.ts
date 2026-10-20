// Security regression tests for two critical findings (reported against 0.16.0):
//  1. auth bypass by path normalisation — the gate judged the RAW path ("/__api/auth/../sessions" is under the public
//     /__api/auth/) while the router judged the NORMALISED one ("/__api/sessions"): the whole API with no credential.
//  2. anonymous SSRF through the public "/" — a pinned proxy target (?__target= / X-Poc-Target) made the host fetch
//     any URL for an unauthenticated caller.
// Plus: the legacy unauthenticated SMS inbound is no longer public, and responses carry baseline hardening headers.
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathIsAmbiguous, requestPath } from '../server/auth.ts';
import { tmpDir } from './_tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('request path reading', () => {
  test('dot segments, backslashes, encoded slashes and control characters are ambiguous', () => {
    for (const p of [
      '/__api/auth/../sessions',
      '/__api/auth/%2e%2e/sessions',
      '/__api/auth/%2E%2E/sessions',
      '/__api/auth/.%2e/sessions',
      '/__api/auth/./../sessions',
      '/__api/auth/..\\sessions',
      '/__api/auth%5c..%5csessions',
      '/__api/auth%2f..%2fsessions',
      '/__api/auth/%00/../sessions',
      '/__api/auth/%zz',
      '/#',
      '/__health#',
      '/__ws#x',
      'http://evil.example/__api/sessions',
      '__api/sessions',
    ]) {
      expect(pathIsAmbiguous(p)).toBe(true);
    }
  });
  test('ordinary paths (percent-encoded names, dots inside names, double slashes) are not', () => {
    for (const p of ['/', '/__api/sessions', '/__api/auth/login', '/__artifacts/abc/index.html', '/a%20b/c.txt', '/file.name.with.dots', '/..hidden/x', '/x/.well-known/y', '//x', '/__ext/ext/~t/abc/ui/index.html']) {
      expect(pathIsAmbiguous(p)).toBe(false);
    }
  });
  test('requestPath drops the query and fragment', () => {
    expect(requestPath('/a/b?x=1')).toEqual({ path: '/a/b', ambiguous: false });
    expect(requestPath('/a/b#h').ambiguous).toBe(true); // a fragment never reaches a server — a client that sends one is probing
    expect(requestPath(undefined)).toEqual({ path: '/', ambiguous: false });
    expect(requestPath('/__api/auth/../x?y=1').ambiguous).toBe(true);
  });
});

let host: ChildProcess;
let dir: string;
let port: number;
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
// fetch() normalises the URL before sending; http.request sends the path exactly as given.
function raw(pathStr: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode || 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  dir = tmpDir('arigami-sec-');
  port = await freePort();
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: path.join(dir, 'home'),
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      if ((await raw('/__health')).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('host did not start');
}, 30000);

afterAll(() => {
  try {
    host.kill();
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('auth gate (real host, authentication ON)', () => {
  test('baseline: the API needs a credential', async () => {
    expect((await raw('/__api/sessions')).status).toBe(401);
  });
  test('path tricks never reach the router: 400 for every form of /__api/auth/../sessions', async () => {
    for (const p of ['/__api/auth/../sessions', '/__api/auth/%2e%2e/sessions', '/__api/auth/%2E%2E/sessions', '/__api/auth/..%5csessions', '/__api/auth/./../sessions', '/__api/auth%2f..%2fsessions']) {
      const r = await raw(p);
      expect(r.status).toBe(400);
      expect(r.body).not.toContain('"id"');
    }
  });
  test('the public auth routes still answer', async () => {
    expect([200, 400, 401, 404, 405]).toContain((await raw('/__api/auth/status')).status); // reachable, not a 5xx
    expect((await raw('/__health')).status).toBe(200);
    expect((await raw('/')).status).toBe(302);
  });
  test('anonymous SSRF through "/" is refused (query target and header target)', async () => {
    const a = await raw('/?__target=' + encodeURIComponent(`http://127.0.0.1:${port}/__health`));
    expect(a.status).toBe(401);
    expect(a.body).not.toContain('busySessions');
    const b = await raw('/', { 'x-poc-target': `http://127.0.0.1:${port}/__health` });
    expect(b.status).toBe(401);
    expect(b.body).not.toContain('busySessions');
  });
  test('a fragment in the request target cannot hide the path from the gate (reviewer finding)', async () => {
    const a = await raw('/#', { 'x-poc-target': `http://127.0.0.1:${port}/__health` });
    expect(a.status).toBe(400);
    expect(a.body).not.toContain('busySessions');
    expect((await raw('/__health#')).status).toBe(400);
    const c = await raw('/', { cookie: `poc_target=${encodeURIComponent(`http://127.0.0.1:${port}`)}` });
    expect([401, 302]).toContain(c.status);
    expect(c.body).not.toContain('busySessions');
  });
  test('no anonymous request reaches the dev-server proxy on any other path either', async () => {
    for (const p of ['/some/page', '/app.js', '/__proxy-probe']) {
      const r = await raw(p, { 'x-poc-target': `http://127.0.0.1:${port}/__health` });
      expect([401, 302]).toContain(r.status);
      expect(r.body).not.toContain('busySessions');
    }
  });
  test('the legacy SMS inbound is no longer public', async () => {
    expect((await raw('/__api/sms/inbound?from=x&text=y')).status).toBe(401);
  });
  test('hardening headers are on responses', async () => {
    const r = await raw('/__health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('same-origin');
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});
