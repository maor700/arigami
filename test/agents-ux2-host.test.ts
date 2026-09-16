// UX2 end-to-end against an ISOLATED host (tmp ARIGAMI_DIR, own port, auth off,
// stub claude): "Adopt agent" — POST /sessions/:id/adopt-agent sets metadata.agent
// (+ a {kind:'agent-adopt'} receipt) so A3's per-turn policy/budget checks pick
// up the adopted agent from the very next spawn; a spent budget refuses the
// adoption itself (429, session untouched); .../adopt-agent/revert restores
// whatever agent (or none) ran the session before.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-UX2-host-'));
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

let plainId: string;

test('adopt-agent: a plain session takes on an agent — metadata.agent set, receipt in chat, color follows', async () => {
  expect((await api('POST', '/__api/agents', { name: 'Coach', slug: 'coach', emoji: '🏐', color: '#1F9C82', persona: 'You coach the team.' })).status).toBe(201);
  plainId = (await api('POST', '/__api/sessions', { title: 'scratch' })).json.id;
  expect((await session(plainId)).metadata?.agent).toBeUndefined();

  const r = await api('POST', `/__api/sessions/${plainId}/adopt-agent`, { agent: 'coach' });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.agent.slug).toBe('coach');

  const s = await session(plainId);
  expect(s.metadata.agent).toBe('coach');
  expect(s.metadata.adoptedFrom ?? null).toBe(null);
  expect(s.color).toBe('#1F9C82');

  const receipt = await until(async () => (await chat(plainId)).find((e) => e.kind === 'agent-adopt' && !e.reverted));
  expect(receipt.agent).toMatchObject({ slug: 'coach', name: 'Coach', emoji: '🏐' });
  expect(receipt.prevAgent ?? null).toBe(null);
  // the model's own context gets told, too — a queued/sent [host] line carrying the persona
  await until(async () => {
    const c = await chat(plainId);
    const s2 = await session(plainId);
    const has = (t: string) => String(t || '').includes('Coach') && String(t || '').includes('adopted');
    return c.some((e) => e.kind === 'user' && has(e.text)) || (s2.pendingPrompts || []).some((p: any) => has(p.text || p));
  });
});

test('adopt-agent: 404 unknown agent / unknown session', async () => {
  expect((await api('POST', `/__api/sessions/${plainId}/adopt-agent`, { agent: 'nope' })).status).toBe(404);
  expect((await api('POST', `/__api/sessions/nope/adopt-agent`, { agent: 'coach' })).status).toBe(404);
});

test('adopt-agent: a spent daily budget refuses the adoption (429) and leaves the session untouched', async () => {
  expect((await api('POST', '/__api/agents', { name: 'Tight', slug: 'tight', budget: { tokensPerDay: 1 } })).status).toBe(201);
  fs.mkdirSync(path.join(dir, 'agents', 'tight'), { recursive: true });
  fs.appendFileSync(path.join(dir, 'agents', 'tight', 'activity.jsonl'), JSON.stringify({ kind: 'turn', ts: new Date().toISOString(), sessionId: 'x', tokens: 5 }) + '\n');
  const r = await api('POST', `/__api/sessions/${plainId}/adopt-agent`, { agent: 'tight' });
  expect(r.status).toBe(429);
  expect(r.json.budget).toBeTruthy();
  // still adopted as "coach" from the earlier test — the failed adoption didn't touch it
  expect((await session(plainId)).metadata.agent).toBe('coach');
});

test('adopt-agent/revert: back to whatever ran before — none, here — and a reverted receipt', async () => {
  const r = await api('POST', `/__api/sessions/${plainId}/adopt-agent/revert`, {});
  expect(r.status).toBe(200);
  const s = await session(plainId);
  expect(s.metadata?.agent).toBeFalsy();
  expect(s.metadata?.adoptedFrom).toBeFalsy();
  const receipt = await until(async () => (await chat(plainId)).find((e) => e.kind === 'agent-adopt' && e.reverted));
  expect(receipt.agent).toBeFalsy();
});

test('adopt-agent: adopting a second agent remembers the first — revert is one step back, not "never adopted"', async () => {
  await api('POST', '/__api/agents', { name: 'Nili', slug: 'nili-ux2', persona: 'gardener' });
  await api('POST', `/__api/sessions/${plainId}/adopt-agent`, { agent: 'coach' });
  const r = await api('POST', `/__api/sessions/${plainId}/adopt-agent`, { agent: 'nili-ux2' });
  expect(r.status).toBe(200);
  expect((await session(plainId)).metadata.agent).toBe('nili-ux2');
  await api('POST', `/__api/sessions/${plainId}/adopt-agent/revert`, {});
  expect((await session(plainId)).metadata.agent).toBe('coach');
});
