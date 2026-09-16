// S1 ↔ S2 contract test. The web client (web/src/lib/setup-api.js on
// feat/S2-jit-setup-web, later merged) is the source of truth for what the UI
// calls; this file pins that contract on the server side:
//   (a) every route S2 calls exists on an isolated host and answers the shape
//       S2 reads (status codes + fields), and
//   (b) if S2's client is reachable (working tree or the branch), every
//       `/setup/…` route it references is in the table below — a new route in
//       S2 without a server counterpart fails here, not in production.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostDiag } from './_host-diag.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The contract as S2 documents it (setup-api.js header). Keep in sync by hand;
// (b) below catches drift in the route set.
const S2_ROUTES = [
  { method: 'GET', route: '/__api/setup/capabilities', shape: ['identity', 'capabilities', 'audit'] },
  { method: 'POST', route: '/__api/setup/:capability' },
  { method: 'POST', route: '/__api/setup/:id/skip' },
  { method: 'POST', route: '/__api/setup/:id/report' },
  { method: 'POST', route: '/__api/setup/:id/mode' },
  { method: 'POST', route: '/__api/setup/:id/start' },
  { method: 'DELETE', route: '/__api/setup/:capability' },
];
// Fields S2's SetupCard / ConnectionsCard read off the `setup` chat event and capabilities rows.
const CARD_FIELDS = ['requestId', 'capability', 'why', 'mode', 'autoCapable', 'identity', 'manual', 'state', 'detail', 'evidence', 'lines'];
const CAP_FIELDS = ['id', 'ok', 'detail', 'manual', 'autoCapable'];

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
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: { raw: text } };
  }
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-S1-contract-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  const stub = path.join(dir, 'claude-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: path.join(dir, 'home'),
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'off',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_SETUP_TIMEOUT_MS: '60000',
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: path.join(dir, 'workspace'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  host.stdout!.on('data', (d) => (log += d));
  host.stderr!.on('data', (d) => (log += d));
  try {
    await until(async () => {
      try {
        return (await fetch(base + '/__api/config', { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        return false;
      }
    }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}${hostDiag(host)}`);
  }
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default
afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

// (b) — S2's client, if we can see it.
function s2ClientSource(): string | null {
  const local = path.join(ROOT, 'web', 'src', 'lib', 'setup-api.js');
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf8');
  for (const ref of ['feat/S2-jit-setup-web', 'origin/feat/S2-jit-setup-web']) {
    const r = spawnSync('git', ['-C', ROOT, 'show', `${ref}:web/src/lib/setup-api.js`], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) return r.stdout;
  }
  return null;
}

test('(b) every /setup route S2\'s client references is in the server contract table', () => {
  const src = s2ClientSource();
  if (!src) {
    console.warn('[setup-contract] S2 client not reachable — skipping route-set cross-check');
    return;
  }
  // Header lines: "GET  /__api/setup/capabilities" …; code: api.post(`/setup/${…}/skip`) etc.
  const header = [...src.matchAll(/^\/\/\s+(GET|POST|DELETE)\s+(\/__api\/setup\/\S+)/gm)].map((m) => `${m[1]} ${m[2]}`);
  const code = [...src.matchAll(/api\.(get|post|del)\(`\/setup\/\$\{[^}]+\}(\/[a-z]+)?`/g)].map((m) => `${{ get: 'GET', post: 'POST', del: 'DELETE' }[m[1]]} /__api/setup/:x${m[2] || ''}`);
  const codeStatic = [...src.matchAll(/api\.(get|post|del)\('\/setup\/([a-z]+)'/g)].map((m) => `${{ get: 'GET', post: 'POST', del: 'DELETE' }[m[1]]} /__api/setup/${m[2]}`);
  const norm = (s: string) => s.replace(/:(capability|id|x)/g, ':param');
  const table = new Set(S2_ROUTES.map((r) => norm(`${r.method} ${r.route}`)));
  const seen = [...new Set([...header, ...code, ...codeStatic].map(norm))];
  expect(seen.length).toBeGreaterThanOrEqual(6);
  for (const s of seen) expect(table.has(s)).toBe(true);
});

test('(a) GET capabilities: {identity, capabilities[], audit[]} with the fields ConnectionsCard/SetupCard read', async () => {
  const r = await api('GET', '/__api/setup/capabilities');
  expect(r.status).toBe(200);
  for (const k of S2_ROUTES[0].shape!) expect(k in r.json).toBe(true);
  expect(Array.isArray(r.json.audit)).toBe(true);
  for (const c of r.json.capabilities) for (const k of CAP_FIELDS) expect(k in c).toBe(true);
  // manual.kind values S2 has a component for.
  const kinds = new Set(r.json.capabilities.map((c: any) => c.manual.kind));
  for (const k of kinds) expect(['token', 'oauth', 'qr', 'toggle', 'repo', 'takeover']).toContain(k);
});

test('(a) setup card + live patches carry every field S2 renders; start/mode/skip/report/DELETE answer as documented', async () => {
  const sid = (await api('POST', '/__api/sessions', { title: 'contract', cwd: path.join(dir, 'workspace') })).json.id;
  // identity present → composio card preselects auto.
  await api('POST', '/__api/setup/identity', { action: 'verify', email: 'c@example.com' });
  const wait = api('POST', '/__mcp/setup-request', { session_id: sid, capability: 'composio:gmail', why: 'read your inbox' });
  const chat = async () => (await api('GET', `/__api/sessions/${sid}/chat`)).json as any[];
  const card = await until(async () => (await chat()).find((e: any) => e.kind === 'setup'));
  for (const k of CARD_FIELDS) expect(k in card).toBe(true);
  expect(card.identity).toEqual({ email: 'c@example.com', owner: 'global' });
  expect(['pending', 'auto', 'done', 'failed', 'skipped', 'timeout']).toContain(card.state);
  expect(typeof card.autoCapable).toBe('boolean');

  // mode switch → 200 + card payload; does not release the agent.
  const md = await api('POST', `/__api/setup/${card.requestId}/mode`, { mode: 'manual' });
  expect(md.status).toBe(200);
  expect(md.json.requestId).toBe(card.requestId);
  // start → auto; agent released with state:'auto'.
  const st = await api('POST', `/__api/setup/${card.requestId}/start`, { mode: 'auto' });
  expect(st.status).toBe(200);
  expect(st.json.state).toBe('auto');
  expect((await wait).json.state).toBe('auto');
  // patches are setup-update events keyed by requestId, with lines.
  await api('POST', `/__api/setup/${card.requestId}/report`, { line: 'Opening Composio…' });
  const patch = (await chat()).filter((e: any) => e.kind === 'setup-update').at(-1);
  expect(patch.requestId).toBe(card.requestId);
  expect(patch.lines).toEqual(['Opening Composio…']);
  // report ok:false → failed (S2 shows the manual steps again).
  const f = await api('POST', `/__api/setup/${card.requestId}/report`, { ok: false, detail: 'nope' });
  expect(f.json.state).toBe('failed');
  expect((await chat()).at(-1)).toMatchObject({ kind: 'setup-update', requestId: card.requestId, state: 'failed', mode: 'manual', detail: 'nope' });
  // skip → 200; then 404 on a closed card (S2 treats 404 as "old host" only for GET overview).
  expect((await api('POST', `/__api/setup/${card.requestId}/skip`, {})).status).toBe(200);
  expect((await api('POST', `/__api/setup/${card.requestId}/skip`, {})).status).toBe(404);
  // DELETE identity / provider.
  expect((await api('DELETE', '/__api/setup/identity')).json.identity).toBeNull();
  expect((await api('DELETE', '/__api/setup/telemetry')).json.ok).toBe(true);
  // Manual payload conventions per manual.kind (S2 sends exactly these).
  const wa = await api('POST', '/__api/setup/whatsapp', { action: 'poll' });
  expect(wa.status).toBe(200);
  expect('status' in wa.json).toBe(true);
  const dev = await api('POST', '/__api/setup/git', { action: 'poll' });
  expect(dev.json.device).toMatchObject({ state: expect.any(String) });
  expect('ok' in dev.json).toBe(true);
  const cl = await api('POST', '/__api/setup/claude', { action: 'start' });
  expect(cl.json.id).toBeTruthy();
  expect(cl.json.url).toMatch(/^https:\/\//);
  await api('POST', '/__api/setup/claude', { action: 'cancel', id: cl.json.id });
  const tg = await api('POST', '/__api/setup/telemetry', { enable: false });
  expect(tg.json.ok).toBe(true);
  const rp = await api('POST', '/__api/setup/repo:zzz', {});
  expect(rp.status).toBe(400); // {entry} required for an unknown repo — S2 shows the error
  expect(rp.json.error).toMatch(/entry/);
});
