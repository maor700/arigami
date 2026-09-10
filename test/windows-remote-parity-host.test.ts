// windows-remote-parity, against an ISOLATED host forced onto the
// native-window driver — i.e. this Linux box pretending to be the desktop app
// on Windows or macOS (ARIGAMI_SCREEN_DRIVER is documented in
// server/lib/screen-driver.ts as existing precisely so that host shape can be
// exercised without one).
//
// Two things are pinned here, and both were broken before:
//   • /__api/screen/status now says WHICH transport the host speaks. The
//     cockpit assumed RFB everywhere, which is why a Windows host showed a
//     black "disconnected" box for every screen view.
//   • /__vnc on such a host closes with a distinguishable code instead of
//     silently trying to reach a VNC server that does not exist there and
//     leaving the client hanging on "connecting…".
// Real Chrome is not exercised here — that is the live check (see
// docs/WINDOWS-REMOTE.md), which does prove clicks/keys reach the page.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { WebSocket as WsClient } from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// The rest of the suite clobbers `globalThis.fetch` and `globalThis.WebSocket`
// with inert stubs (a dozen *-web.test.js files do it in beforeAll and never
// restore them), and bun runs every file in ONE process. A host test needs the
// REAL implementations, so it must not touch the globals at all: HTTP goes
// through node:http, and sockets through the `ws` package's own client. Found
// the hard way — these tests passed alone and hung in a full run.
function httpJson(url: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const u = new URL(url);
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || 'GET', headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, json: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode || 0, json: { raw: body } }); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-wrp-host-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'claude-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'off',
      // Explicit, not inherited: this worker's own session env has
      // ARIGAMI_BIND=0.0.0.0 (the real host binds wide), and an unauthenticated
      // host refuses to start on anything but loopback.
      ARIGAMI_BIND: '127.0.0.1',
      ARIGAMI_SCREEN_ENABLED: '1',
      ARIGAMI_SCREEN_DRIVER: 'native-window', // ← the whole point of this file
      ARIGAMI_GLOBAL_DESKTOP: '0', // never touch the real :99 from a test
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  host.stdout!.on('data', (d) => { log += d; });
  host.stderr!.on('data', (d) => { log += d; });
  try {
    await until(async () => { try { return (await httpJson(base + '/__api/config')).status === 200; } catch { return false; } });
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
  // Explicit hook timeout: bun's default is 5s, and a cold `bun server/index.ts`
  // on a loaded box regularly needs more than that — without this the file
  // fails as a hook timeout that looks nothing like the thing it tests.
}, 60000);
afterAll(() => { try { host?.kill('SIGTERM'); } catch {} });

async function newSession(): Promise<string> {
  const r = await httpJson(base + '/__api/sessions', { method: 'POST', body: { title: 't', cwd: path.join(dir, 'workspace') } });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

test('screen/status declares the transport, so the cockpit stops assuming RFB on a host that has no VNC', async () => {
  const sid = await newSession();
  const st = (await httpJson(`${base}/__api/screen/status?session=${sid}`)).json;
  expect(st.driver).toBe('native-window');
  expect(st.viewer.transport).toBe('screencast');
  expect(st.viewer.path).toBe(`/__screencast?session=${sid}`);
  // Input reaches the machine over this transport — that is the parity claim.
  expect(st.viewer.interactive).toBe(true);
  // …and it is honest that the reach is the browser window, not the desktop.
  expect(st.viewer.scope).toBe('browser');
});

test('screen/status without a session: still names the driver, and offers no control it cannot deliver', async () => {
  const st = (await httpJson(`${base}/__api/screen/status`)).json;
  expect(st.driver).toBe('native-window');
  expect(st.viewer.transport).toBe('screencast');
  expect(st.viewer.interactive).toBe(false); // no session → no page for CDP to aim at
});

test('/__vnc on a host with no VNC desktop closes with a distinct code instead of hanging on "connecting…"', async () => {
  const sid = await newSession();
  const ws = new WsClient(`ws://127.0.0.1:${new URL(base).port}/__vnc?session=${sid}`, ['binary']);
  const closed = await new Promise<{ code: number }>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('socket neither closed nor errored — this is the old hang')), 10000);
    ws.on('close', (code: number) => { clearTimeout(t); resolve({ code }); });
    ws.on('error', () => { clearTimeout(t); resolve({ code: -1 }); });
  });
  // 4004 = "this host has no RFB transport"; anything else (a silent 1006
  // after a dead TCP connect) is the behaviour this change removed.
  expect(closed.code).toBe(4004);
  // Generous explicit timeout: bun's 5s default is not enough for this one
  // under a full-suite run on a loaded box (it spawns nothing, but it shares
  // the host with every other file's boot), and a timeout here reads exactly
  // like the hang the test exists to catch.
}, 30000);
