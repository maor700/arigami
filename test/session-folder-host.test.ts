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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-folder-host-'));
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

test('REST launches, pending items, cron and listeners carry folder settings', async () => {
  const created = (await api('POST', '/__api/sessions', { title: 'Launch', folderName: '  Operations  ' })).json;
  expect(created.folderId).toBeTruthy();
  const same = (await api('POST', '/__api/sessions', { folderName: 'Operations' })).json;
  expect(same.folderId).toBe(created.folderId);
  const pending = (await api('POST', '/__api/pending', { kind: 'empty', folderName: 'Deferred' })).json;
  expect(pending.folderName).toBe('Deferred');
  const cron = (await api('POST', '/__api/triggers', { type: 'cron', prompt: 'hello', schedule: { kind: 'interval', value: '1h' }, folderName: 'Scheduled' })).json;
  expect(cron.folderName).toBe('Scheduled');
  const fired = await api('POST', `/__api/triggers/${cron.id}/run`, {});
  expect(fired.json.ok).toBe(true);
  const run = await session(fired.json.sessionId);
  const folders = (await api('GET', '/__api/folders')).json;
  expect(folders.find((f: any) => f.id === run.folderId).name).toBe('Scheduled');
  const listener = await api('POST', `/__api/sessions/${created.id}/listeners`, { type: 'sms', folderName: 'Messages' });
  expect(listener.status).toBe(201);
  const moved = await session(created.id);
  expect(moved.folderId).not.toBe(same.folderId);
  expect((await api('GET', `/__api/folders/${moved.folderId}`)).json.name).toBe('Messages');
  const failed = await api('POST', `/__api/sessions/${created.id}/listeners`, { type: 'unknown', folderName: 'Must not exist' });
  expect(failed.status).toBe(400);
  expect((await api('GET', '/__api/folders')).json.some((f: any) => f.name === 'Must not exist')).toBe(false);
});

test('MCP create_session, cronjob and register_listener forward names to the host', async () => {
  const { createArigamiServer } = await import('../mcp/host-mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const me = (await api('POST', '/__api/sessions', { title: 'MCP owner' })).json;
  const server = await createArigamiServer({ ARIGAMI_URL: base, ARIGAMI_SESSION_ID: me.id });
  const client = new Client({ name: 'folder-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).not.toBe(true);
    return JSON.parse((r.content as any)[0].text);
  };
  try {
    const created = await call('create_session', { title: 'MCP child', folder_name: 'MCP work' });
    const child = await session(created.id);
    expect((await api('GET', `/__api/folders/${child.folderId}`)).json.name).toBe('MCP work');
    const cron = await call('cronjob', { action: 'create', prompt: 'hi', schedule_kind: 'interval', schedule_value: '1h', folder_name: 'MCP scheduled' });
    expect(cron.folderName).toBe('MCP scheduled');
    await call('register_listener', { type: 'sms', folder_name: 'MCP messages' });
    const owner = await session(me.id);
    expect((await api('GET', `/__api/folders/${owner.folderId}`)).json.name).toBe('MCP messages');
  } finally {
    await client.close();
    await server.close();
  }
});
