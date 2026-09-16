// A2 end-to-end against an ISOLATED host (tmp ARIGAMI_DIR, own port, auth off,
// stub claude): a request_setup from a session born from an agent opens a card
// owned by the agent; the manual identity verify from that session lands in
// agents/<slug>/identity.json (the shared identity.json stays absent); the
// agent's connections view resolves agent-first with a shared fallback;
// cron jobs created from an agent session default to the agent and their
// isolated runs are born from it (metadata.agent + color); the routine view
// lists them; save_browser_logins from an agent session syncs into the
// agent's profile and only touches chrome-base with shared:true.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostDiag } from './_host-diag.js';

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
const chat = async (sid: string): Promise<any[]> => (await api('GET', `/__api/sessions/${sid}/chat`)).json;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-A2-host-'));
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
  const c = await api('POST', '/__api/agents', { name: 'Bot', slug: 'bot', emoji: '🤖', persona: 'You post.' });
  expect(c.status).toBe(201);
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

let botSession = '';
let plainSession = '';

test('request_setup from an agent session: card + pending carry owner agent:bot; identity verify from that session writes the AGENT identity only', async () => {
  botSession = (await api('POST', '/__api/sessions', { agent: 'bot', cwd: path.join(dir, 'workspace') })).json.id;
  plainSession = (await api('POST', '/__api/sessions', { title: 'plain', cwd: path.join(dir, 'workspace') })).json.id;
  // request_setup blocks — fire it and inspect the card while it waits.
  const blocked = api('POST', '/__mcp/setup-request', { session_id: botSession, capability: 'identity', why: 'log in as the bot' });
  const pending = await until(async () => {
    const p = (await api('GET', `/__api/setup/pending?session=${botSession}`)).json.pending;
    return p.length ? p[0] : null;
  });
  expect(pending.owner).toBe('agent:bot');
  const card = (await chat(botSession)).find((m: any) => m.kind === 'setup');
  expect(card.owner).toBe('agent:bot');
  expect(card.identity).toBeNull();
  // host-level capability requested from the same session stays global
  const gitBlocked = api('POST', '/__mcp/setup-request', { session_id: botSession, capability: 'git', why: 'push' });
  const gitCard = await until(async () => (await api('GET', `/__api/setup/pending?session=${botSession}`)).json.pending.find((e: any) => e.capability === 'git'));
  expect(gitCard.owner).toBe('global');
  await api('POST', `/__api/setup/${gitCard.id}/skip`, {});
  await gitBlocked;
  // The connect-identity playbook / TakeoverStep verifies with the session id → the agent's identity.
  const v = await api('POST', '/__api/setup/identity', { action: 'verify', email: 'bot@example.com', sessionId: botSession });
  expect(v.status).toBe(200);
  expect(v.json.owner).toBe('agent:bot');
  expect(fs.existsSync(path.join(dir, 'agents', 'bot', 'identity.json'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'identity.json'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'bot', 'identity.json'), 'utf8')).chromeProfile).toBe('agent:bot');
  const done = await blocked;
  expect(done.json.state).toBe('done');
  // the audit line is owned by the agent
  const audit = (await api('GET', '/__api/setup/connections?owner=agent:bot')).json;
  expect(audit.owner).toBe('agent:bot');
  expect(audit.identity.email).toBe('bot@example.com');
  expect(audit.audit.some((e: any) => e.capability === 'identity' && e.result === 'done' && e.owner === 'agent:bot')).toBe(true);
  expect((await api('GET', '/__api/setup/connections?owner=global')).json.audit.every((e: any) => !e.owner)).toBe(true);
});

test('resolution: the agent view resolves agent-first; the global view does not see the agent identity; a second agent falls back to the shared one; disconnect per owner', async () => {
  const bot = (await api('GET', '/__api/agents/bot/connections')).json;
  expect(bot.owner).toBe('agent:bot');
  const id = bot.capabilities.find((c: any) => c.id === 'identity');
  expect([id.ok, id.ownable, id.owner, id.resolvedFrom]).toEqual([true, true, 'agent:bot', 'agent:bot']);
  expect(bot.capabilities.find((c: any) => c.id === 'git').ownable).toBe(false);
  expect(bot.browserProfile).toBe(false);
  const glob = (await api('GET', '/__api/setup/capabilities')).json;
  expect(glob.capabilities.find((c: any) => c.id === 'identity').ok).toBe(false);
  expect(glob.identity).toBeNull();
  expect((await api('GET', '/__api/setup/capabilities?owner=agent:bot')).json.identity.email).toBe('bot@example.com');
  expect((await api('GET', '/__api/setup/capabilities?owner=nonsense')).status).toBe(400);
  // check_setup for the agent → ok with owner
  const chk = (await api('GET', '/__api/setup/capabilities/identity?owner=agent:bot')).json;
  expect(chk.ok).toBe(true);
  expect(chk.owner).toBe('agent:bot');
  expect((await api('GET', '/__api/setup/capabilities/identity')).json.needs_setup).toBe('identity');
  // shared fallback for another agent
  await api('POST', '/__api/agents', { name: 'Other', slug: 'other' });
  await api('POST', '/__api/setup/identity', { action: 'verify', email: 'host@example.com' });
  const other = (await api('GET', '/__api/agents/other/connections')).json.capabilities.find((c: any) => c.id === 'identity');
  expect([other.ok, other.resolvedFrom]).toEqual([true, 'global']);
  expect(other.detail).toMatch(/shared/);
  const botAgain = (await api('GET', '/__api/agents/bot/connections')).json.capabilities.find((c: any) => c.id === 'identity');
  expect(botAgain.resolvedFrom).toBe('agent:bot');
  // DELETE with owner removes only the agent's identity
  const del = await api('DELETE', '/__api/setup/identity?owner=agent:bot');
  expect(del.json.owner).toBe('agent:bot');
  expect(fs.existsSync(path.join(dir, 'agents', 'bot', 'identity.json'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'identity.json'))).toBe(true);
  expect((await api('GET', '/__api/agents/bot/connections')).json.capabilities.find((c: any) => c.id === 'identity').resolvedFrom).toBe('global');
});

