// The MCP gateway (server/lib/mcp-gateway.ts) on a running host with auth ON.
//
//   - the arigami tools work over HTTP, as the calling session
//   - an extension runs as ONE process for every session, and each call still
//     knows which session made it — including for the outbound gate
//   - only a session token gets in
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ho from '../server/handoff.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'mcp-gateway-host-test-secret-32chars';
let host: ChildProcess;
let dir: string;
let base: string;
let cookie = '';
const tokens: Record<string, string> = {};
const sids: string[] = [];

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

/** An MCP client for one gateway server, as one session. */
async function mcp(name: string, token: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/__mcp/s/${name}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const text = (r: any) => String((r.content || []).map((c: any) => c.text).join(''));

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-gateway-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  // a test extension: a reader that proves who is calling, and a sender
  const ext = path.join(dir, 'user', 'extensions', 'notes');
  fs.mkdirSync(path.join(ext, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ name: 'notes', version: '0.1.0', apiVersion: 1, tools: [{ kind: 'module', name: 'notes', module: 'tools/module.ts' }], permissions: [] }));
  fs.writeFileSync(
    path.join(ext, 'tools', 'module.ts'),
    `export const tools = [
       { name: 'whoami', description: 'which session is calling', run: async (_a, ctx) => {
           const me = await ctx.host.api('GET', '/__api/auth/me');
           return { pid: process.pid, principal: me.principal, session: me.sessionId ?? me.session ?? null };
         } },
       { name: 'send_note', description: 'send a note to a person', run: async () => ({ ran: true }) },
     ];`
  );
  const tokenDir = path.join(dir, 'tokens');
  fs.mkdirSync(tokenDir, { recursive: true });
  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bun
if (process.env.ARIGAMI_SESSION_ID) require('node:fs').writeFileSync(${JSON.stringify(tokenDir)} + '/' + process.env.ARIGAMI_SESSION_ID, process.env.ARIGAMI_TOKEN || '');
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
out({type:'system',subtype:'init',session_id:'s',model:'m',tools:[],mcp_servers:[]});
setInterval(()=>{},1e6);`,
    { mode: 0o755 }
  );
  host = spawn('bun', ['server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, ARIGAMI_DIR: dir, ARIGAMI_PORT: String(port), ARIGAMI_AUTH: 'pairing', ARIGAMI_HANDOFF_SECRET: SECRET, ARIGAMI_SCREEN_ENABLED: '0', ARIGAMI_TELEMETRY: '0', ARIGAMI_CLAUDE_BIN: stub, ARIGAMI_DEFAULT_CWD: ws, COMPOSIO_API_KEY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
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
  for (const title of ['one', 'two']) {
    const c = await person('POST', '/__api/sessions', { title, cwd: ws });
    sids.push(c.json.id);
    await person('POST', `/__api/sessions/${c.json.id}/message`, { text: 'hi' });
    tokens[c.json.id] = await until(async () => {
      const f = path.join(tokenDir, c.json.id);
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() || null : null;
    });
  }
}, 60000);

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

test('the arigami tools work over the gateway, as the calling session', async () => {
  const c = await mcp('arigami', tokens[sids[0]]);
  try {
    const names = ((await c.listTools()) as any).tools.map((t: any) => t.name);
    expect(names).toContain('set_title');
    expect(names).toContain('request_login');
    await c.callTool({ name: 'set_title', arguments: { title: 'renamed over http' } });
  } finally {
    await c.close();
  }
  expect((await person('GET', `/__api/sessions/${sids[0]}`)).json.title).toBe('renamed over http');
  expect((await person('GET', `/__api/sessions/${sids[1]}`)).json.title).toBe('two'); // the other session untouched
});

test('one extension process serves every session, and each call knows its session', async () => {
  const a = await mcp('ext-notes', tokens[sids[0]]);
  const b = await mcp('ext-notes', tokens[sids[1]]);
  try {
    const ra = JSON.parse(text(await a.callTool({ name: 'whoami', arguments: {} })));
    const rb = JSON.parse(text(await b.callTool({ name: 'whoami', arguments: {} })));
    expect(ra.pid).toBe(rb.pid); // the same process
    expect(ra.principal).toBe('session');
    expect(rb.principal).toBe('session');
    // and nothing per session was spawned for it
    const running = spawnSync('pgrep', ['-fl', `ext-mcp.js ${dir}/user/extensions/notes/tools/module.ts`]).stdout.toString().trim().split('\n').filter(Boolean);
    if (running.length !== 1) console.log('MATCHED:\n' + running.join('\n'));
    expect(running.length).toBe(1);
  } finally {
    await a.close();
    await b.close();
  }
});

test("a sender called through the shared process becomes the CALLING session's card", async () => {
  const b = await mcp('ext-notes', tokens[sids[1]]);
  try {
    const r = JSON.parse(text(await b.callTool({ name: 'send_note', arguments: { to: 'Dana', text: 'see you at 5' } })));
    expect(r.pending).toBe(true);
    expect(r.ran).toBeUndefined(); // the tool did not run
  } finally {
    await b.close();
  }
  const s = await person('GET', `/__api/sessions/${sids[1]}`);
  expect(s.json.action.kind).toBe('outbound');
  expect(s.json.action.prompt).toContain('see you at 5');
  expect((await person('GET', `/__api/sessions/${sids[0]}`)).json.action ?? null).toBe(null);
});

test('only a session token gets in', async () => {
  const noAuth = await fetch(`${base}/__mcp/s/arigami`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  expect(noAuth.status).toBe(401);
  const asPerson = await fetch(`${base}/__mcp/s/arigami`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  expect(asPerson.status).toBe(403);
  const unknown = await fetch(`${base}/__mcp/s/ext-nope`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens[sids[0]]}` }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  expect(unknown.status).toBe(404);
});
