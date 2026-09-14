// BROWSE1 end-to-end against an ISOLATED host (same lightweight harness as
// setup-lifecycle.test.ts: a `sleep` stub instead of `claude`, so a session
// exists without a real turn): the /policy endpoint hides browser_* for an
// agent without `browser`/`desktop`; POST …/browser/navigate refuses a url
// outside `domains` before touching Chrome; the browser/* routes fail
// cleanly (no crash) when no browser is open yet; and /__api/screen/status
// reports `own` — the field ScreenSidePanel.jsx uses to tell "this session's
// own machine" from "the shared desktop fallback" (spec item #2). Real
// Chrome/Xvfb are NOT exercised here (chrome.ts/vnc.ts have no such
// coverage either) — that's the separate live-verify pass on a real host.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
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
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { raw: text } }; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error('condition not met in time');
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-browse1-host-'));
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
      ARIGAMI_SCREEN_ENABLED: '0',
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
    await until(async () => { try { return (await fetch(base + '/__api/config')).ok; } catch { return false; } }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default
afterAll(() => { try { host?.kill('SIGTERM'); } catch {} });

async function newSession(agent?: string): Promise<string> {
  const r = await api('POST', '/__api/sessions', { title: 't', cwd: path.join(dir, 'workspace'), ...(agent ? { agent } : {}) });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

test('policy: an agent without `browser`/`desktop` never sees browser_* over the host MCP filter', async () => {
  const a = await api('POST', '/__api/agents', { name: 'NoBrowse', slug: 'no-browse', tools: ['git'] });
  expect(a.status).toBe(201);
  const sid = await newSession('no-browse');
  const names = 'browser_open,browser_navigate,browser_snapshot,browser_click,browser_type,browser_scroll,browser_close,open_tab';
  const pol = await api('GET', `/__api/sessions/${sid}/policy?names=${names}`);
  expect(pol.json.restrictive).toBe(true);
  expect(new Set(pol.json.hidden)).toEqual(new Set(names.split(',')));
});

test('policy: an agent with `browser` sees exactly the browser_* tools (not open_tab)', async () => {
  const a = await api('POST', '/__api/agents', { name: 'Browse', slug: 'can-browse', tools: ['browser'] });
  expect(a.status).toBe(201);
  const sid = await newSession('can-browse');
  const names = 'browser_open,browser_navigate,browser_snapshot,browser_click,browser_type,browser_scroll,browser_close,open_tab';
  const pol = await api('GET', `/__api/sessions/${sid}/policy?names=${names}`);
  expect(pol.json.hidden).toEqual(['open_tab']);
});

test('browser_open / browser_navigate refuse a url outside the agent\'s `domains` (never reach Chrome — 403, no 503/crash)', async () => {
  await api('POST', '/__api/agents', { name: 'Fenced', slug: 'fenced', domains: ['example.com'] });
  const sid = await newSession('fenced');
  const bad1 = await api('POST', `/__api/sessions/${sid}/browser/open`, { url: 'https://evil.com' });
  expect(bad1.status).toBe(403);
  expect(bad1.json.error).toMatch(/domain/);
  const bad2 = await api('POST', `/__api/sessions/${sid}/browser/navigate`, { url: 'https://evil.com' });
  expect(bad2.status).toBe(403);
  expect(bad2.json.error).toMatch(/domain/);
});

test('browser/navigate, /click, /type, /snapshot fail cleanly (not a crash) when this session never opened a browser', async () => {
  const sid = await newSession();
  const nav = await api('POST', `/__api/sessions/${sid}/browser/navigate`, { url: 'https://example.com' });
  expect(nav.status).toBeGreaterThanOrEqual(400);
  expect(String(nav.json.error || '')).toMatch(/open|browser|screen/i);
  const click = await api('POST', `/__api/sessions/${sid}/browser/click`, { x: 10, y: 10 });
  expect(click.status).toBeGreaterThanOrEqual(400);
  const type = await api('POST', `/__api/sessions/${sid}/browser/type`, { text: 'hi' });
  expect(type.status).toBeGreaterThanOrEqual(400);
  // browser_close is always safe to call, even with nothing running.
  const close = await api('POST', `/__api/sessions/${sid}/browser/close`, {});
  expect(close.status).toBe(200);
  expect(close.json.ok).toBe(true);
});

test('screen/status reports `own` (this session\'s own display) separately from the shared-desktop fallback', async () => {
  const sid = await newSession();
  const before = await api('GET', `/__api/screen/status?session=${sid}`);
  expect(before.json.own).toBe(false);
  const patched = await api('PATCH', `/__api/sessions/${sid}`, { metadata: { screen: { display: ':123', vncPort: 59123 } } });
  expect(patched.status).toBe(200);
  const after = await api('GET', `/__api/screen/status?session=${sid}`);
  expect(after.json.own).toBe(true);
  expect(after.json.display).toBe(':123');
});
