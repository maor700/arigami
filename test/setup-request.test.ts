// S1 — request_setup state machine end-to-end against an ISOLATED host
// (fresh tmp ARIGAMI_DIR, its own port, auth off, fake claude, no desktop,
// 2 s setup timeout). Covers: done via manual payload, skip, timeout, auto →
// report ok/fail → manual hand-off, already-connected short-circuit, mode
// switch unblocking the agent, needs_setup wrappers, identity/audit/funnel files.
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

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: { raw: text } };
  }
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
const readJsonl = (f: string): any[] =>
  fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-S1-host-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  // A `claude` that stays alive: the host expires a session's open cards the
  // moment its claude exits, so an instantly-exiting fake would turn every
  // request into "timeout" (which is exactly the death path tested last).
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
      ARIGAMI_SETUP_TIMEOUT_MS: '2000',
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
        return (await fetch(base + '/__api/config')).ok;
      } catch {
        return false;
      }
    }, 30000);
  } catch (e) {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
});

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

async function newSession(title: string): Promise<string> {
  const r = await api('POST', '/__api/sessions', { title, cwd: path.join(dir, 'workspace') });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

test('host start: workspace cwd created; capabilities listed; nothing pending', async () => {
  expect(fs.existsSync(path.join(dir, 'workspace'))).toBe(true);
  const r = await api('GET', '/__api/setup/capabilities');
  expect(r.status).toBe(200);
  expect(r.json.identity).toBeNull();
  const ids = r.json.capabilities.map((c: any) => c.id);
  for (const id of ['identity', 'claude', 'git', 'whatsapp', 'desktop', 'push', 'remote', 'telemetry', 'composio:gmail']) expect(ids).toContain(id);
  const desktop = r.json.capabilities.find((c: any) => c.id === 'desktop');
  expect(desktop.ok).toBe(false);
  expect(desktop.manual.kind).toBe('toggle');
  expect(desktop.defaultMode).toBe('manual');
  expect((await api('GET', '/__api/setup/pending')).json.pending).toEqual([]);
});

test('needs_setup wrappers: missing repo cwd, whatsapp listener, screen request, screenshot, check_setup', async () => {
  const r1 = await api('POST', '/__api/sessions', { title: 'x', cwd: path.join(dir, 'nope', 'my-app') });
  expect(r1.status).toBe(200);
  expect(r1.json).toEqual({ needs_setup: 'repo:my-app', why: `open a session in ${path.join(dir, 'nope', 'my-app')}`, hint: 'call request_setup' });

  const sid = await newSession('wrappers');
  const r2 = await api('POST', `/__api/sessions/${sid}/listeners`, { type: 'whatsapp' });
  expect(r2.status).toBe(200);
  expect(r2.json.needs_setup).toBe('whatsapp');
  expect(r2.json.hint).toBe('call request_setup');

  const r3 = await api('POST', '/__mcp/screen-request', { session_id: sid, prompt: 'log in' });
  expect(r3.status).toBe(200);
  expect(r3.json.needs_setup).toBe('desktop');

  const r4 = await api('POST', `/__api/sessions/${sid}/screenshot`, {});
  expect(r4.json.needs_setup).toBe('desktop');
  expect(r4.json.ok).toBe(false);

  const r5 = await api('GET', '/__api/setup/capabilities/composio:gmail?why=read%20inbox');
  expect(r5.json).toEqual({ needs_setup: 'composio:gmail', why: 'read inbox', hint: 'call request_setup' });
  expect((await api('GET', '/__api/setup/capabilities/bogus')).status).toBe(400);
});

test('manual: request_setup blocks, card posted, human POSTs the payload → agent gets done; audit + funnel + identity', async () => {
  const sid = await newSession('manual');
  const pending = mcp('/__mcp/setup-request', { session_id: sid, capability: 'identity', why: 'connect services for you' });
  const card = await until(async () => (await setupEvents(sid)).find((e: any) => e.kind === 'setup'));
  expect(card.capability).toBe('identity');
  expect(card.mode).toBe('manual');
  expect(card.state).toBe('pending');
  expect(card.why).toBe('connect services for you');
  expect(card.evidence).toBeNull();
  expect(card.manual.kind).toBe('takeover');
  expect(card.identity).toBe(false);
  expect(card.id).toMatch(/^setup_/);
  const s = (await api('GET', `/__api/sessions/${sid}`)).json;
  expect(s.claude.state).toBe('awaiting-input');
  expect(s.claude.setupRequest).toEqual({ id: card.id, capability: 'identity' });
  expect((await api('GET', `/__api/setup/pending?session=${sid}`)).json.pending.map((p: any) => p.id)).toEqual([card.id]);

  // The connect-identity skill (or the human) lands the identity through the manual route.
  const done = await api('POST', '/__api/setup/identity', { email: 'Someone@Example.com' });
  expect(done.status).toBe(200);
  expect(done.json.ok).toBe(true);
  expect(done.json.status.ok).toBe(true);
  expect(done.json.closed).toBe(1);
  expect(done.json.identity.email).toBe('someone@example.com');

  const result = await pending;
  expect(result.state).toBe('done');
  expect(result.id).toBe(card.id);
  expect(result.capability).toBe('identity');
  expect(result.mode).toBe('manual');
  const upd = (await setupEvents(sid)).filter((e: any) => e.kind === 'setup-update');
  expect(upd.at(-1).state).toBe('done');
  expect(upd.at(-1).id).toBe(card.id);
  expect((await api('GET', `/__api/sessions/${sid}`)).json.claude.setupRequest).toBeNull();

  expect((await api('GET', '/__api/setup/identity')).json.identity.email).toBe('someone@example.com');
  const audit = (await api('GET', '/__api/setup/connections')).json.audit;
  expect(audit.map((a: any) => [a.capability, a.result, a.human])).toEqual([
    ['identity', 'requested', false],
    ['identity', 'done', true],
  ]);
  const funnel = readJsonl(path.join(dir, 'funnel.jsonl')).map((e) => e.name);
  expect(funnel).toContain('setup.requested');
  expect(funnel).toContain('setup.completed');
  expect(funnel).toContain('setup.first_request');
  // Already connected now → immediate, no new card.
  const again = await mcp('/__mcp/setup-request', { session_id: sid, capability: 'identity', why: 'x' });
  expect(again).toMatchObject({ state: 'done', already: true, capability: 'identity' });
  expect((await setupEvents(sid)).filter((e: any) => e.kind === 'setup').length).toBe(1);
});

test('skip: human clicks "not now" → agent gets skipped; funnel setup.skipped', async () => {
  const sid = await newSession('skip');
  const pending = mcp('/__mcp/setup-request', { session_id: sid, capability: 'whatsapp', why: 'send a message', mode: 'auto' });
  const card = await until(async () => (await setupEvents(sid)).find((e: any) => e.kind === 'setup'));
  expect(card.mode).toBe('manual'); // auto requested but whatsapp is not autoCapable
  expect(card.manual.kind).toBe('qr');
  const sk = await api('POST', `/__api/setup/${card.id}/skip`, { note: 'later' });
  expect(sk.json).toEqual({ ok: true, id: card.id, state: 'skipped' });
  const result = await pending;
  expect(result.state).toBe('skipped');
  expect(result.detail).toBe('later');
  expect((await api('POST', `/__api/setup/${card.id}/skip`, {})).status).toBe(404);
  const funnel = readJsonl(path.join(dir, 'funnel.jsonl')).filter((e) => e.name === 'setup.skipped');
  expect(funnel.at(-1)).toMatchObject({ capability: 'whatsapp', mode: 'manual' });
});

test('timeout: nobody answers → state timeout after ARIGAMI_SETUP_TIMEOUT_MS; card updated', async () => {
  const sid = await newSession('timeout');
  const t0 = Date.now();
  const result = await mcp('/__mcp/setup-request', { session_id: sid, capability: 'git', why: 'push a branch', mode: 'manual' });
  expect(result.state).toBe('timeout');
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
  expect(Date.now() - t0).toBeLessThan(8000);
  const last = (await setupEvents(sid)).at(-1);
  expect(last.kind).toBe('setup-update');
  expect(last.state).toBe('timeout');
  expect((await api('GET', `/__api/setup/pending?session=${sid}`)).json.pending).toEqual([]);
});

test('auto: identity present + autoCapable → returns auto immediately; report fail → manual; re-request attaches; report ok w/ evidence → done', async () => {
  const sid = await newSession('auto');
  const caps = (await api('GET', '/__api/setup/capabilities')).json;
  expect(caps.identity.email).toBe('someone@example.com');
  expect(caps.capabilities.find((c: any) => c.id === 'composio:gmail').defaultMode).toBe('auto');

  const r = await mcp('/__mcp/setup-request', { session_id: sid, capability: 'composio:gmail', why: 'read your inbox' });
  expect(r.state).toBe('auto');
  expect(r.mode).toBe('auto');
  expect(r.playbook).toBe('connect-composio');
  expect(r.id).toMatch(/^setup_/);
  const card = (await setupEvents(sid)).find((e: any) => e.kind === 'setup');
  expect(card.state).toBe('auto');
  expect(card.identity).toBe(true);
  expect((await api('GET', `/__api/sessions/${sid}`)).json.claude.state).not.toBe('awaiting-input');

  // Playbook failed → card flips to manual with the reason (rule 5).
  const fail = await mcp('/__mcp/setup-report', { session_id: sid, capability: 'composio:gmail', ok: false, detail: 'consent screen asked for 2FA' });
  expect(fail).toMatchObject({ ok: true, closed: false, id: r.id, state: 'pending', mode: 'manual' });
  const flipped = (await setupEvents(sid)).at(-1);
  expect(flipped).toMatchObject({ kind: 'setup-update', id: r.id, mode: 'manual', state: 'pending', detail: 'consent screen asked for 2FA', failed: true });

  // Agent waits for the human on the SAME card; the human switches it back to auto → agent unblocked with state:auto.
  const wait = mcp('/__mcp/setup-request', { session_id: sid, capability: 'composio:gmail', why: 'read your inbox' });
  await until(async () => (await api('GET', `/__api/sessions/${sid}`)).json.claude.setupRequest?.id === r.id);
  expect((await setupEvents(sid)).filter((e: any) => e.kind === 'setup').length).toBe(1);
  const sw = await api('POST', `/__api/setup/${r.id}/mode`, { mode: 'auto' });
  expect(sw.json).toMatchObject({ ok: true, id: r.id, mode: 'auto', state: 'auto' });
  const w = await wait;
  expect(w).toMatchObject({ state: 'auto', id: r.id, playbook: 'connect-composio' });

  // Second attempt succeeds, with a screenshot as evidence.
  const ok = await mcp('/__mcp/setup-report', { session_id: sid, capability: 'composio:gmail', ok: true, evidence: '/__artifacts/abc123', detail: 'gmail ACTIVE' });
  expect(ok).toMatchObject({ ok: true, closed: true, id: r.id, state: 'done' });
  const last = (await setupEvents(sid)).at(-1);
  expect(last).toMatchObject({ kind: 'setup-update', id: r.id, state: 'done', evidence: '/__artifacts/abc123/', detail: 'gmail ACTIVE' });
  const ident = (await api('GET', '/__api/setup/identity')).json.identity;
  expect(ident.providers['composio:gmail'].at).toBeTruthy();
  const audit = readJsonl(path.join(dir, 'connections.log')).filter((a) => a.capability === 'composio:gmail');
  expect(audit.map((a) => a.result)).toEqual(['requested', 'failed', 'done']);
  expect(audit.at(-1)).toMatchObject({ sessionId: sid, mode: 'auto', evidence: '/__artifacts/abc123/', human: false });
  // Nothing open → a stray report is just audited.
  expect(await mcp('/__mcp/setup-report', { session_id: sid, capability: 'composio:gmail', ok: true })).toEqual({ ok: true, closed: false });
});

test('mode switch manual→auto is refused for non-auto capabilities; bad ids/sessions are 400/404', async () => {
  const sid = await newSession('misc');
  const pending = mcp('/__mcp/setup-request', { session_id: sid, capability: 'push', why: 'buzz you' });
  const card = await until(async () => (await setupEvents(sid)).find((e: any) => e.kind === 'setup'));
  const sw = await api('POST', `/__api/setup/${card.id}/mode`, { mode: 'auto' });
  expect(sw.json.mode).toBe('manual');
  await api('POST', `/__api/setup/${card.id}/skip`, {});
  expect((await pending).state).toBe('skipped');
  expect((await api('POST', '/__mcp/setup-request', { session_id: sid, capability: 'nope', why: 'x' })).status).toBe(400);
  expect((await api('POST', '/__mcp/setup-request', { session_id: 'sess_missing', capability: 'git', why: 'x' })).status).toBe(400);
  expect((await api('POST', '/__api/setup/setup_missing/skip', {})).status).toBe(404);
  expect((await api('POST', '/__api/setup/bogus', {})).status).toBe(400);
});

test('session death expires its open setup cards (timeout, "session ended")', async () => {
  const sid = await newSession('dies');
  const pending = mcp('/__mcp/setup-request', { session_id: sid, capability: 'git', why: 'push a branch', mode: 'manual' });
  await until(async () => (await setupEvents(sid)).find((e: any) => e.kind === 'setup'));
  await api('DELETE', `/__api/sessions/${sid}`);
  const r = await pending;
  expect(r.state).toBe('timeout');
});

test('identity disconnect: DELETE clears the file, audits, and flips defaultMode back to manual', async () => {
  const d = await api('DELETE', '/__api/setup/identity');
  expect(d.json).toEqual({ ok: true, identity: null });
  expect((await api('GET', '/__api/setup/identity')).json.identity).toBeNull();
  const caps = (await api('GET', '/__api/setup/capabilities')).json;
  expect(caps.capabilities.find((c: any) => c.id === 'composio:gmail').defaultMode).toBe('manual');
  const audit = (await api('GET', '/__api/setup/connections')).json.audit;
  expect(audit.at(-1)).toMatchObject({ capability: 'identity', result: 'disconnected', human: true });
});

test('wizard: minimal mode by default, mode route flips to full and back', async () => {
  const w = (await api('GET', '/__api/onboarding/wizard')).json;
  expect(w.mode).toBe('minimal');
  expect(w.required).toEqual(['pair', 'claude']);
  const full = (await api('POST', '/__api/onboarding/wizard/mode', { mode: 'full' })).json;
  expect(full.mode).toBe('full');
  expect(full.required.length).toBe(8);
  const back = (await api('POST', '/__api/onboarding/wizard/mode', { mode: 'minimal' })).json;
  expect(back.mode).toBe('minimal');
});
