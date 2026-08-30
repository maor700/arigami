// M1 end-to-end against an ISOLATED host (tmp ARIGAMI_DIR, own port, auth off,
// a stub `claude` that writes the same two files the real CLI owns). Covers the
// REST half of the native remote-MCP flow:
//   1. the capability list carries `provider` and lists native cards before the
//      Composio ones; Linear/Notion/GitHub are no longer Composio rows;
//   2. connect (start → paste the redirect URL → poll) for the HOST: the grant
//      is named `linear`, the record lands in mcp-connections.json, the audit
//      line is global, and a disconnect undoes all of it;
//   3. connect for an AGENT: the grant is `linear--<slug>`, the record lands in
//      agents/<slug>/connections.json, the host's own connection is untouched,
//      and the agent's tools allowlist gains `mcp__linear--<slug>__*` so the A3
//      enforcement doesn't hide what was just connected;
//   4. the bearer path (GitHub) needs no browser and refuses without a token;
//   5. an unknown service is a 400, not a half-registered server.
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
let claudeCfg: string;

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
const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));

/** start → paste the redirect URL → poll, i.e. exactly what the card/playbook does. */
async function connect(cap: string, owner?: string): Promise<any> {
  const own = owner ? { owner } : {};
  const start = await api('POST', `/__api/setup/${cap}`, { action: 'start', ...own });
  expect(start.status).toBe(200);
  expect(start.json.url).toContain('https://vendor.example/authorize');
  const paste = await api('POST', `/__api/setup/${cap}`, { action: 'paste', code: 'http://localhost:3118/callback?code=abc&state=xyz', ...own });
  expect(paste.status).toBe(200);
  return until(async () => {
    const r = await api('POST', `/__api/setup/${cap}`, { action: 'poll', ...own });
    return r.json?.ok ? r.json : null;
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-M1-host-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  claudeCfg = path.join(dir, 'claude-config');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(claudeCfg, { recursive: true });
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'off',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: path.join(ROOT, 'test', 'fixtures', 'claude-mcp-stub.sh'),
      CLAUDE_CONFIG_DIR: claudeCfg,
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
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}`);
  }
  // An agent WITH a tools allowlist — the case where a fresh connection would
  // otherwise be denied by A3 for lack of a matching pattern.
  const c = await api('POST', '/__api/agents', { name: 'Sales', slug: 'sales', emoji: '💼', persona: 'You sell.', tools: ['sessions'] });
  expect(c.status).toBe(201);
});

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

test('capabilities carry a provider; native cards come before the Composio grid', async () => {
  const r = await api('GET', '/__api/setup/capabilities');
  expect(r.status).toBe(200);
  const caps = r.json.capabilities as any[];
  expect(caps.every((c) => !!c.provider)).toBe(true);
  const linear = caps.find((c) => c.id === 'mcp:linear');
  expect(linear.provider).toBe('native-mcp');
  expect(linear.ok).toBe(false);
  expect(linear.playbook).toBe('connect-mcp');
  expect(linear.data.tools).toBe('mcp__linear__*');
  // Composio keeps only what has no vendor-hosted server we can use.
  const composio = caps.filter((c) => c.provider === 'composio').map((c) => c.id);
  expect(composio).not.toContain('composio:linear');
  expect(composio).not.toContain('composio:notion');
  expect(composio).not.toContain('composio:github');
  expect(composio).toContain('composio:gmail');
  expect(caps.findIndex((c) => c.id === 'mcp:linear')).toBeLessThan(caps.findIndex((c) => c.id === 'composio:gmail'));
});

test('host connect: grant `linear`, record in mcp-connections.json, audit + disconnect', async () => {
  const done = await connect('mcp:linear');
  expect(done.name).toBe('linear');
  expect(done.connection.cap).toBe('mcp:linear');
  expect(done.connection.url).toBe('https://mcp.linear.app/mcp');

  const rec = readJson(path.join(dir, 'mcp-connections.json'));
  expect(rec).toHaveLength(1);
  expect(rec[0].name).toBe('linear');
  expect(JSON.stringify(rec)).not.toMatch(/accessToken|stub-access/);
  // The grant itself lives in Claude Code's file, keyed by the server name.
  expect(Object.keys(readJson(path.join(claudeCfg, '.credentials.json')).mcpOAuth).some((k) => k.startsWith('linear|'))).toBe(true);

  const st = (await api('GET', '/__api/setup/capabilities')).json.capabilities.find((c: any) => c.id === 'mcp:linear');
  expect(st.ok).toBe(true);
  expect(st.resolvedFrom).toBe('global');

  const off = await api('DELETE', '/__api/setup/mcp:linear');
  expect(off.status).toBe(200);
  expect(off.json.removed).toBe(true);
  expect(off.json.status.ok).toBe(false);
  expect(readJson(path.join(dir, 'mcp-connections.json'))).toEqual([]);
});

test('agent connect: grant `linear--sales`, own record, own tool pattern; the host stays separate', async () => {
  await connect('mcp:linear'); // the host's own grant first — it must not be touched by the agent's
  const done = await connect('mcp:linear', 'agent:sales');
  expect(done.name).toBe('linear--sales');
  expect(done.owner).toBe('agent:sales');
  expect(done.toolsAdded).toBe('mcp__linear--sales__*');

  const agentRec = readJson(path.join(dir, 'agents', 'sales', 'connections.json'));
  expect(agentRec.map((c: any) => c.name)).toEqual(['linear--sales']);
  expect(readJson(path.join(dir, 'mcp-connections.json')).map((c: any) => c.name)).toEqual(['linear']);
  // Two names, two grants, one URL — that is what makes per-agent identity work.
  const keys = Object.keys(readJson(path.join(claudeCfg, '.credentials.json')).mcpOAuth);
  expect(keys.some((k) => k.startsWith('linear|'))).toBe(true);
  expect(keys.some((k) => k.startsWith('linear--sales|'))).toBe(true);

  // A3: the agent can actually use what was just connected.
  expect((await api('GET', '/__api/agents/sales')).json.tools).toContain('mcp__linear--sales__*');

  const agentView = (await api('GET', '/__api/setup/capabilities?owner=agent:sales')).json.capabilities.find((c: any) => c.id === 'mcp:linear');
  expect(agentView.ok).toBe(true);
  expect(agentView.resolvedFrom).toBe('agent:sales');
  expect(agentView.data.tools).toBe('mcp__linear--sales__*');

  // Disconnecting the agent's grant leaves the host's alone (and vice versa).
  expect((await api('DELETE', '/__api/setup/mcp:linear?owner=agent:sales')).json.removed).toBe(true);
  expect(readJson(path.join(dir, 'mcp-connections.json')).map((c: any) => c.name)).toEqual(['linear']);
  const after = (await api('GET', '/__api/setup/capabilities?owner=agent:sales')).json.capabilities.find((c: any) => c.id === 'mcp:linear');
  expect(after.ok).toBe(true); // falls back to the host's shared grant
  expect(after.resolvedFrom).toBe('global');
});

test('bearer path (GitHub) needs no browser — and says so when there is no token', async () => {
  const noToken = await api('POST', '/__api/setup/mcp:github', {});
  expect(noToken.status).toBe(400);
  expect(String(noToken.json.error)).toMatch(/GitHub token/i);

  const ok = await api('POST', '/__api/setup/mcp:github', { token: 'ghp_FAKE_NOT_REAL' });
  expect(ok.status).toBe(200);
  expect(ok.json.name).toBe('github');
  expect(JSON.stringify(ok.json)).not.toContain('ghp_FAKE_NOT_REAL');
  const st = (await api('GET', '/__api/setup/capabilities')).json.capabilities.find((c: any) => c.id === 'mcp:github');
  expect(st.ok).toBe(true);
  expect(st.data.auth).toBe('bearer');
});

test('a service outside the catalog is refused outright', async () => {
  const r = await api('POST', '/__api/setup/mcp:nosuch', { action: 'start' });
  expect(r.status).toBe(400);
  expect(String(r.json.error)).toMatch(/catalog|unknown capability/i);
  // …and a BYO-client vendor is refused with the reason, not a broken flow.
  const asana = await api('POST', '/__api/setup/mcp:asana', { action: 'start' });
  expect(asana.status).toBe(400);
  expect(String(asana.json.error)).toMatch(/client of your own/i);
});
