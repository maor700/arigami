// Composio over the MCP gateway (server/lib/composio-mcp.ts), on a running host
// with auth ON and Composio's API replaced by a stub.
//
//   - a session is spawned with composio-mcp once the host holds a key
//   - it lists the tools of the toolkits connected for its owner and runs a read
//     under the right connected account
//   - a sender files an outbound card and reaches Composio only after a person
//     presses Send — with exactly the arguments the card showed
//   - owner precedence: the agent's own account first, the shared one else,
//     another agent's never
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ho from '../server/handoff.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'composio-gateway-host-test-secret-32';
let host: ChildProcess;
let stub: ReturnType<typeof Bun.serve>;
let dir: string;
let base: string;
let cookie = '';
let sid = '';
let token = '';
let mcpConfig: any = null;
const executed: { tool: string; body: any }[] = [];

const ACCOUNTS = [
  { id: 'ca_gmail_shared', status: 'ACTIVE', user_id: 'default', toolkit: { slug: 'gmail' } },
  { id: 'ca_gmail_other_agent', status: 'ACTIVE', user_id: 'agent:someone-else', toolkit: { slug: 'gmail' } },
  { id: 'ca_slack_other_agent', status: 'ACTIVE', user_id: 'agent:someone-else', toolkit: { slug: 'slack' } },
  { id: 'ca_drive_failed', status: 'FAILED', user_id: 'default', toolkit: { slug: 'googledrive' } },
];
const TOOLS: Record<string, any[]> = {
  gmail: [
    { slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch emails', description: 'list mail', input_parameters: { properties: { query: { type: 'string' } } } },
    { slug: 'GMAIL_SEND_EMAIL', name: 'Send email', description: 'send mail', input_parameters: { properties: { recipient_email: { type: 'string' }, body: { type: 'string' } } } },
  ],
  slack: [{ slug: 'SLACK_SEND_MESSAGE', name: 'Send', description: 'send', input_parameters: {} }],
};

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(80);
  }
  throw new Error('condition not met in time');
}
async function person(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function mcp() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/__mcp/s/composio-mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const text = (r: any) => String((r.content || []).map((c: any) => c.text).join(''));

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (req.headers.get('x-api-key') !== 'test-composio-key') return Response.json({ error: { message: 'bad key' } }, { status: 401 });
      if (u.pathname === '/connected_accounts') return Response.json({ items: ACCOUNTS });
      if (u.pathname === '/tools') return Response.json({ items: TOOLS[u.searchParams.get('toolkit_slug') || ''] || [] });
      const ex = /^\/tools\/execute\/([A-Z_]+)$/.exec(u.pathname);
      if (ex && req.method === 'POST') {
        const body = await req.json();
        executed.push({ tool: ex[1], body });
        return Response.json({ successful: true, data: { ok: ex[1] } });
      }
      return new Response('no', { status: 404 });
    },
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-composio-gw-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const out = path.join(dir, 'spawned');
  fs.mkdirSync(out, { recursive: true });
  const claudeStub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    claudeStub,
    `#!/usr/bin/env bun
const fs = require('node:fs');
if (process.env.ARIGAMI_SESSION_ID) {
  const i = process.argv.indexOf('--mcp-config');
  fs.writeFileSync(${JSON.stringify(out)} + '/' + process.env.ARIGAMI_SESSION_ID, JSON.stringify({ token: process.env.ARIGAMI_TOKEN || '', mcp: i > 0 ? process.argv[i + 1] : null }));
}
const o=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');
o({type:'system',subtype:'init',session_id:'s',model:'m',tools:[],mcp_servers:[]});
setInterval(()=>{},1e6);`,
    { mode: 0o755 }
  );
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      ARIGAMI_DIR: dir,
      ARIGAMI_PORT: String(port),
      ARIGAMI_AUTH: 'pairing',
      ARIGAMI_HANDOFF_SECRET: SECRET,
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_CLAUDE_BIN: claudeStub,
      ARIGAMI_DEFAULT_CWD: ws,
      COMPOSIO_API_KEY: 'test-composio-key',
      ARIGAMI_COMPOSIO_BASE: `http://127.0.0.1:${stub.port}`,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  host.stderr!.on('data', (d) => (err += d));
  await until(async () => {
    try {
      return (await fetch(base + '/__health', { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }).catch(() => {
    throw new Error('host did not start: ' + err.slice(-2000));
  });
  const r = await fetch(`${base}/__api/auth/handoff?t=${encodeURIComponent(ho.mint(SECRET, 'owner@fake-org.test'))}`, { redirect: 'manual' });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const c = await person('POST', '/__api/sessions', { title: 'mail', cwd: ws });
  sid = c.json.id;
  await person('POST', `/__api/sessions/${sid}/message`, { text: 'hi' });
  const spawned = await until(async () => {
    const f = path.join(out, sid);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  });
  token = spawned.token;
  mcpConfig = spawned.mcp ? JSON.parse(spawned.mcp) : null;
}, 60000);

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
  stub?.stop(true);
});

