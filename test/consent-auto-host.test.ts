// The host connects a service BY ITSELF (server/lib/consent-runner.ts) on a
// running host with auth ON, a real headless Chrome as the owner's browser, and
// a fake vendor that does real OAuth 2.1 and shows a real consent page.
//
//   - Connect: the host walks the consent page itself; nobody opens anything
//   - the connection is live and recorded; the automatic attempt says "approved"
//   - a session that was already running restarts by itself and now has it
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ho from '../server/handoff.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'mcp-grants-host-test-secret-32chars!';
let host: ChildProcess;
let vendor: ReturnType<typeof Bun.serve>;
let vbase = '';
let dir = '';
let base = '';
let cookie = '';
let out = '';
let ws = '';
let hostErr = '';

// ---- the fake vendor ---------------------------------------------------------------
const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
const clientsRegistered: string[] = [];
let accessToken = '';
let refreshToken = '';
let tokenIssues = 0;
let refreshes = 0;
const toolCalls: { tool: string; args: any; auth: string | null }[] = [];

async function mcpResponse(req: Request): Promise<Response> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
  const { z } = await import('zod');
  const s = new McpServer({ name: 'fake', version: '0' });
  const auth = req.headers.get('authorization');
  s.tool('list_issues', 'list', {}, async () => {
    toolCalls.push({ tool: 'list_issues', args: {}, auth });
    return { content: [{ type: 'text', text: 'ISSUE-1' }] };
  });
  s.tool('save_comment', 'comment on an issue', { issueId: z.string(), body: z.string() }, async (a: any) => {
    toolCalls.push({ tool: 'save_comment', args: a, auth });
    return { content: [{ type: 'text', text: 'commented' }] };
  });
  const t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await s.connect(t);
  return t.handleRequest(req);
}

function startVendor() {
  vendor = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource'))
        return Response.json({ resource: `${vbase}/mcp`, authorization_servers: [vbase] });
      if (u.pathname === '/.well-known/oauth-authorization-server')
        return Response.json({
          issuer: vbase,
          authorization_endpoint: `${vbase}/authorize`,
          token_endpoint: `${vbase}/token`,
          registration_endpoint: `${vbase}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      if (u.pathname === '/register' && req.method === 'POST') {
        const b: any = await req.json();
        const id = 'client-' + (clientsRegistered.length + 1);
        clientsRegistered.push(id);
        return Response.json({ ...b, client_id: id }, { status: 201 });
      }
      if (u.pathname === '/authorize') {
        // the owner is signed in at the vendor: the consent page, naming the callback
        const code = 'code-' + Math.random().toString(36).slice(2);
        codes.set(code, { challenge: u.searchParams.get('code_challenge') || '', redirect: u.searchParams.get('redirect_uri') || '', client: u.searchParams.get('client_id') || '' });
        const back = new URL(u.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', u.searchParams.get('state') || '');
        return new Response(
          `<!doctype html><meta charset="utf-8"><h2>Arigami is requesting access</h2><p>Redirect URIs: ${u.searchParams.get('redirect_uri')}</p><button id="ok">Approve</button><button>Cancel</button><script>document.getElementById('ok').onclick = () => { location.href = ${JSON.stringify(back.toString())}; };</script>`,
          { headers: { 'content-type': 'text/html' } }
        );
      }
      if (u.pathname === '/token' && req.method === 'POST') {
        const f = new URLSearchParams(await req.text());
        if (f.get('grant_type') === 'authorization_code') {
          const c = codes.get(f.get('code') || '');
          codes.delete(f.get('code') || '');
          const ok = c && createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === c.challenge && c.redirect === f.get('redirect_uri');
          if (!ok) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        } else if (f.get('grant_type') === 'refresh_token') {
          if (f.get('refresh_token') !== refreshToken) return Response.json({ error: 'invalid_grant' }, { status: 400 });
          refreshes++;
        } else return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
        tokenIssues++;
        accessToken = 'at-' + tokenIssues;
        refreshToken = 'rt-' + tokenIssues;
        return Response.json({ access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expires_in: 3600 });
      }
      if (u.pathname === '/mcp') {
        if (req.headers.get('authorization') !== `Bearer ${accessToken}` || !accessToken)
          return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${vbase}/.well-known/oauth-protected-resource/mcp"` } });
        return mcpResponse(req);
      }
      return new Response('no', { status: 404 });
    },
  });
  vbase = `http://127.0.0.1:${vendor.port}`;
}

