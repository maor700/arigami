// VAULT1 as a running host enforces it (auth ON): the session may ASK for a sign-in, and sees no value; only the
// person, in the cockpit, fills or answers the card; the vault file is the person's, stored as ciphertext only and kept
// out of the user repo; and nobody rewrites the card through a PATCH.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ho from '../server/handoff.ts';
import { runInChild } from './_child.js';
import { tmpDir, tmpPath } from './_tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'vault-host-test-secret-32chars-xx';
let host: ChildProcess;
let dir: string;
let base: string;
let cookie = '';
let token = '';
let sid = '';

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
async function call(method: string, p: string, who: 'person' | 'session', body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who === 'person') headers.cookie = cookie;
  else headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json };
}

beforeAll(async () => {
  dir = tmpDir('arigami-vault-host-');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const tokenFile = path.join(dir, 'session-token');
  // A stream-json claude stub that hands its session token to the test.
  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bun
// Only as a SESSION: the host also runs this binary for \`claude mcp list\`,
// with no session env — that call must not overwrite the token.
if (process.env.ARIGAMI_SESSION_ID) require('node:fs').writeFileSync(${JSON.stringify(tokenFile)}, process.env.ARIGAMI_TOKEN || '');
const sidIdx=process.argv.indexOf('--session-id');const rsIdx=process.argv.indexOf('--resume');
const sid=sidIdx>0?process.argv[sidIdx+1]:rsIdx>0?process.argv[rsIdx+1]:'stub';
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
out({type:'system',subtype:'init',session_id:sid,model:'claude-stub',tools:[],mcp_servers:[]});
let buf='';
process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
  let j={};try{j=JSON.parse(line);}catch{}
  if(j.type!=='user')continue;
  out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'ok'}],usage:{input_tokens:1,output_tokens:1}}});
  out({type:'result',subtype:'success',session_id:sid,is_error:false,result:'ok',duration_ms:1,num_turns:1,total_cost_usd:0});
}});
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
      ARIGAMI_HANDOFF_SECRET: SECRET,
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_DEFAULT_CWD: ws,
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  host.stderr!.on('data', (d) => {
    err += d;
    fs.appendFileSync(tmpPath('vault-host.log'), String(d));
  });
  host.stdout!.on('data', (d) => fs.appendFileSync(tmpPath('vault-host.log'), String(d)));
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
  const created = await call('POST', '/__api/sessions', 'person', { title: 'vault', cwd: ws });
  sid = created.json.id;
  const sent = await call('POST', `/__api/sessions/${sid}/message`, 'person', { text: 'hello' });
  if (!sid || sent.status >= 300) throw new Error(`setup: cookie=${!!cookie} create=${created.status} ${JSON.stringify(created.json).slice(0, 200)} message=${sent.status} ${JSON.stringify(sent.json).slice(0, 200)}`);
  token = await until(async () => (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() || null : null)).catch(async () => {
    const chat = await call('GET', `/__api/sessions/${sid}/chat`, 'person');
    throw new Error(`the session never spawned. chat=${JSON.stringify(chat.json).slice(0, 600)} stderr=${err.slice(-800)}`);
  });
}, 60000);

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});


// A minimal real KDBX 4 file (kdbxweb, as the cockpit makes it).
async function kdbx(): Promise<Buffer> {
  const kdbxweb = await import('../web/node_modules/kdbxweb/dist/kdbxweb.js');
  const { argon2id, argon2d } = await import('../web/node_modules/hash-wasm/dist/index.esm.js');
  (kdbxweb as any).CryptoEngine.setArgon2Impl((pw: ArrayBuffer, salt: ArrayBuffer, memory: number, iterations: number, length: number, parallelism: number, type: number) =>
    (type === 2 ? argon2id : argon2d)({ password: new Uint8Array(pw), salt: new Uint8Array(salt), memorySize: memory, iterations, hashLength: length, parallelism, outputType: 'binary' }).then((r: Uint8Array) => r.buffer));
  const db = (kdbxweb as any).Kdbx.create(new (kdbxweb as any).Credentials((kdbxweb as any).ProtectedValue.fromString('master-pass')), 'Arigami');
  db.setKdf((kdbxweb as any).Consts.KdfId.Argon2id);
  return Buffer.from(await db.save());
}
const raw = (method: string, p: string, who: 'person' | 'session', body?: BodyInit, headers: Record<string, string> = {}) =>
  fetch(base + p, { method, headers: { ...(who === 'person' ? { cookie } : { authorization: `Bearer ${token}` }), ...headers }, body });

test('the session asks — and with no browser open it is told what to do, no card goes up', async () => {
  const r = await call('POST', `/__api/sessions/${sid}/credentials/request`, 'session', { site: 'example.com', reason: 'read the dashboard' });
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ ok: false });
  expect(r.json.next).toMatch(/browser_open/);
  const s = await call('GET', `/__api/sessions/${sid}`, 'person');
  expect(s.json.credentialRequest ?? null).toBeNull();
});

test('only the person answers a sign-in card: a session token gets 403 on fill and answer', async () => {
  for (const sub of ['fill', 'answer']) {
    const r = await call('POST', `/__api/sessions/${sid}/credentials/${sub}`, 'session', { requestId: 'cred_x', values: { password: 'p' } });
    expect(r.status).toBe(403);
  }
  // the person gets through the gate, and is told the request is not open
  const r = await call('POST', `/__api/sessions/${sid}/credentials/fill`, 'person', { requestId: 'cred_x', values: { password: 'p' } });
  expect(r.status).toBe(404);
  expect(JSON.stringify(r.json)).not.toContain('"p"');
});

