// ENGINE: every spawn-from-agent path (create_session, home, cron, @mention) runs on the agent's engine — isolated host.
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
const session = async (id: string) => (await api('GET', `/__api/sessions/${id}`)).json;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-agent-engine-host-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'cli-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
  // A stand-in for `codex login`: codex prepare() only ever symlinks this file.
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt"}');
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
      ARIGAMI_CODEX_BIN: stub,
      ARIGAMI_CODEX_HOME: codexHome,
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
}, 60_000);

afterAll(() => {
  try {
    host?.kill('SIGKILL');
  } catch {}
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

test('REST: an agent is created with engine codex + a codex model; the record and the list carry it; a bad engine is refused', async () => {
  const bad = await api('POST', '/__api/agents', { name: 'Bad', slug: 'bad', engine: 'gemini' });
  expect(bad.status).toBe(400);
  expect(bad.json.error).toContain('invalid engine');
  const r = await api('POST', '/__api/agents', { name: 'Astra', slug: 'astra', emoji: '🛰️', engine: 'codex', model: 'gpt-6-astra', tools: ['desktop', 'web'] });
  expect(r.status).toBe(201);
  expect(r.json.engine).toBe('codex');
  expect(r.json.model).toBe('gpt-6-astra');
  const list = (await api('GET', '/__api/agents')).json.agents;
  expect(list.find((a: any) => a.slug === 'astra').engine).toBe('codex');
  const p = await api('POST', '/__api/agents', { name: 'Plain', slug: 'plain', model: 'sonnet' });
  expect(p.status).toBe(201);
  expect('engine' in p.json).toBe(false);
});

test('create_session({agent}): the session runs on the agent\'s engine with the agent\'s model; the cockpit\'s "" does not override; an explicit engine does', async () => {
  const a = await api('POST', '/__api/sessions', { agent: 'astra' });
  expect(a.status).toBe(201);
  const s = await session(a.json.id);
  expect(s.engine).toBe('codex');
  expect(s.claude.modelChoice).toBe('gpt-6-astra');
  expect(s.metadata.agent).toBe('astra');

  // '' = the launcher's "default engine" — must not override the agent's.
  const b = await api('POST', '/__api/sessions', { agent: 'astra', engine: '' });
  expect((await session(b.json.id)).engine).toBe('codex');

  const c = await api('POST', '/__api/sessions', { agent: 'astra', engine: 'claude' });
  expect((await session(c.json.id)).engine).toBe('claude');

  const d = await api('POST', '/__api/sessions', { agent: 'plain' });
  expect((await session(d.json.id)).engine).toBe('claude');
  expect((await session(d.json.id)).claude.modelChoice).toBe('sonnet');
});

test('A3 on codex: the agent\'s allowlist becomes $CODEX_HOME/hooks.json for its session (the policy hook, not a refusal)', async () => {
  const a = await api('POST', '/__api/sessions', { agent: 'astra' });
  const s = await session(a.json.id);
  expect(s.claude.state).not.toBe('dead');
  const hooks = path.join(dir, 'codex', a.json.id, 'hooks.json');
  await until(async () => fs.existsSync(hooks), 5000);
  const parsed = JSON.parse(fs.readFileSync(hooks, 'utf8'));
  expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain('policy-hook.js');
});

test('agent home: GET /__api/agents/:slug/home mints the home on the agent\'s engine', async () => {
  const h = await api('GET', '/__api/agents/astra/home');
  expect(h.status).toBeLessThan(300);
  const id = h.json.session?.id || h.json.id || h.json.sessionId;
  expect(id).toBeTruthy();
  const s = await session(id);
  expect(s.engine).toBe('codex');
  expect(s.metadata.agentHome).toBe(true);
});

test('cronjob({agent}): an isolated run born from the agent runs on its engine', async () => {
  const t = await api('POST', '/__api/triggers', {
    type: 'cron',
    name: 'astra-nightly',
    prompt: 'look around',
    schedule: { kind: 'interval', value: '12h' },
    sessionMode: 'isolated',
    agent: 'astra',
  });
  expect(t.status).toBe(201);
  const run = await api('POST', `/__api/triggers/${t.json.id}/run`);
  expect(run.status).toBe(200);
  expect(run.json.sessionId).toBeTruthy();
  const s = await session(run.json.sessionId);
  expect(s.engine).toBe('codex');
  expect(s.claude.modelChoice).toBe('gpt-6-astra');
  expect(s.metadata.agent).toBe('astra');
});

test('@mention / `/as`: a delegated session is born on the agent\'s engine', async () => {
  const from = await api('POST', '/__api/sessions', { title: 'caller' });
  const d = await api('POST', `/__api/sessions/${from.json.id}/delegate`, { agent: 'astra', text: 'check the login page', mode: 'as' });
  expect(d.status).toBe(201);
  expect(d.json.how).toBe('session');
  const s = await session(d.json.target);
  expect(s.engine).toBe('codex');
  expect(s.metadata.agent).toBe('astra');
  expect(s.metadata.delegatedFrom).toBe(from.json.id);
});

test('PATCH engine → null: the agent goes back to the host default for NEW sessions', async () => {
  const up = await api('PATCH', '/__api/agents/astra', { engine: null, model: null });
  expect(up.status).toBe(200);
  expect('engine' in up.json).toBe(false);
  const a = await api('POST', '/__api/sessions', { agent: 'astra' });
  expect((await session(a.json.id)).engine).toBe('claude');
});
