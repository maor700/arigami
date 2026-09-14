// P1-6/P1-3/P2-5: cfg.defaultEngine and the spawn order explicit → agent → parent → default → claude — isolated host.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-default-engine-host-'));
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


test('config: POST /__api/config/default-engine sets it, GET /__api/config shows it, junk falls back to claude', async () => {
  expect((await api('GET', '/__api/config')).json.defaultEngine).toBe('claude');
  const junk = await api('POST', '/__api/config/default-engine', { engine: 'gemini' });
  expect(junk.json.defaultEngine).toBe('claude');
  const r = await api('POST', '/__api/config/default-engine', { engine: 'codex' });
  expect(r.status).toBe(200);
  expect(r.json.defaultEngine).toBe('codex');
  expect((await api('GET', '/__api/config')).json.defaultEngine).toBe('codex');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).defaultEngine).toBe('codex');
});

test('create_session: no engine → the default; explicit claude wins; an agent\'s engine beats the default', async () => {
  const a = await api('POST', '/__api/sessions', { title: 'plain' });
  expect((await session(a.json.id)).engine).toBe('codex');
  const b = await api('POST', '/__api/sessions', { title: 'explicit', engine: 'claude' });
  expect((await session(b.json.id)).engine).toBe('claude');
  await api('POST', '/__api/agents', { name: 'Clawd', slug: 'clawd', engine: 'claude' });
  await api('POST', '/__api/agents', { name: 'Plain', slug: 'plain' });
  const c = await api('POST', '/__api/sessions', { agent: 'clawd' });
  expect((await session(c.json.id)).engine).toBe('claude');
  const d = await api('POST', '/__api/sessions', { agent: 'plain' });
  expect((await session(d.json.id)).engine).toBe('codex');
});

test('children: explicit → agent → parent → default', async () => {
  const parent = (await api('POST', '/__api/sessions', { title: 'claude parent', engine: 'claude' })).json.id;
  const child = async (extra: Record<string, unknown>) => {
    const r = await api('POST', '/__api/sessions', { title: 'kid', kind: 'full', master: parent, worktree: false, ...extra });
    expect(r.status).toBe(201);
    return (await session(r.json.id)).engine;
  };
  expect(await child({})).toBe('claude'); // parent's, not the codex default
  expect(await child({ engine: 'codex' })).toBe('codex');
  await api('PATCH', '/__api/agents/plain', { engine: 'codex' });
  expect(await child({ agent: 'plain' })).toBe('codex'); // agent beats parent
  await api('PATCH', '/__api/agents/plain', { engine: null });
  expect(await child({ agent: 'plain' })).toBe('claude'); // agent without engine → parent
  const top = await api('POST', '/__api/sessions', { title: 'no master', agent: 'plain' });
  expect((await session(top.json.id)).engine).toBe('codex');
});

test('cron: an isolated run takes the trigger\'s engine, else the default; PATCH ignores junk', async () => {
  const mk = async (extra: Record<string, unknown>) => (await api('POST', '/__api/triggers', {
    type: 'cron', name: 'job', prompt: 'tick', schedule: { kind: 'interval', value: '12h' }, sessionMode: 'isolated', ...extra,
  })).json;
  const plain = await mk({});
  expect(plain.engine).toBe('');
  const run = await api('POST', `/__api/triggers/${plain.id}/run`);
  expect((await session(run.json.sessionId)).engine).toBe('codex');
  const pinned = await mk({ engine: 'claude' });
  expect(pinned.engine).toBe('claude');
  expect((await api('PATCH', `/__api/triggers/${pinned.id}`, { engine: 'nonsense' })).json.engine).toBe('claude');
  const run2 = await api('POST', `/__api/triggers/${pinned.id}/run`);
  expect((await session(run2.json.sessionId)).engine).toBe('claude');
  expect((await mk({ engine: 'gpt-9000' })).engine).toBe('');
});

test('brain, PM controller and an agent home without an engine all land on the default', async () => {
  const b = await api('POST', '/__api/brain/session');
  const brainId = b.json.id || b.json.sessionId;
  expect((await session(brainId)).engine).toBe('codex');
  const f = await api('POST', '/__api/folders', { name: 'proj' });
  const pm = await api('POST', `/__api/folders/${f.json.id}/make-project`, {});
  expect(pm.status).toBe(201);
  expect(pm.json.engine).toBe('codex');
  const h = await api('GET', '/__api/agents/plain/home');
  const id = h.json.session?.id || h.json.id || h.json.sessionId;
  expect((await session(id)).engine).toBe('codex');
});