test('nobody rewrites the card through a PATCH — not even the session itself', async () => {
  const forged = { requestId: 'cred_forged', origin: 'https://bank.example', host: 'bank.example', fields: ['username', 'password'], pref: 'ask', at: new Date().toISOString() };
  await call('PATCH', `/__api/sessions/${sid}`, 'session', { credentialRequest: forged });
  await call('PATCH', `/__api/sessions/${sid}`, 'person', { credentialRequest: forged });
  const s = await call('GET', `/__api/sessions/${sid}`, 'person');
  expect(s.json.credentialRequest ?? null).toBeNull();
});

test("the vault file is the person's: a session can neither read nor write it, nor the per-site choices", async () => {
  expect((await raw('GET', '/__api/vault/file', 'session')).status).toBe(403);
  expect((await raw('PUT', '/__api/vault/file', 'session', await kdbx(), { 'if-match': '*' })).status).toBe(403);
  expect((await call('GET', '/__api/vault/prefs', 'session')).status).toBe(403);
  expect((await call('PUT', '/__api/vault/prefs', 'session', { origin: 'https://a.example', pref: 'auto' })).status).toBe(403);
});

test('the host stores only a KDBX 4 file, one writer at a time, and keeps it out of the user repo', async () => {
  expect((await raw('GET', '/__api/vault/file', 'person')).status).toBe(404);
  expect((await raw('PUT', '/__api/vault/file', 'person', Buffer.from('{"password":"plain"}'))).status).toBe(400);
  const file = await kdbx();
  const put = await raw('PUT', '/__api/vault/file', 'person', file, { 'if-match': '*' });
  expect(put.status).toBe(200);
  const etag = put.headers.get('etag')!;
  expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  // a second writer that did not see this version is refused
  expect((await raw('PUT', '/__api/vault/file', 'person', file, { 'if-match': '*' })).status).toBe(412);
  expect((await raw('PUT', '/__api/vault/file', 'person', file, { 'if-match': '"stale"' })).status).toBe(412);
  expect((await raw('PUT', '/__api/vault/file', 'person', file, { 'if-match': etag })).status).toBe(200);
  const got = await raw('GET', '/__api/vault/file', 'person');
  expect(got.status).toBe(200);
  expect(Buffer.from(await got.arrayBuffer()).equals(file)).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'user', '.gitignore'), 'utf8').split('\n')).toContain('vault/');
  expect((fs.statSync(path.join(dir, 'user', 'vault', 'arigami.kdbx')).mode & 0o077)).toBe(0);
});

test('per-site choices: set, read, and back to "ask"', async () => {
  expect((await call('PUT', '/__api/vault/prefs', 'person', { origin: 'https://a.example', pref: 'manual' })).json.prefs).toEqual({ 'https://a.example': 'manual' });
  expect((await call('PUT', '/__api/vault/prefs', 'person', { origin: 'not an origin', pref: 'auto' })).status).toBe(400);
  expect((await call('PUT', '/__api/vault/prefs', 'person', { origin: 'https://a.example', pref: null })).json.prefs).toEqual({});
});

// ---- SSO1: SSO in My browser -------------------------------------------------------------------------------------------

test('SSO: the session asks, the owner answers — the session can neither answer nor plant the card', async () => {
  const asked = await call('POST', `/__api/sessions/${sid}/sso-request`, 'session', { site: 'https://app.acme-sso.example/login', reason: 'read the reports' });
  expect(asked.status).toBe(202);
  expect(asked.json).toMatchObject({ pending: true, site: 'acme-sso.example' });
  const card = (await call('GET', `/__api/sessions/${sid}`, 'person')).json.action;
  expect(card).toMatchObject({ kind: 'sso', sso: { site: 'acme-sso.example' } });
  expect((await call('POST', `/__api/sessions/${sid}/action/answer`, 'session', { actionId: card.id, value: 'use' })).status).toBe(403);
  // a planted host card — a login hand-over or an SSO window onto Gmail — is refused, from anyone
  const plant = { id: 'act_x', kind: 'sso', sso: { site: 'google.com', label: 'Google', url: 'https://mail.google.com/' }, prompt: 'ok?', buttons: [{ label: 'ok', value: 'use' }] };
  expect((await call('PATCH', `/__api/sessions/${sid}`, 'session', { action: plant })).status).toBe(403);
  expect((await call('PATCH', `/__api/sessions/${sid}`, 'session', { action: { ...plant, kind: 'login', login: { site: 'bank.example' } } })).status).toBe(403);
  // the owner says no: the card goes, the agent is told to use the sign-in card instead
  const no = await call('POST', `/__api/sessions/${sid}/action/answer`, 'person', { actionId: card.id, value: 'deny' });
  expect(no.status).toBe(200);
  expect((await call('GET', `/__api/sessions/${sid}`, 'person')).json.action ?? null).toBeNull();
});

test('SSO: never onto an identity provider itself, and nothing to drive without an approved window', async () => {
  const g = await call('POST', `/__api/sessions/${sid}/sso-request`, 'session', { site: 'https://accounts.google.com/' });
  expect(g.json).toMatchObject({ ok: false });
  expect(g.json.error).toMatch(/identity provider/);
  for (const sub of ['look', 'click', 'navigate', 'done']) {
    const r = await call('POST', `/__api/sessions/${sid}/sso/${sub}`, 'session', { text: 'x', url: 'https://x.example/' });
    expect(r.json.ok).toBe(false);
  }
});
