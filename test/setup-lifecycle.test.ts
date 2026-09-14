// F6 — setup-card lifecycle against an ISOLATED host (same harness as
// setup-request.test.ts): (2) a session restart keeps the card open and a
// late report_setup reopens/updates a closed card (a human skip stays
// closed); cards survive a HOST restart; (4) already:true writes an audit
// line; (5) `why` never empty; (6) the identity take-over verify reads the
// signed-in account from the session's Chrome profile and resolves as done.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_TIMEOUT_MS = 6000;

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
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { raw: text } }; }
}
const mcp = (p: string, body: unknown) => api('POST', p, body).then((r) => r.json);
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
const chat = async (sid: string): Promise<any[]> => (await api('GET', `/__api/sessions/${sid}/chat`)).json;
const setupEvents = async (sid: string) => (await chat(sid)).filter((e: any) => e.kind === 'setup' || e.kind === 'setup-update');
const lastUpdate = async (sid: string, id: string) => (await setupEvents(sid)).filter((e: any) => e.id === id).at(-1);
const pendingIds = async (sid: string) => (await api('GET', `/__api/setup/pending?session=${sid}`)).json.pending.map((p: any) => p.id);
const audit = async () => (await api('GET', '/__api/setup/connections')).json.audit as any[];

async function startHost(): Promise<void> {
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
      ARIGAMI_SETUP_TIMEOUT_MS: String(SETUP_TIMEOUT_MS),
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
  host.stdout!.on('data', (d) => { log += d; fs.appendFileSync(path.join(dir, 'host.log'), d); });
  host.stderr!.on('data', (d) => { log += d; fs.appendFileSync(path.join(dir, 'host.log'), d); });
  try {
    await until(async () => { try { return (await fetch(base + '/__api/config')).ok; } catch { return false; } }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
}
async function stopHost(): Promise<void> {
  const h = host;
  if (!h) return;
  const gone = new Promise<void>((r) => h.once('exit', () => r()));
  h.kill('SIGTERM');
  await Promise.race([gone, sleep(8000).then(() => h.kill('SIGKILL'))]);
  await until(async () => { try { await fetch(base + '/__api/config'); return false; } catch { return true; } }, 10000);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-F6-host-'));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startHost();
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default
afterAll(() => { try { host?.kill('SIGTERM'); } catch {} });

async function newSession(title: string): Promise<string> {
  const r = await api('POST', '/__api/sessions', { title, cwd: path.join(dir, 'workspace') });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

test('(5) why defaults to the capability title — request_setup and check_setup', async () => {
  const sid = await newSession('why');
  const pending = mcp('/__mcp/setup-request', { session_id: sid, capability: 'git', mode: 'manual' });
  const card = await until(async () => (await setupEvents(sid)).find((e: any) => e.kind === 'setup'));
  expect(card.why).toBe('Git / GitHub');
  expect((await audit()).at(-1)).toMatchObject({ capability: 'git', result: 'requested', detail: 'Git / GitHub' });
  const c = await api('GET', '/__api/setup/capabilities/composio:gmail');
  expect(c.json).toEqual({ needs_setup: 'composio:gmail', why: 'Gmail (via Composio)', hint: 'call request_setup' });
  expect((await api('GET', '/__api/setup/capabilities/composio:gmail?why=%20%20')).json.why).toBe('Gmail (via Composio)');
  await api('POST', `/__api/setup/${card.id}/skip`, {});
  expect((await pending).state).toBe('skipped');
}, 30000);

test('(4) already connected → {already:true} at once AND an audit line result:"already"', async () => {
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ email: 'owner@example.com', provider: 'google', connectedAt: new Date().toISOString(), chromeProfile: 'base', providers: {} }));
  const sid = await newSession('already');
  const before = (await audit()).length;
  const r = await mcp('/__mcp/setup-request', { session_id: sid, capability: 'identity', why: 'sign in for you' });
  expect(r).toMatchObject({ state: 'done', already: true, capability: 'identity' });
  const a = await audit();
  expect(a.length).toBe(before + 1);
  expect(a.at(-1)).toMatchObject({ sessionId: sid, capability: 'identity', result: 'already', human: false, mode: 'none', detail: 'sign in for you' });
  expect((await setupEvents(sid)).length).toBe(0); // still no card
  fs.unlinkSync(path.join(dir, 'identity.json'));
}, 30000);

test('(2) session restart keeps the card open (no "timeout — session restarted"); re-request attaches; host restart keeps it too', async () => {
  const sid = await newSession('restart');
  const pending = mcp('/__mcp/setup-request', { session_id: sid, capability: 'git', why: 'push a branch', mode: 'manual' });
  const card = await until(async () => (await setupEvents(sid)).find((e: any) => e.kind === 'setup'));
  expect((await api('GET', `/__api/sessions/${sid}`)).json.claude.setupRequest).toEqual({ id: card.id, capability: 'git' });

  // Restart the session's claude: the blocked tool call is released, the card is NOT closed.
  expect((await api('POST', `/__api/sessions/${sid}/restart`, {})).status).toBe(200);
  const released = await pending;
  expect(released.state).toBe('timeout');
  expect(released.detail).toBe('session restarted');
  expect(await pendingIds(sid)).toEqual([card.id]);
  expect((await lastUpdate(sid, card.id)).state).toBe('pending');
  expect((await audit()).filter((a) => a.capability === 'git' && a.result === 'timeout')).toEqual([]);
  expect((await api('GET', `/__api/sessions/${sid}`)).json.claude.setupRequest).toBeNull();

  // The respawned agent asks again → same card, still pending, agent blocked again.
  const again = mcp('/__mcp/setup-request', { session_id: sid, capability: 'git', why: 'push a branch', mode: 'manual' }).catch(() => null); // dies with the host below
  await until(async () => (await api('GET', `/__api/sessions/${sid}`)).json.claude.setupRequest?.id === card.id);
  expect(await pendingIds(sid)).toEqual([card.id]);

  // Host restart: the card is persisted and comes back (its timer resumes).
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'setup-pending.json'), 'utf8'));
  expect(persisted.map((p: any) => p.id)).toEqual([card.id]);
  await stopHost();
  await again;
  await startHost();
  expect(await pendingIds(sid)).toEqual([card.id]);
  const s = (await api('POST', `/__api/setup/${card.id}/skip`, {})).json;
  expect(s).toMatchObject({ ok: true, id: card.id, state: 'skipped' });
  expect(await pendingIds(sid)).toEqual([]);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'setup-pending.json'), 'utf8'))).toEqual([]);
}, 30000);

