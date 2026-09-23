// The login hand-over as a running host enforces it (auth ON — `pairing`, what a
// real host runs), from the two sides that matter:
//   - the SESSION (its own bearer token): may ask, may see which sites have a
//     login, may never see a value, and may never answer its own card
//   - the PERSON (a signed-in admin cookie): answers the card; the host acts
// Plus: a plain session can no longer push its whole profile into the owner's
// browser, and a plain session's browser profile starts empty.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ho from '../server/handoff.ts';
import { runInChild } from './_child.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'login-flow-host-test-secret-32chars';
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

/** A Chrome-shaped Cookies db with the columns the vault reads. */
function seedVault(vaultDir: string) {
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
  fs.mkdirSync(path.join(vaultDir, 'Default'), { recursive: true });
  const db = new Database(path.join(vaultDir, 'Default', 'Cookies'));
  db.run('create table cookies (host_key text, name text, value text, encrypted_value blob, expires_utc integer, is_httponly integer, is_secure integer)');
  // Chrome time: microseconds since 1601. One year from now.
  const future = (BigInt(Date.now()) * 1000n + 11644473600n * 1000000n + 365n * 86400n * 1000000n).toString();
  db.run(`insert into cookies values ('github.com', 'user_session', '', x'00', ${future}, 1, 1)`);
  db.run(`insert into cookies values ('.github.com', '_octo', '', x'00', ${future}, 0, 1)`);
  db.close();
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-login-flow-'));
  seedVault(path.join(dir, 'chrome-base'));
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
    fs.appendFileSync(path.join(os.tmpdir(), 'login-flow-host.log'), String(d));
  });
  host.stdout!.on('data', (d) => fs.appendFileSync(path.join(os.tmpdir(), 'login-flow-host.log'), String(d)));
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
  const created = await call('POST', '/__api/sessions', 'person', { title: 'login flow', cwd: ws });
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

test('the session sees WHICH sites have a login — and nothing else', async () => {
  const r = await call('GET', `/__api/sessions/${sid}/logins`, 'session');
  expect(r.status).toBe(200);
  expect(r.json.sites.map((s: any) => s.id)).toContain('github.com');
  expect(JSON.stringify(r.json)).not.toMatch(/user_session|_octo|value/);
});

test('a linked-device site is refused outright, with what to do instead', async () => {
  const r = await call('POST', `/__api/sessions/${sid}/login-request`, 'session', { site: 'web.whatsapp.com' });
  expect(r.json.available).toBe(false);
  expect(r.json.policy).toBe('never');
  expect(r.json.next).toMatch(/request_screen/);
});

test('a site with no login in the owner browser says so', async () => {
  const r = await call('POST', `/__api/sessions/${sid}/login-request`, 'session', { site: 'gitlab.com' });
  expect(r.json.available).toBe(false);
  expect(r.json.reason).toMatch(/no login for this site/);
});

test('a site with a login puts a card up for the person, and the session waits', async () => {
  const r = await call('POST', `/__api/sessions/${sid}/login-request`, 'session', { site: 'github', reason: 'open a PR' });
  expect(r.status).toBe(202);
  expect(r.json.pending).toBe(true);
  const s = await call('GET', `/__api/sessions/${sid}`, 'person');
  expect(s.json.action.kind).toBe('login');
  expect(s.json.action.login.site).toBe('github.com');
  expect(s.json.action.buttons.map((b: any) => b.value)).toEqual(['use', 'always', 'fresh', 'deny']);
});

test('the session cannot answer its own login card', async () => {
  const r = await call('POST', `/__api/sessions/${sid}/action/answer`, 'session', { value: 'use' });
  expect(r.status).toBe(403);
  const s = await call('GET', `/__api/sessions/${sid}`, 'person');
  expect(s.json.action?.kind).toBe('login'); // still waiting for a person
});

test("the person's refusal reaches the agent as a host line, and the card is gone", async () => {
  const r = await call('POST', `/__api/sessions/${sid}/action/answer`, 'person', { value: 'deny' });
  expect(r.status).toBe(200);
  const s = await call('GET', `/__api/sessions/${sid}`, 'person');
  expect(s.json.action ?? null).toBe(null);
  const chat = await until(async () => {
    const c = (await call('GET', `/__api/sessions/${sid}/chat`, 'person')).json as any[];
    return c.some((e) => JSON.stringify(e).includes('REFUSED the GitHub login')) ? c : null;
  });
  expect(chat.length).toBeGreaterThan(0);
});

test("a plain session can no longer push its whole profile into the owner's browser", async () => {
  const r = await call('POST', `/__api/sessions/${sid}/browser/sync-logins`, 'session', { shared: true });
  expect(r.status).toBe(409);
  expect(r.json.error).toMatch(/save_login/);
});

test("'my browser' is a person's: a session can neither list it nor open it", async () => {
  expect((await call('GET', '/__api/browser/vault', 'session')).status).toBe(403);
  expect((await call('POST', '/__api/browser/vault/open', 'session', {})).status).toBe(403);
  const mine = await call('GET', '/__api/browser/vault', 'person');
  expect(mine.status).toBe(200);
  expect(mine.json.logins.map((s: any) => s.id)).toContain('github.com');
});

test("a plain session's browser profile starts empty; an agent's starts from the agent's own", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'login-profile-'));
  const r = runInChild(
    `const fs = await import('node:fs'); const path = await import('node:path');
     const state = await import('./server/state.js');
     const chrome = await import('./server/lib/chrome.ts');
     fs.mkdirSync(path.join(chrome.CHROME_BASE_DIR, 'Default'), { recursive: true });
     fs.writeFileSync(path.join(chrome.CHROME_BASE_DIR, 'Default', 'Cookies'), 'OWNER LOGINS');
     const plain = state.createSession({ title: 'p' });
     const dirPlain = chrome.ensureSessionProfile(plain.id);
     const agentDir = chrome.agentBrowserDir('helper');
     fs.mkdirSync(path.join(agentDir, 'Default', 'Cache'), { recursive: true });
     fs.writeFileSync(path.join(agentDir, 'Default', 'Cookies'), 'AGENT IDENTITY');
     fs.writeFileSync(path.join(agentDir, 'Default', 'Cache', 'big'), 'x');
     const ag = state.createSession({ title: 'a', metadata: { agent: 'helper' } });
     const dirAgent = chrome.ensureSessionProfile(ag.id);
     emit({ plain: fs.readdirSync(dirPlain), agentCookies: fs.readFileSync(path.join(dirAgent, 'Default', 'Cookies'), 'utf8'), agentCache: fs.existsSync(path.join(dirAgent, 'Default', 'Cache')) });`,
    { ARIGAMI_DIR: sandbox, ARIGAMI_STATE_FILE: path.join(sandbox, 'state.json') }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].plain).toEqual([]); // nothing of the owner's
  expect(r.out[0].agentCookies).toBe('AGENT IDENTITY');
  expect(r.out[0].agentCache).toBe(false); // caches are not identity
});
