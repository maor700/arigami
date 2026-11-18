// The bundled gatekeeper on an ISOLATED host with authentication ON (tmp ARIGAMI_DIR, own port, a stub `claude` that
// records argv + env so each session's own token is the one its process got, a fake Slack on loopback):
//   - turning it on changes nothing for a Full session's spawn; a restricted session's spawn lists ext-gatekeeper;
//   - through the MCP gateway the restricted session sees its tools (never the admin ones) and the host's facts about
//     it (profile, grants) — a Full session is not served at all;
//   - a write lands only in the bound thread; anything else is refused and audited;
//   - the admin tools answer a signed-in admin person only, never a session token.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostDiag } from './_host-diag.js';
import { tmpDir } from './_tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let host: ChildProcess;
let slackSrv: http.Server;
let dir: string;
let base: string;
let rec: string;
let cookie: string;
let admin: string;
const slackCalls: { method: string; body: any }[] = [];
const THREAD = ((Date.now() - 60_000) / 1000).toFixed(6);

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 10000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(60);
  }
  throw new Error('condition not met in time');
}
async function call(token: string | null, method: string, p: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let json: any;
  try { json = JSON.parse(t); } catch { json = { raw: t }; }
  return { status: r.status, json };
}
const spawnOf = (sid: string): Promise<{ argv: string[]; env: Record<string, string> }> =>
  until(async () => {
    const f = path.join(rec, `${sid}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  });
const mcpConfigOf = async (sid: string) => {
  const a = (await spawnOf(sid)).argv;
  const i = a.indexOf('--mcp-config');
  return i >= 0 ? JSON.parse(a[i + 1]) : null;
};
async function mcp(name: string, token: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/__mcp/s/${name}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const text = (r: any) => JSON.parse(String((r.content || []).map((c: any) => c.text).join('')));

beforeAll(async () => {
  dir = tmpDir('arigami-gk-host-');
  rec = path.join(dir, 'rec');
  fs.mkdirSync(rec, { recursive: true });
  const ws = tmpDir('arigami-gk-ws-');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  // a fake Slack Web API
  const sport = await freePort();
  slackSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const u = new URL(req.url || '/', 'http://x');
      const method = u.pathname.split('/').pop() || '';
      slackCalls.push({ method, body: b ? JSON.parse(b) : Object.fromEntries(u.searchParams) });
      res.setHeader('content-type', 'application/json');
      if (method === 'chat.postMessage') return res.end(JSON.stringify({ ok: true, ts: '1800000000.000100' }));
      if (method === 'conversations.replies') return res.end(JSON.stringify({ ok: true, messages: [{ ts: THREAD, bot_id: 'BALERTS01', text: 'alert' }] }));
      res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
    });
  });
  await new Promise<void>((r) => slackSrv.listen(sport, '127.0.0.1', () => r()));
  const gk = path.join(dir, 'gatekeeper');
  fs.mkdirSync(gk, { recursive: true });
  fs.writeFileSync(path.join(gk, 'config.json'), JSON.stringify({ slack: { apiUrl: `http://127.0.0.1:${sport}/api`, channel: 'CINCIDENT1', operators: [{ id: 'UOPERATOR1' }], threadOpeners: ['BALERTS01'] } }));
  fs.writeFileSync(path.join(gk, 'identities.json'), JSON.stringify({ slack: { botToken: 'xoxb-canary-not-a-real-token' } }), { mode: 0o600 });

  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bun
const fs=require('node:fs');
if(process.env.ARIGAMI_SESSION_ID) fs.writeFileSync(${JSON.stringify(rec)}+'/'+process.env.ARIGAMI_SESSION_ID+'.json',JSON.stringify({argv:process.argv.slice(2),env:process.env}));
const i=process.argv.indexOf('--session-id');const sid=i>0?process.argv[i+1]:'stub';
process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:sid,model:'claude-stub',tools:['Bash','Read'],mcp_servers:[{name:'arigami',status:'connected'}]})+'\\n');
setInterval(()=>{},1e6);
`,
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
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: ws,
      ARIGAMI_BUNDLED_EXT_DIR: path.join(ROOT, 'extensions'),
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
        return (await fetch(base + '/__health', { signal: AbortSignal.timeout(3000) })).ok && fs.existsSync(path.join(dir, 'run', 'pairing-code'));
      } catch {
        return false;
      }
    }, 30000);
  } catch {
    throw new Error(`host did not come up: ${log.slice(-1500)}${hostDiag(host)}`);
  }
  const code = fs.readFileSync(path.join(dir, 'run', 'pairing-code'), 'utf8').trim();
  const pr = await fetch(base + '/__api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, email: 'owner@example.com' }) });
  expect(pr.status).toBe(200);
  cookie = String(pr.headers.get('set-cookie') || '').split(';')[0];
  const tr = await fetch(base + '/__api/auth/tokens', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ label: 'test' }) });
  admin = (await tr.json()).token;
}, 60_000);

afterAll(() => {
  try { host?.kill('SIGTERM'); } catch {}
  try { slackSrv?.close(); } catch {}
});

let fullBefore: string, fullAfter: string, restricted: string;
let tFull: string, tR: string;

test('off by default; on, a Full session spawns exactly as before and a restricted one gets ext-gatekeeper', async () => {
  const bundled = await call(admin, 'GET', '/__api/extensions/bundled');
  expect(bundled.json.bundled.find((b: any) => b.name === 'gatekeeper')).toMatchObject({ enabled: false });
  expect((await call(admin, 'GET', '/__api/extensions')).json.extensions.find((e: any) => e.name === 'gatekeeper')).toBeUndefined();
  fullBefore = (await call(admin, 'POST', '/__api/sessions', { title: 'full before' })).json.id;
  const before = await mcpConfigOf(fullBefore);

  const on = await call(admin, 'PATCH', '/__api/extensions/gatekeeper', { enabled: true });
  expect(on.status).toBe(200);
  expect(on.json.extension).toMatchObject({ name: 'gatekeeper', state: 'loaded', tier: 'trusted' });

  fullAfter = (await call(admin, 'POST', '/__api/sessions', { title: 'full after' })).json.id;
  expect(await mcpConfigOf(fullAfter)).toEqual(before);
  expect((await spawnOf(fullAfter)).argv).not.toContain('--disallowedTools');

  const put = await call(admin, 'PUT', '/__api/session-profiles', {
    profiles: { fixer: { tools: ['git', 'ext:gatekeeper'], grants: ['gatekeeper:slack.read', 'gatekeeper:slack.post', 'gatekeeper:github.push'] } },
    attach: {},
  });
  expect(put.status).toBe(200);
  expect(put.json.profiles.fixer.grants).toEqual(['gatekeeper:slack.read', 'gatekeeper:slack.post', 'gatekeeper:github.push']);
  const r = await call(admin, 'POST', '/__api/sessions', { title: 'restricted', profile: 'fixer' });
  expect(r.status).toBe(201);
  restricted = r.json.id;
  expect(r.json.profile.grants).toContain('gatekeeper:slack.post');
  const cfg = await mcpConfigOf(restricted);
  expect(Object.keys(cfg.mcpServers)).toContain('ext-gatekeeper');
  expect(JSON.stringify(cfg)).not.toContain('xoxb-');
  const env = (await spawnOf(restricted)).env;
  expect(JSON.stringify(env)).not.toContain('xoxb-');
  tFull = (await spawnOf(fullAfter)).env.ARIGAMI_TOKEN;
  tR = env.ARIGAMI_TOKEN;
});

test('through the gateway: the restricted session sees its tools and the host\'s facts about it; a Full session is not served', async () => {
  const c = await mcp('ext-gatekeeper', tR);
  try {
    const names = ((await c.listTools()) as any).tools.map((t: any) => t.name);
    expect(names).toContain('slack_thread_say');
    expect(names.some((n: string) => n.startsWith('gk_admin_'))).toBe(false);
    const st = text(await c.callTool({ name: 'gatekeeper_status', arguments: {} }));
    expect(st).toMatchObject({ ok: true, session: restricted, profile: 'fixer' });
    expect(st.may.map((m: any) => m.action).sort()).toEqual(['github.push', 'slack.post', 'slack.read']);
  } finally {
    await c.close();
  }
  await expect(mcp('ext-gatekeeper', tFull)).rejects.toThrow();
});

test('admin tools: a signed-in admin person only — never a session token', async () => {
  const bind = { args: { session: restricted, channel: 'CINCIDENT1', thread_ts: THREAD } };
  expect((await call(tR, 'POST', '/__api/ext/gatekeeper/tool/gk_admin_bind', bind)).status).toBe(403);
  expect((await call(tFull, 'POST', '/__api/ext/gatekeeper/tool/gk_admin_bind', bind)).status).toBe(403);
  const ok = await call(null, 'POST', '/__api/ext/gatekeeper/tool/gk_admin_bind', bind, { cookie });
  expect(ok.status).toBe(200);
  const st = await call(null, 'POST', '/__api/ext/gatekeeper/tool/gk_admin_state', { args: {} }, { cookie });
  const s = JSON.parse(st.json.result.map((b: any) => b.text).join(''));
  expect(s.identities.slack.botToken).toBe(true);
  expect(JSON.stringify(s)).not.toContain('xoxb-');
});

test('writes land only in the bound thread; anything else is refused and audited', async () => {
  const c = await mcp('ext-gatekeeper', tR);
  try {
    const bad = text(await c.callTool({ name: 'slack_thread_say', arguments: { text: 'Action needed', channel: 'COTHER0001' } }));
    expect(bad).toMatchObject({ ok: false, decision: 'refused' });
    expect(slackCalls.some((x) => x.method === 'chat.postMessage')).toBe(false);
    const good = text(await c.callTool({ name: 'slack_thread_say', arguments: { text: 'RCA: describeOrder' } }));
    expect(good).toMatchObject({ ok: true, channel: 'CINCIDENT1', thread_ts: THREAD });
    const post = slackCalls.find((x) => x.method === 'chat.postMessage')!;
    expect(post.body).toMatchObject({ channel: 'CINCIDENT1', thread_ts: THREAD, text: 'RCA: describeOrder' });
    const noGrant = text(await c.callTool({ name: 'github_merge', arguments: { pr: 1 } }));
    expect(noGrant.error).toContain('not in the session');
  } finally {
    await c.close();
  }
  const lines = fs.readFileSync(path.join(dir, 'gatekeeper', 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.some((l) => l.tool === 'slack_thread_say' && l.decision === 'refused' && l.session === restricted)).toBe(true);
  expect(lines.some((l) => l.tool === 'slack_thread_say' && l.decision === 'allowed' && l.session === restricted)).toBe(true);
  expect(lines.some((l) => l.tool === 'github_merge' && l.decision === 'refused')).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'gatekeeper', 'audit.log'), 'utf8')).not.toContain('xoxb-');
});