// ---- helpers -------------------------------------------------------------------------
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
async function newSession(title: string): Promise<{ id: string; token: string; mcp: any }> {
  const c = await person('POST', '/__api/sessions', { title, cwd: ws });
  await person('POST', `/__api/sessions/${c.json.id}/message`, { text: 'hi' });
  const spawned = await until(async () => {
    const f = path.join(out, c.json.id);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  });
  return { id: c.json.id, token: spawned.token, mcp: spawned.mcp ? JSON.parse(spawned.mcp) : null };
}
async function mcp(name: string, token: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/__mcp/s/${name}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const text = (r: any) => String((r.content || []).map((c: any) => c.text).join(''));

beforeAll(async () => {
  startVendor();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-consent-auto-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  ws = path.join(dir, 'ws');
  out = path.join(dir, 'spawned');
  for (const d of [home, ws, out, path.join(dir, 'user')]) fs.mkdirSync(d, { recursive: true });
  // Claude Code's own config already registers the same name (the stale twin)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ mcpServers: { fakevendor: { type: 'http', url: `${vbase}/mcp` } } }));
  fs.writeFileSync(path.join(dir, 'user', 'mcp-catalog.json'), JSON.stringify([{ slug: 'fakevendor', title: 'Fake Vendor', url: `${vbase}/mcp`, auth: 'oauth', domains: ['127.0.0.1'] }]));
  const claudeStub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    claudeStub,
    `#!/usr/bin/env bun
const fs = require('node:fs');
if (process.argv[2] === 'mcp') { fs.appendFileSync(${JSON.stringify(dir)} + '/cli-calls.log', process.argv.slice(2).join(' ') + '\\n'); if (process.argv[3] === 'list') process.stdout.write('fakevendor: http://x/mcp (HTTP) - ! Needs authentication\\n'); process.exit(0); }
if (process.env.ARIGAMI_SESSION_ID) {
  const i = process.argv.indexOf('--mcp-config');
  fs.writeFileSync(${JSON.stringify(out)} + '/' + process.env.ARIGAMI_SESSION_ID, JSON.stringify({ token: process.env.ARIGAMI_TOKEN || '', mcp: i > 0 ? process.argv[i + 1] : null }));
}
const o=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');
o({type:'system',subtype:'init',session_id:'s',model:'m',tools:[],mcp_servers:[]});
o({type:'result',subtype:'success',result:'ok',session_id:'s',is_error:false});
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
      ARIGAMI_PUBLIC_URL: '',
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  host.stderr!.on('data', (d) => ((err += d), (hostErr += d)));
  host.stdout!.on('data', (d) => (hostErr += d));
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
}, 60000);

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
  vendor?.stop(true);
});

const HAVE_CHROME = (() => {
  try {
    return !!require('../server/lib/chrome.ts').chromeBin();
  } catch {
    return false;
  }
})();

test.skipIf(!HAVE_CHROME)('Connect: the host walks the consent itself, and a running session picks it up', async () => {
  const before = await newSession('already-running');
  expect(before.mcp.mcpServers.fakevendor).toBeUndefined();
  const spawnFile = path.join(out, before.id);
  fs.rmSync(spawnFile); // the next spawn of this session writes it again

  const start = await person('POST', '/__api/setup/mcp:fakevendor', { action: 'start' });
  expect(start.json.state).toBe('awaiting');
  expect(start.json.auto).toEqual({ status: 'running' });
  // nobody opens the vendor's page: the host does
  const done = await until(async () => {
    const p = await person('POST', '/__api/setup/mcp:fakevendor', { action: 'poll' });
    return p.json.state === 'done' ? p.json : null;
  }, 60_000);
  expect(done.heldBy).toBe('host');
  expect(tokenIssues).toBeGreaterThan(0);
  // the automatic attempt is on record, with its evidence
  const audit = await until(async () => {
    const a = fs.existsSync(path.join(dir, 'connections.log')) ? fs.readFileSync(path.join(dir, 'connections.log'), 'utf8') : '';
    return a.includes('"mode":"auto"') ? a : null;
  }, 20_000);
  expect(audit).toContain('"result":"ok"');

  // the running session restarted by itself and now carries the service
  const respawn = await until(async () => (fs.existsSync(spawnFile) ? JSON.parse(fs.readFileSync(spawnFile, 'utf8')) : null), 20_000);
  expect(JSON.parse(respawn.mcp).mcpServers.fakevendor?.url).toBe(`${base}/__mcp/s/fakevendor`);
  const chat = (await person('GET', `/__api/sessions/${before.id}/chat`)).json;
  const events = Array.isArray(chat) ? chat : chat.events || [];
  expect(events.some((e: any) => e.kind === 'system' && /fakevendor is connected now/.test(e.text || ''))).toBe(true);
}, 120_000);
