// A4 end-to-end against an ISOLATED host (tmp ARIGAMI_DIR, own port, auth off,
// stub claude): GET /__api/skills carries `slash` (/plan → dispatch, /review →
// explain-changes); POST /sessions/:id/delegate routes an @mention from a
// normal chat to the agent's home chat, from a project controller to a child
// born from the agent, and `/as` to a one-off session — each with a
// {kind:'delegated'} receipt in the caller's chat; POST /sessions/:id/agent-card
// opens the create-agent card (placeholder name, 409 on a clash); the profiles
// REST applies a bundle's agents (existing agent untouched, force updates).
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
const session = async (sid: string): Promise<any> => (await api('GET', `/__api/sessions/${sid}`)).json;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-A4-host-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
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
  let err = '';
  host.stderr!.on('data', (d) => (err += d));
  await until(async () => {
    try {
      const r = await fetch(base + '/__api/agents');
      return r.ok;
    } catch {
      return false;
    }
  }, 30000).catch(() => {
    throw new Error('host did not start: ' + err.slice(-2000));
  });
}, 40000);

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /__api/skills carries the slash field: /plan → dispatch, /review → explain-changes', async () => {
  const r = await api('GET', '/__api/skills');
  expect(r.status).toBe(200);
  const by = Object.fromEntries(r.json.skills.map((s: any) => [s.name, s]));
  expect(by.dispatch.slash).toBe('plan');
  expect(by['explain-changes'].slash).toBe('review');
  expect(by.onboarding.slash).toBe('');
  const slashes = r.json.skills.map((s: any) => s.slash).filter(Boolean);
  expect(new Set(slashes).size).toBe(slashes.length); // no two shipped skills claim one slash
});

let normalId: string;
let pmId: string;