test('(2) report_setup reopens + closes a timed-out card; a human skip stays closed', async () => {
  const sid = await newSession('reopen');
  const pending = mcp('/__mcp/setup-request', { session_id: sid, capability: 'git', why: 'push', mode: 'manual' });
  const card = await until(async () => (await setupEvents(sid)).find((e: any) => e.kind === 'setup'));
  expect((await pending).state).toBe('timeout'); // nobody answered within SETUP_TIMEOUT_MS
  expect((await lastUpdate(sid, card.id)).state).toBe('timeout');
  const line = await mcp('/__mcp/setup-report', { session_id: sid, capability: 'git', line: 'still on it' });
  expect(line).toMatchObject({ ok: true, closed: false, id: card.id, lines: ['still on it'] });
  expect(await pendingIds(sid)).toEqual([card.id]);
  expect((await lastUpdate(sid, card.id)).state).toBe('auto');
  const rep = await mcp('/__mcp/setup-report', { session_id: sid, capability: 'git', ok: true, detail: 'connected after all' });
  expect(rep).toMatchObject({ ok: true, closed: true, id: card.id, state: 'done' });
  expect((await lastUpdate(sid, card.id))).toMatchObject({ state: 'done', detail: 'connected after all' });
  expect(await pendingIds(sid)).toEqual([]);

  // Skipped by the human → final: report neither reopens nor pretends.
  const p2 = mcp('/__mcp/setup-request', { session_id: sid, capability: 'whatsapp', why: 'read chats' });
  const c2 = await until(async () => (await setupEvents(sid)).find((e: any) => e.kind === 'setup' && e.capability === 'whatsapp'));
  await api('POST', `/__api/setup/${c2.id}/skip`, {});
  expect((await p2).state).toBe('skipped');
  const r2 = await mcp('/__mcp/setup-report', { session_id: sid, capability: 'whatsapp', ok: true });
  expect(r2).toEqual({ ok: true, closed: false, reason: 'skipped by the human' });
  expect((await lastUpdate(sid, c2.id)).state).toBe('skipped');
  expect(await pendingIds(sid)).toEqual([]);
}, 30000);

test('(6) identity take-over: verify without an email reads the signed-in Google account from the session Chrome profile → done', async () => {
  const sid = await newSession('takeover');
  const pending = mcp('/__mcp/setup-request', { session_id: sid, capability: 'identity', why: 'connect services' });
  const card = await until(async () => (await setupEvents(sid)).find((e: any) => e.kind === 'setup'));
  expect(card.manual.kind).toBe('takeover');
  // Nothing signed in yet → 400, card untouched.
  const nope = await api('POST', '/__api/setup/identity', { action: 'verify', sessionId: sid });
  expect(nope.status).toBe(400);
  expect(nope.json.error).toMatch(/no Google sign-in detected/);
  expect(await pendingIds(sid)).toEqual([card.id]);
  // The human signed in during the take-over: Chrome recorded the account in the profile's Preferences.
  const prof = path.join(dir, 'chrome-sessions', sid, 'Default');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'Preferences'), JSON.stringify({ account_info: [{ email: 'Owner@Example.com', full_name: 'Owner' }] }));
  const ok = await api('POST', '/__api/setup/identity', { action: 'verify', sessionId: sid });
  expect(ok.status).toBe(200);
  expect(ok.json).toMatchObject({ ok: true, email: 'owner@example.com', closed: 1 });
  const r = await pending;
  expect(r.state).toBe('done');
  expect(r.id).toBe(card.id);
  expect((await lastUpdate(sid, card.id)).state).toBe('done');
  expect((await api('GET', '/__api/setup/identity')).json.identity.email).toBe('owner@example.com');
  expect((await audit()).at(-1)).toMatchObject({ capability: 'identity', result: 'done', human: true });
}, 30000);

test('session delete closes its cards for good (timeout, "session deleted")', async () => {
  const sid = await newSession('dies');
  const pending = mcp('/__mcp/setup-request', { session_id: sid, capability: 'git', why: 'push', mode: 'manual' });
  const card = await until(async () => (await setupEvents(sid)).find((e: any) => e.kind === 'setup'));
  await api('DELETE', `/__api/sessions/${sid}`);
  expect((await pending).state).toBe('timeout');
  expect((await api('GET', '/__api/setup/pending')).json.pending.map((p: any) => p.id)).not.toContain(card.id);
  expect((await audit()).at(-1)).toMatchObject({ capability: 'git', result: 'timeout', detail: 'session deleted' });
}, 30000);