test('a session is spawned with composio-mcp over the gateway, token not in argv', () => {
  const sv = mcpConfig?.mcpServers?.['composio-mcp'];
  expect(sv?.type).toBe('http');
  expect(sv?.url).toBe(`${base}/__mcp/s/composio-mcp`);
  expect(sv?.headers?.Authorization).toBe('Bearer ${ARIGAMI_TOKEN}');
});

test("it lists the owner's toolkits only, and runs a read under the shared account", async () => {
  const c = await mcp();
  try {
    const names = ((await c.listTools()) as any).tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL']); // no slack: only another agent has it
    const r = await c.callTool({ name: 'GMAIL_FETCH_EMAILS', arguments: { query: 'is:unread' } });
    expect(text(r)).toContain('GMAIL_FETCH_EMAILS');
    const slack = await c.callTool({ name: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x', text: 'y' } });
    expect((slack as any).isError).toBe(true);
  } finally {
    await c.close();
  }
  expect(executed).toEqual([{ tool: 'GMAIL_FETCH_EMAILS', body: { connected_account_id: 'ca_gmail_shared', user_id: 'default', arguments: { query: 'is:unread' } } }]);
});

test('a send becomes a card, and reaches Composio only on a person’s Send, unchanged', async () => {
  executed.length = 0;
  const c = await mcp();
  try {
    const r = JSON.parse(text(await c.callTool({ name: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'dana@example.test', body: 'Running late, 10 min.' } })));
    expect(r.pending).toBe(true);
  } finally {
    await c.close();
  }
  expect(executed.length).toBe(0); // nothing sent on the agent's call
  const s = await person('GET', `/__api/sessions/${sid}`);
  expect(s.json.action.kind).toBe('outbound');
  expect(s.json.action.prompt).toContain('dana@example.test');
  expect(s.json.action.prompt).toContain('Running late, 10 min.');
  // the session itself may not press Send
  const self = await fetch(`${base}/__api/sessions/${sid}/action/answer`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ value: 'send' }) });
  expect(self.status).toBe(403);
  expect(executed.length).toBe(0);
  const a = await person('POST', `/__api/sessions/${sid}/action/answer`, { value: 'send' });
  expect(a.status).toBe(200);
  expect(executed).toEqual([{ tool: 'GMAIL_SEND_EMAIL', body: { connected_account_id: 'ca_gmail_shared', user_id: 'default', arguments: { recipient_email: 'dana@example.test', body: 'Running late, 10 min.' } } }]);
});

test("owner precedence: the agent's own account, else the shared one, never another agent's", async () => {
  const cm = await import('../server/lib/composio-mcp.ts');
  const { cfg } = await import('../server/state.ts');
  (cfg as any).composioApiKey = 'k';
  cm._setFetch(async (input: string) => {
    const u = new URL(input);
    if (u.pathname.endsWith('/connected_accounts'))
      return Response.json({
        items: [
          { id: 'shared_gmail', status: 'ACTIVE', user_id: 'default', toolkit: { slug: 'gmail' } },
          { id: 'mine_gmail', status: 'ACTIVE', user_id: 'agent:mine', toolkit: { slug: 'gmail' } },
          { id: 'theirs_slack', status: 'ACTIVE', user_id: 'agent:theirs', toolkit: { slug: 'slack' } },
          { id: 'shared_cal', status: 'ACTIVE', user_id: 'default', toolkit: { slug: 'googlecalendar' } },
        ],
      });
    return Response.json({ items: [] });
  });
  try {
    const mine = await cm.accountsFor('agent:mine');
    expect(Object.fromEntries([...mine].map(([k, v]) => [k, v.id]))).toEqual({ gmail: 'mine_gmail', googlecalendar: 'shared_cal' });
    const global = await cm.accountsFor('global');
    expect(Object.fromEntries([...global].map(([k, v]) => [k, v.id]))).toEqual({ gmail: 'shared_gmail', googlecalendar: 'shared_cal' });
  } finally {
    cm._setFetch(null);
  }
});

test('calendar invites and shares count as sending; reads do not', async () => {
  const cm = await import('../server/lib/composio-mcp.ts');
  for (const t of ['GMAIL_SEND_EMAIL', 'GMAIL_REPLY_TO_THREAD', 'GMAIL_FORWARD_MESSAGE', 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE'])
    expect(cm.isComposioSender(t)).toBe(true);
  for (const t of ['GMAIL_FETCH_EMAILS', 'GMAIL_LIST_THREADS', 'GOOGLECALENDAR_FIND_EVENT', 'SLACK_LIST_ALL_CHANNELS', 'GOOGLEDRIVE_FIND_FILE', 'LINKEDIN_GET_POSTS'])
    expect(cm.isComposioSender(t)).toBe(false);
});
