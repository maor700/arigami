// End-to-end for the RFB half of windows-remote-parity, against ISOLATED
// hosts and a REAL VNC server.
//
// `/__vnc` used to hardcode the x11 path (`ensureDesktop`/`screenTarget` from
// the Xvfb-only desktops.ts). It now hands the socket to the active driver's
// `attachViewer`, which is what lets a second RFB-speaking driver (winvnc —
// a VNC service running on a Windows machine) reuse the entire existing
// bridge, cockpit and capture stack with no client-side code at all.
//
// Both sides of that change are covered here, because the refactor could
// plausibly break the platform everyone actually runs on:
//   • winvnc  — the new path: does a host on that driver really serve RFB?
//   • x11     — the old path: does it still?
// "Serves RFB" is checked by reading the server's protocol banner off the
// bridged WebSocket, which only appears if bytes genuinely reached a VNC
// server and came back.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket as WsClient } from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostDiag } from './_host-diag.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const have = (bin: string) => {
  try { return Bun.spawnSync(['sh', '-c', `command -v ${bin}`]).exitCode === 0; } catch { return false; }
};
const HAVE_VNC = have('Xvfb') && have('x11vnc');

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

async function waitTcp(port: number, ms = 12000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port, timeout: 400 });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); resolve(false); });
      s.once('timeout', () => { s.destroy(); resolve(false); });
    });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}


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

const procs: ChildProcess[] = [];
const dirs: string[] = [];
let vncPort = 0;
let display = '';

// One host per DRIVER, booted lazily and reused. Booting a fresh
// `bun server/index.ts` per test cost ~3 boots in this file alone, and in a
// full-suite run (which is already spawning dozens of processes) the third one
// did not come up inside the test's budget. Nothing here mutates a host, so
// sharing is safe and the file went from 3 boots to 2.
const hosts = new Map<string, Promise<string>>();
function host(key: string, env: Record<string, string>): Promise<string> {
  let p = hosts.get(key);
  if (!p) { p = startHost(env); hosts.set(key, p); }
  return p;
}

/** Boot an isolated host with the given screen env; returns its base URL. */
async function startHost(env: Record<string, string>): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-wrpv-host-'));
  dirs.push(dir);
  const port = await freePort();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'claude-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
  const h = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'off',
      ARIGAMI_BIND: '127.0.0.1', // this worker's own env binds wide; unauthenticated hosts may not
      ARIGAMI_SCREEN_ENABLED: '1',
      ARIGAMI_GLOBAL_DESKTOP: '0', // never touch the real :99 from a test
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(h);
  let log = '';
  h.stdout!.on('data', (d) => { log += d; });
  h.stderr!.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try { if ((await httpJson(base + '/__api/config')).status === 200) return base; } catch {}
    await sleep(100);
  }
  throw new Error(`host did not come up: ${log.slice(-1200)}${hostDiag(host)}`);
}

/**
 * Open the host's /__vnc bridge and return the first bytes the far side sends.
 * A real VNC server opens with its protocol banner ("RFB 003.008\n"), so this
 * is the cheapest honest proof that the bridge reached one — nothing else on
 * this socket could produce those bytes.
 */
function rfbBanner(base: string, query = ''): Promise<string> {
  const url = base.replace('http://', 'ws://') + '/__vnc' + query;
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url, ['binary']);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('no bytes from the bridge in time')); }, 12000);
    ws.on('message', (data: Buffer) => {
      clearTimeout(t);
      try { ws.close(); } catch {}
      resolve(data.toString('latin1'));
    });
    ws.on('close', (code: number) => { clearTimeout(t); reject(new Error(`closed before any data (code ${code})`)); });
    ws.on('error', (e: Error) => { clearTimeout(t); reject(new Error('socket error: ' + e.message)); });
  });
}

beforeAll(async () => {
  if (!HAVE_VNC) return;
  let n = 250;
  while (fs.existsSync(`/tmp/.X${n}-lock`) || fs.existsSync(`/tmp/.X11-unix/X${n}`)) n++;
  display = `:${n}`;
  vncPort = await freePort();
  procs.push(spawn('Xvfb', [display, '-screen', '0', '640x480x24', '-nolisten', 'tcp'], { stdio: 'ignore' }));
  for (let i = 0; i < 60 && !fs.existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
  procs.push(spawn('x11vnc', ['-display', display, '-rfbport', String(vncPort), '-localhost', '-shared', '-forever', '-noxdamage', '-quiet', '-nopw'], { stdio: 'ignore' }));
  if (!(await waitTcp(vncPort))) throw new Error('x11vnc did not come up');
}, 90000);

afterAll(() => {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test.skipIf(!HAVE_VNC)('winvnc host: declares an rfb transport AND its /__vnc bridge really reaches the VNC service', async () => {
  const base = await host('winvnc', {
    ARIGAMI_SCREEN_DRIVER: 'winvnc',
    ARIGAMI_VNC_HOST: '127.0.0.1',
    ARIGAMI_VNC_PORT: String(vncPort),
  });
  const st = (await httpJson(base + '/__api/screen/status')).json;
  expect(st.driver).toBe('winvnc');
  expect(st.viewer).toMatchObject({ transport: 'rfb', interactive: true, scope: 'desktop' });
  expect(st.available).toBe(true);

  // The cockpit renders this descriptor with the noVNC client it already has,
  // so this is the whole client story for a Windows machine.
  const banner = await rfbBanner(base);
  expect(banner).toMatch(/^RFB \d{3}\.\d{3}/);
}, 90000);

test.skipIf(!HAVE_VNC)('winvnc host: a ?session= is ignored rather than sent down the Xvfb-only path', async () => {
  // bridgeToVnc's per-session branch calls ensureDesktop(), which is Xvfb-only
  // and rejects on Windows. The driver passes null on purpose; if that ever
  // regressed, this socket would close with no data instead of a banner.
  const base = await host('winvnc', {
    ARIGAMI_SCREEN_DRIVER: 'winvnc',
    ARIGAMI_VNC_HOST: '127.0.0.1',
    ARIGAMI_VNC_PORT: String(vncPort),
  });
  const banner = await rfbBanner(base, '?session=no-such-session');
  expect(banner).toMatch(/^RFB \d{3}\.\d{3}/);
}, 90000);

test.skipIf(!HAVE_VNC)('x11 host: the historical path still bridges after /__vnc was switched to the driver', async () => {
  // The regression guard for the platform everyone actually runs on: with no
  // session, screenTarget() falls back to the configured global desktop, which
  // here is the x11vnc this test spawned.
  const base = await host('x11', {
    ARIGAMI_SCREEN_DRIVER: 'x11',
    ARIGAMI_VNC_HOST: '127.0.0.1',
    ARIGAMI_VNC_PORT: String(vncPort),
  });
  const st = (await httpJson(base + '/__api/screen/status')).json;
  expect(st.driver).toBe('x11');
  expect(st.viewer.transport).toBe('rfb');
  const banner = await rfbBanner(base);
  expect(banner).toMatch(/^RFB \d{3}\.\d{3}/);
}, 90000);
