// Remote MCP grants held by the host (server/lib/mcp-grants.ts), end to end, on
// a running host with auth ON against a fake vendor that does real OAuth 2.1
// (discovery, dynamic client registration, PKCE, refresh) and serves MCP.
//
//   - Connect (the same setup API every screen uses) returns the vendor's
//     authorize URL; the vendor's redirect lands on the host and finishes it
//   - a callback with a state the host never issued is refused
//   - a session is spawned with the grant over the gateway, under its own name
//   - a read reaches the vendor with the host's token; an expired token is
//     refreshed without anyone signing in again
//   - a comment files an outbound card and reaches the vendor only on a
//     person's Send, unchanged
//   - Disconnect forgets the grant; the gateway no longer serves it
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
        // The person consents: back to the redirect with a code.
        const code = 'code-' + Math.random().toString(36).slice(2);
        codes.set(code, { challenge: u.searchParams.get('code_challenge') || '', redirect: u.searchParams.get('redirect_uri') || '', client: u.searchParams.get('client_id') || '' });
        const back = new URL(u.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', u.searchParams.get('state') || '');
        return new Response(null, { status: 302, headers: { location: back.toString() } });
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-grants-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  ws = path.join(dir, 'ws');
  out = path.join(dir, 'spawned');
  for (const d of [home, ws, out, path.join(dir, 'user')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dir, 'user', 'mcp-catalog.json'), JSON.stringify([{ slug: 'fakevendor', title: 'Fake Vendor', url: `${vbase}/mcp`, auth: 'oauth', domains: ['127.0.0.1'] }]));
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
      ARIGAMI_PUBLIC_URL: '',
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
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

test('Connect returns the vendor authorize URL; the redirect lands on the host and finishes it', async () => {
  const start = await person('POST', '/__api/setup/mcp:fakevendor', { action: 'start' });
  expect(start.status).toBe(200);
  expect(start.json.state).toBe('awaiting');
  const authorize = new URL(start.json.url);
  expect(authorize.origin + authorize.pathname).toBe(`${vbase}/authorize`);
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
  expect(redirect.pathname).toBe('/__api/mcp-oauth/callback');
  // the person consents at the vendor; the vendor sends the browser back
  const consent = await fetch(authorize, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location')!);
  // the browser that lands there has no Arigami credential at all
  const landed = await fetch(`${base}${back.pathname}${back.search}`);
  expect(landed.status).toBe(200);
  expect(await landed.text()).toContain('Connected');
  const poll = await person('POST', '/__api/setup/mcp:fakevendor', { action: 'poll' });
  expect(poll.json.state).toBe('done');
  const cap = await person('GET', '/__api/setup/capabilities/mcp%3Afakevendor');
  expect(cap.json.ok ?? cap.json.status?.ok).toBe(true);
  // nothing secret comes back
  expect(JSON.stringify([start.json, poll.json, cap.json])).not.toContain(accessToken);
  expect(fs.statSync(path.join(dir, 'mcp-grants.json')).mode & 0o777).toBe(0o600);
});

test('a callback with a state the host never issued is refused', async () => {
  const r = await fetch(`${base}/__api/mcp-oauth/callback?code=x&state=forged`);
  expect(r.status).toBe(400);
});

test('a session gets the grant over the gateway under its own name, and reads with the host token', async () => {
  const s = await newSession('reader');
  expect(s.mcp.mcpServers.fakevendor).toEqual({ type: 'http', url: `${base}/__mcp/s/fakevendor`, headers: { Authorization: 'Bearer ${ARIGAMI_TOKEN}' } });
  const c = await mcp('fakevendor', s.token);
  try {
    expect(text(await c.callTool({ name: 'list_issues', arguments: {} }))).toBe('ISSUE-1');
    // the vendor's token expires: the host refreshes it, nobody signs in again
    accessToken = 'expired-elsewhere';
    const before = refreshes;
    // (the vendor now rejects the old token and only the refresh gets a new one)
    const r = await c.callTool({ name: 'list_issues', arguments: {} });
    expect(text(r)).toBe('ISSUE-1');
    expect(refreshes).toBe(before + 1);
  } finally {
    await c.close();
  }
  expect(toolCalls.every((t) => t.auth === `Bearer at-${t === toolCalls[0] ? 1 : tokenIssues}`)).toBe(true);
});

test("a comment becomes a card and reaches the vendor only on a person's Send, unchanged", async () => {
  const s = await newSession('commenter');
  toolCalls.length = 0;
  const c = await mcp('fakevendor', s.token);
  try {
    const r = JSON.parse(text(await c.callTool({ name: 'save_comment', arguments: { issueId: 'ISSUE-1', body: 'Fixed in the latest build.' } })));
    expect(r.pending).toBe(true);
  } finally {
    await c.close();
  }
  expect(toolCalls.length).toBe(0);
  const card = (await person('GET', `/__api/sessions/${s.id}`)).json.action;
  expect(card.kind).toBe('outbound');
  expect(card.prompt).toContain('ISSUE-1');
  expect(card.prompt).toContain('Fixed in the latest build.');
  const self = await fetch(`${base}/__api/sessions/${s.id}/action/answer`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` }, body: JSON.stringify({ value: 'send' }) });
  expect(self.status).toBe(403);
  expect(toolCalls.length).toBe(0);
  expect((await person('POST', `/__api/sessions/${s.id}/action/answer`, { value: 'send' })).status).toBe(200);
  expect(toolCalls.map((t) => [t.tool, t.args])).toEqual([['save_comment', { issueId: 'ISSUE-1', body: 'Fixed in the latest build.' }]]);
});

test('Disconnect forgets the grant; the gateway stops serving it', async () => {
  const s = await newSession('after');
  const d = await person('DELETE', '/__api/setup/mcp:fakevendor');
  expect(d.status).toBe(200);
  const r = await fetch(`${base}/__mcp/s/fakevendor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${s.token}` },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });
  expect(r.status).toBe(404);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'mcp-grants.json'), 'utf8')).grants.fakevendor).toBeUndefined();
});