test('@mention from a NORMAL chat → the agent home chat gets the text; receipt line in the caller', async () => {
  expect((await api('POST', '/__api/agents', { name: 'Mila', slug: 'mila', emoji: '✍️', persona: 'You are Mila.' })).status).toBe(201);
  normalId = (await api('POST', '/__api/sessions', { title: 'my chat' })).json.id;
  const r = await api('POST', `/__api/sessions/${normalId}/delegate`, { agent: 'mila', text: 'write the launch email' });
  expect(r.status).toBe(201);
  expect(r.json.how).toBe('home');
  expect(['now', 'queued']).toContain(r.json.delivered);
  expect(r.json.url).toMatch(/#\/session\//);
  const home = (await api('GET', '/__api/agents/mila/home')).json;
  expect(home.created).toBe(false); // delegate created it
  expect(home.session.id).toBe(r.json.target);
  expect(home.session.metadata.agent).toBe('mila');
  const receipt = await until(async () => (await chat(normalId)).find((e) => e.kind === 'delegated'));
  expect(receipt.agent).toMatchObject({ slug: 'mila', name: 'Mila', emoji: '✍️' });
  expect(receipt.target).toBe(home.session.id);
  expect(receipt.how).toBe('home');
  expect(receipt.mode).toBe('mention');
  expect(receipt.text).toBe('write the launch email');
  // the text reached the home chat (as a user message or its pending queue)
  await until(async () => {
    const c = await chat(home.session.id);
    const s = await session(home.session.id);
    return c.some((e) => e.kind === 'user' && String(e.text || '').includes('write the launch email')) || (s.pendingPrompts || []).some((p: any) => String(p.text || p).includes('write the launch email'));
  });
});

test('@mention from a PROJECT CONTROLLER → a full child born from the agent, in its folder, tasked with the text', async () => {
  pmId = (await api('POST', '/__api/sessions', { title: 'pm' })).json.id;
  // spawning a full child makes the session a project-folder controller
  const first = await api('POST', '/__api/sessions', { master: pmId, kind: 'full', title: 'first child' });
  expect(first.status).toBe(201);
  const pm = await session(pmId);
  expect(pm.folderId).toBeTruthy();
  const folder = (await api('GET', '/__api/folders')).json.find((f: any) => f.id === pm.folderId);
  expect(folder.controllerSessionId).toBe(pmId);

  const r = await api('POST', `/__api/sessions/${pmId}/delegate`, { agent: 'mila', text: 'draft three subject lines for the launch' });
  expect(r.status).toBe(201);
  expect(r.json.how).toBe('child');
  const child = await session(r.json.target);
  expect(child.metadata.agent).toBe('mila');
  expect(child.metadata.role).toBe('child');
  expect(child.metadata.kind).toBe('full');
  expect(child.metadata.master).toBe(pmId);
  expect(child.metadata.delegatedFrom).toBe(pmId);
  expect(child.folderId).toBe(pm.folderId);
  expect(child.title).toMatch(/^Mila: draft three subject lines/);
  expect(child.id).not.toBe((await api('GET', '/__api/agents/mila/home')).json.session.id);
  const receipt = await until(async () => (await chat(pmId)).find((e) => e.kind === 'delegated' && e.target === child.id));
  expect(receipt.how).toBe('child');
  await until(async () => (await chat(child.id)).some((e) => e.kind === 'user' && String(e.text || '').includes('[Task from your project controller') && String(e.text || '').includes('draft three subject lines')));
});

test('/as <agent> <text> from a normal chat → a one-off session born from the agent (not the home chat)', async () => {
  const r = await api('POST', `/__api/sessions/${normalId}/delegate`, { agent: 'Mila', text: 'summarize the brief', mode: 'as' });
  expect(r.status).toBe(404); // by slug, never by display name — the composer resolves names
  const ok = await api('POST', `/__api/sessions/${normalId}/delegate`, { agent: 'mila', text: 'summarize the brief', mode: 'as' });
  expect(ok.status).toBe(201);
  expect(ok.json.how).toBe('session');
  const s = await session(ok.json.target);
  expect(s.metadata.agent).toBe('mila');
  expect(s.metadata.role).toBeUndefined();
  expect(s.metadata.delegatedFrom).toBe(normalId);
  expect(s.title).toBe('Mila: summarize the brief');
  expect(s.id).not.toBe((await api('GET', '/__api/agents/mila/home')).json.session.id);
  await until(async () => (await chat(s.id)).some((e) => e.kind === 'user' && String(e.text || '') === 'summarize the brief'));
  const receipts = (await chat(normalId)).filter((e) => e.kind === 'delegated');
  expect(receipts.map((e) => e.mode)).toEqual(['mention', 'as']);
});

test('delegate: unknown agent → 404, empty text → 400, spent budget → 429', async () => {
  expect((await api('POST', `/__api/sessions/${normalId}/delegate`, { agent: 'ghost', text: 'x' })).status).toBe(404);
  expect((await api('POST', `/__api/sessions/${normalId}/delegate`, { agent: 'mila', text: '   ' })).status).toBe(400);
  expect((await api('POST', `/__api/sessions/${normalId}/delegate`, { text: 'x' })).status).toBe(400);
  // a 1-token/day cap with a used turn ⇒ no new sessions
  expect((await api('POST', '/__api/agents', { name: 'Tight', slug: 'tight', budget: { tokensPerDay: 1 } })).status).toBe(201);
  fs.mkdirSync(path.join(dir, 'agents', 'tight'), { recursive: true });
  fs.appendFileSync(path.join(dir, 'agents', 'tight', 'activity.jsonl'), JSON.stringify({ kind: 'turn', ts: new Date().toISOString(), sessionId: 'x', tokens: 5 }) + '\n');
  const r = await api('POST', `/__api/sessions/${normalId}/delegate`, { agent: 'tight', text: 'go', mode: 'as' });
  expect(r.status).toBe(429);
});

test('POST /sessions/:id/agent-card opens a pending create card (placeholder name when none); 409 on an existing slug', async () => {
  const r = await api('POST', `/__api/sessions/${normalId}/agent-card`, { name: '' });
  expect(r.status).toBe(201);
  expect(r.json.slug).toBe('new-agent');
  const card = await until(async () => (await chat(normalId)).find((e) => e.kind === 'agent-card' && e.cardId === r.json.cardId));
  expect(card.state).toBe('pending');
  expect(card.action).toBe('create');
  expect(card.draft.name).toBe('New agent');
  const named = await api('POST', `/__api/sessions/${normalId}/agent-card`, { name: 'Jord' });
  expect(named.status).toBe(201);
  expect(named.json.slug).toBe('jord');
  expect((await api('POST', `/__api/sessions/${normalId}/agent-card`, { name: 'Mila' })).status).toBe(409);
  // cancelling the placeholder card leaves no agent behind
  expect((await api('POST', `/__api/agents/cards/${r.json.cardId}/cancel`, { sessionId: normalId })).status).toBeLessThan(500);
  expect((await api('GET', '/__api/agents/new-agent')).status).toBe(404);
});

test('POST /__api/profiles/apply with agents: created / unchanged (existing agent kept) / force → updated; cron born from awesome', async () => {
  const r = await api('POST', '/__api/profiles/apply', { source: 'marketing-team' });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  const st = Object.fromEntries(r.json.report.agents.map((a: any) => [a.slug, a.status]));
  expect(st).toEqual({ awesome: 'created', fibi: 'created', jord: 'created', mila: 'unchanged', reachard: 'created', richi: 'created' });
  const mila = (await api('GET', '/__api/agents/mila')).json;
  expect(mila.persona).toBe('You are Mila.'); // the host's Mila, not the bundle's
  const awesome = (await api('GET', '/__api/agents/awesome')).json;
  expect(awesome.skills).toEqual(['campaign-brief', 'project-manager']);
  expect(awesome.tools).toEqual(['sessions', 'triggers']);
  const trig = (await api('GET', '/__api/triggers')).json;
  const list = Array.isArray(trig) ? trig : trig.triggers;
  const cron = list.find((t: any) => t.bundleKey === 'marketing-team/weekly-plan');
  expect(cron.agent).toBe('awesome');
  expect(cron.enabled).toBe(false);
  const f = await api('POST', '/__api/profiles/apply', { source: 'marketing-team', force: true });
  expect(f.json.report.agents.find((a: any) => a.slug === 'mila').status).toBe('updated');
  expect((await api('GET', '/__api/agents/mila')).json.persona).toContain('You are Mila, the copywriter');
  // the rail's team list now has the whole team
  const team = (await api('GET', '/__api/agents')).json.agents.map((a: any) => a.slug);
  for (const s of ['awesome', 'fibi', 'jord', 'mila', 'reachard', 'richi']) expect(team).toContain(s);
});
