// screen-agnostic: skills/_lib/connect.sh's `open`/`nav`/`type`/`click`/`shot`
// now drive the session's Chrome through the host's CDP-backed browser REST
// (server/lib/browser-actions.ts — the same code behind the browser_* MCP
// tools) instead of typing into the X11 root window or scrot-ing the desktop.
// Exercised against a fake host HTTP server (its OWN process — see
// profiles.test.ts's dumb-HTTP test for why: connect.sh's curl calls are
// spawnSync'd from THIS process, and an in-process Bun.serve can't answer
// them because spawnSync blocks the very event loop that would run the
// fetch handler — a self-deadlock). No real Chrome, no desktop; `key` alone
// still shells out to xinput.py/XTEST (no CDP equivalent for a raw combo).
import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH = path.join(ROOT, 'skills/_lib/connect.sh');

// Logs every non-health request to LOG (one JSON line each) and always
// answers with whatever {status,body} is currently in RESP — the test
// rewrites RESP between calls to script different responses.
const SERVER_SCRIPT = `
const fs = require('node:fs');
const log = process.argv[1], respFile = process.argv[2], port = Number(process.argv[3]);
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/__health') return new Response('ok');
    const body = req.method === 'GET' ? undefined : await req.json().catch(() => ({}));
    fs.appendFileSync(log, JSON.stringify({ method: req.method, path: url.pathname, body }) + '\\n');
    const cfg = JSON.parse(fs.readFileSync(respFile, 'utf8'));
    return Response.json(cfg.body, { status: cfg.status || 200 });
  },
});
`;

let proc = null;
afterEach(() => {
  proc?.kill();
  proc = null;
});

async function fakeHost(initial = { status: 200, body: { ok: true } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-sh-host-'));
  const log = path.join(dir, 'calls.log');
  const respFile = path.join(dir, 'resp.json');
  fs.writeFileSync(respFile, JSON.stringify(initial));
  const port = 49500 + Math.floor(Math.random() * 5000);
  proc = Bun.spawn(['bun', '-e', SERVER_SCRIPT, log, respFile, String(port)], { stdout: 'ignore', stderr: 'ignore' });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/__health`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 50));
  }
  expect(up).toBe(true);
  return {
    port,
    setResp: (status, body) => fs.writeFileSync(respFile, JSON.stringify({ status, body })),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

function sandbox(port, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-sh-'));
  const run = (...args) =>
    spawnSync('bash', [SH, ...args], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        ARIGAMI_SESSION_ID: 'sess_test',
        ARIGAMI_DIR: dir,
        ARIGAMI_URL: `http://127.0.0.1:${port}`,
        ARIGAMI_TOKEN: 'tok',
        CONNECT_ALLOW: 'google.com composio.dev',
        ...extraEnv,
      },
    });
  return { run, dir };
}

test('open: allowlist-checked, then POSTs {url} to browser/open; refuses off-list hosts before any network call', async () => {
  const host = await fakeHost({ status: 200, body: { ok: true, url: 'https://myaccount.google.com/', title: 'x', screenshot: null } });
  const { run } = sandbox(host.port);

  const bad = run('open', 'https://evil.example/');
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('not in allowlist');
  expect(host.calls().length).toBe(0);

  const ok = run('open', 'https://myaccount.google.com/');
  expect(ok.status).toBe(0);
  expect(host.calls()).toEqual([{ method: 'POST', path: '/__api/sessions/sess_test/browser/open', body: { url: 'https://myaccount.google.com/' } }]);
});

test('nav: allowlist-checked, then POSTs {url} to browser/navigate', async () => {
  const host = await fakeHost({ status: 200, body: { ok: true, url: 'https://accounts.google.com/', title: 'x' } });
  const { run } = sandbox(host.port);
  const r = run('nav', 'https://accounts.google.com/');
  expect(r.status).toBe(0);
  expect(host.calls()).toEqual([{ method: 'POST', path: '/__api/sessions/sess_test/browser/navigate', body: { url: 'https://accounts.google.com/' } }]);

  const empty = spawnSync('bash', [SH, 'nav', 'https://google.com/'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ARIGAMI_SESSION_ID: 'sess_test', ARIGAMI_URL: `http://127.0.0.1:${host.port}`, CONNECT_ALLOW: '' },
  });
  expect(empty.status).toBe(1);
  expect(empty.stderr).toMatch(/CONNECT_ALLOW is empty/);
});