test('cron: created from an agent session defaults to the agent; explicit "" = none; unknown → 400; routine lists it; run now is born from the agent', async () => {
  const c = await api('POST', '/__api/triggers', { type: 'cron', name: 'daily post', prompt: 'post something', schedule: { kind: 'interval', value: '1d' }, autonomous: true, createdBySessionId: botSession });
  expect(c.status).toBe(201);
  expect(c.json.agent).toBe('bot');
  const none = await api('POST', '/__api/triggers', { type: 'cron', name: 'plain', prompt: 'x', schedule: { kind: 'interval', value: '1d' }, agent: '', createdBySessionId: botSession });
  expect(none.json.agent).toBeUndefined();
  expect((await api('POST', '/__api/triggers', { type: 'cron', name: 'bad', prompt: 'x', schedule: { kind: 'interval', value: '1d' }, agent: 'ghost' })).status).toBe(400);
  const explicit = await api('POST', '/__api/triggers', { type: 'cron', name: 'from plain', prompt: 'x', schedule: { kind: 'interval', value: '2h' }, agent: 'bot', createdBySessionId: plainSession });
  expect(explicit.json.agent).toBe('bot');
  const routine = (await api('GET', '/__api/agents/bot/routine')).json;
  expect(routine.cron.map((t: any) => t.name).sort()).toEqual(['daily post', 'from plain']);
  expect(typeof routine.cron[0].nextRunAt).toBe('number');
  expect(routine.listeners).toEqual([]);
  expect((await api('GET', '/__api/agents/other/routine')).json.cron).toEqual([]);
  // GET /__api/triggers carries agent (the Rail's next-cron dot reads it)
  expect((await api('GET', '/__api/triggers')).json.find((t: any) => t.id === c.json.id).agent).toBe('bot');
  // run now → the isolated session is born from the agent (same path as create_session({agent}))
  const run = await api('POST', `/__api/triggers/${c.json.id}/run`, {});
  expect(run.json.ok).toBe(true);
  const s = (await api('GET', `/__api/sessions/${run.json.sessionId}`)).json;
  expect(s.metadata.agent).toBe('bot');
  expect(s.metadata.cronTriggerId).toBe(c.json.id);
  expect(s.color).toBe((await api('GET', '/__api/agents/bot')).json.color);
  expect(s.claude?.permissionMode ?? s.permissionMode).toBe('bypassPermissions');
  // a session spawned by a cron run still cannot create cron jobs (guard kept)
  expect((await api('POST', '/__api/triggers', { type: 'cron', name: 'loop', prompt: 'x', schedule: { kind: 'interval', value: '1d' }, createdBySessionId: run.json.sessionId })).status).toBe(400);
  // disable / delete through the existing trigger routes
  expect((await api('PATCH', `/__api/triggers/${c.json.id}`, { enabled: false })).json.enabled).toBe(false);
  expect((await api('DELETE', `/__api/triggers/${c.json.id}`)).status).toBe(200);
  expect((await api('GET', '/__api/agents/bot/routine')).json.cron.map((t: any) => t.name)).toEqual(['from plain']);
});

test('save_browser_logins from an agent session → the agent profile; shared:true → chrome-base too', async () => {
  const prof = path.join(dir, 'chrome-sessions', botSession, 'Default');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'Cookies'), 'bot-cookies');
  const r1 = (await api('POST', `/__api/sessions/${botSession}/browser/sync-logins`, {})).json;
  expect(r1).toEqual({ ok: true, synced: ['Default/Cookies'], targets: ['agent:bot'] });
  expect(fs.readFileSync(path.join(dir, 'agents', 'bot', 'browser', 'Default', 'Cookies'), 'utf8')).toBe('bot-cookies');
  expect(fs.existsSync(path.join(dir, 'chrome-base', 'Default', 'Cookies'))).toBe(false);
  expect((await api('GET', '/__api/agents/bot/connections')).json.browserProfile).toBe(true);
  const r2 = (await api('POST', `/__api/sessions/${botSession}/browser/sync-logins`, { shared: true })).json;
  expect(r2.targets).toEqual(['agent:bot', 'global']);
  expect(fs.readFileSync(path.join(dir, 'chrome-base', 'Default', 'Cookies'), 'utf8')).toBe('bot-cookies');
  // a plain session's sync stays global-only (unchanged behaviour)
  const pprof = path.join(dir, 'chrome-sessions', plainSession, 'Default');
  fs.mkdirSync(pprof, { recursive: true });
  fs.writeFileSync(path.join(pprof, 'Cookies'), 'plain-cookies');
  expect((await api('POST', `/__api/sessions/${plainSession}/browser/sync-logins`, {})).json.targets).toEqual(['global']);
  expect(fs.readFileSync(path.join(dir, 'agents', 'bot', 'browser', 'Default', 'Cookies'), 'utf8')).toBe('bot-cookies');
});