test('nav/open fail loudly (non-zero, message includes the response) on a policy 403 or ok:false — never a silent success', async () => {
  const host = await fakeHost({ status: 403, body: { error: 'blocked by domain allowlist' } });
  const { run } = sandbox(host.port);
  const r = run('nav', 'https://google.com/');
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/navigate failed/);
  expect(r.stderr).toContain('blocked by domain allowlist');
});

test('type: POSTs {text} to browser/type; a needsHuman refusal (password/OTP/CAPTCHA field) is a failure, not a silent no-op', async () => {
  const host = await fakeHost({ status: 200, body: { ok: false, needsHuman: true, reason: 'credentials', hint: 'call request_screen instead' } });
  const { run } = sandbox(host.port);
  const r = run('type', '123-456');
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('call request_screen instead');
  expect(host.calls()).toEqual([{ method: 'POST', path: '/__api/sessions/sess_test/browser/type', body: { text: '123-456' } }]);
});

test('type: escapes quotes/backslashes so the JSON body stays well-formed', async () => {
  const host = await fakeHost({ status: 200, body: { ok: true, via: 'cdp' } });
  const { run } = sandbox(host.port);
  const r = run('type', 'say "hi"\\bye');
  expect(r.status).toBe(0);
  expect(host.calls()[0].body).toEqual({ text: 'say "hi"\\bye' });
});

test('click: POSTs {x,y} to browser/click', async () => {
  const host = await fakeHost({ status: 200, body: { ok: true, x: 10, y: 20 } });
  const { run } = sandbox(host.port);
  const r = run('click', '10', '20');
  expect(r.status).toBe(0);
  expect(host.calls()).toEqual([{ method: 'POST', path: '/__api/sessions/sess_test/browser/click', body: { x: 10, y: 20 } }]);
});

test('shot: decodes {base64} from browser/screenshot into a PNG file — a TAB screenshot, no scrot/DISPLAY/root window involved', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
  const host = await fakeHost({ status: 200, body: { ok: true, base64: png.toString('base64') } });
  const { run } = sandbox(host.port, { DISPLAY: '' });
  const r = run('shot', 'first');
  expect(r.status).toBe(0);
  const out = r.stdout.trim();
  expect(fs.readFileSync(out).equals(png)).toBe(true);
  expect(host.calls()).toEqual([{ method: 'POST', path: '/__api/sessions/sess_test/browser/screenshot', body: {} }]);
});

test('shot: fails clearly when the host has no screenshot to give (no open tab)', async () => {
  const host = await fakeHost({ status: 503, body: { ok: false, error: 'no open page for this session — call browser_open first' } });
  const { run } = sandbox(host.port);
  const r = run('shot', 'first');
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/shot failed/);
});

test('key: has no CDP equivalent — fails clearly instead of silently no-op-ing when this session has no desktop', () => {
  const r = spawnSync('bash', [SH, 'key', 'ctrl+l'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ARIGAMI_SESSION_ID: 'sess_test', ARIGAMI_URL: 'http://127.0.0.1:1', DISPLAY: '' },
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/no CDP equivalent/);
});

test('allowed/CONNECT_ALLOW semantics are unchanged: exact + subdomain match only, refuses empty list and look-alikes', () => {
  const env = { ...process.env, ARIGAMI_SESSION_ID: 'sess_test', ARIGAMI_URL: 'http://127.0.0.1:1' };
  const run = (allow, url) => spawnSync('bash', [SH, 'allowed', url], { env: { ...env, CONNECT_ALLOW: allow }, encoding: 'utf8' }).status;
  expect(run('accounts.google.com google.com', 'https://accounts.google.com/signin')).toBe(0);
  expect(run('google.com', 'https://myaccount.google.com/')).toBe(0);
  expect(run('google.com', 'https://GOOGLE.com:443/x')).toBe(0);
  expect(run('google.com', 'https://google.com.evil.net/')).toBe(1);
  expect(run('google.com', 'https://evilgoogle.com/')).toBe(1);
  expect(run('google.com', 'https://user@evil.net/?x=google.com')).toBe(1);
  expect(run('', 'https://google.com/')).toBe(1);
});
