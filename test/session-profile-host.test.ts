// Restricted run mode end-to-end against an ISOLATED host with authentication ON (tmp ARIGAMI_DIR, own port, a stub
// `claude` that records its argv + env, so each session's own bearer token is the one its process got):
//   - a Full session's spawn carries no policy flags; a restricted child's carries --disallowedTools + the hook;
//   - the child inherits and can only narrow (explicit widening is ignored), whichever create path;
//   - a restricted token reaches its own session, its parent (send) and its children, and nothing else (403);
//   - send/task/report cannot be pointed at a stranger or sent under another name; no cron/listener without the flag;
//   - its own PATCH cannot change who it reports to, its agent or its screen;
//   - a Full session keeps today's reach (any session, triggers, config).
import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
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
let dir: string;
let base: string;
let port: number;
let rec: string;
let admin: string; // an API token of the paired admin

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
async function call(token: string | null, method: string, p: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: { raw: text } };
  }
}
const spawnOf = (sid: string): Promise<{ argv: string[]; env: Record<string, string> }> =>
  until(async () => {
    const f = path.join(rec, `${sid}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  });
const tokenOf = async (sid: string) => (await spawnOf(sid)).env.ARIGAMI_TOKEN;
async function create(token: string, body: Record<string, unknown>): Promise<any> {
  const r = await call(token, 'POST', '/__api/sessions', body);
  expect(r.status).toBe(201);
  return r.json;
}

beforeAll(async () => {
  dir = tmpDir('arigami-profiles-host-');
  rec = path.join(dir, 'rec');
  fs.mkdirSync(rec, { recursive: true });
  const ws = tmpDir('arigami-profiles-ws-');
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bun
const fs=require('node:fs');
if(process.env.ARIGAMI_SESSION_ID) fs.writeFileSync(${JSON.stringify(rec)}+'/'+process.env.ARIGAMI_SESSION_ID+'.json',JSON.stringify({argv:process.argv.slice(2),env:process.env}));
const i=process.argv.indexOf('--session-id');const sid=i>0?process.argv[i+1]:'stub';
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
out({type:'system',subtype:'init',session_id:sid,model:'claude-stub',tools:['Bash','Read'],mcp_servers:[{name:'arigami',status:'connected'}]});
let buf='';process.stdin.on('data',(d)=>{buf+=d;let k;while((k=buf.indexOf('\\n'))>=0){const line=buf.slice(0,k);buf=buf.slice(k+1);let j={};try{j=JSON.parse(line);}catch{}
  if(j.type!=='user')continue;
  out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'ok'}],usage:{input_tokens:1,output_tokens:1}}});
  out({type:'result',subtype:'success',session_id:sid,is_error:false,result:'ok',duration_ms:1,num_turns:1,total_cost_usd:0});
}});
setInterval(()=>{},1e6);
`,
    { mode: 0o755 }
  );
  // codex: a stub that idles; prepare() only symlinks this auth file (agents-engine-host.test.ts does the same).
  const codexStub = path.join(dir, 'codex-stub.sh');
  fs.writeFileSync(codexStub, '#!/bin/sh\nexec sleep 3600\n', { mode: 0o755 });
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
      ARIGAMI_AUTH: 'pairing',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_CODEX_BIN: codexStub,
      ARIGAMI_CODEX_HOME: codexHome,
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: ws,
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
  const cookie = String(pr.headers.get('set-cookie') || '').split(';')[0];
  const tr = await fetch(base + '/__api/auth/tokens', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ label: 'test' }) });
  expect(tr.status).toBe(201);
  admin = (await tr.json()).token;
}, 60_000);

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
});

describe('restricted sessions on a real host (auth on)', () => {
  let full: string, stranger: string, worker: string, kid: string;
  let tFull: string, tWorker: string, tKid: string;

  test('profiles are an admin surface; a Full session can read them, not write them', async () => {
    const put = await call(admin, 'PUT', '/__api/session-profiles', {
      profiles: { worker: { tools: ['git'], maySpawn: true, desktop: 'own', talkTo: ['parent', 'children'] } },
      attach: {},
    });
    expect(put.status).toBe(200);
    expect(put.json.profiles.worker.maySpawn).toBe(true);
    full = (await create(admin, { title: 'full' })).id;
    stranger = (await create(admin, { title: 'stranger' })).id;
    tFull = await tokenOf(full);
    expect((await call(tFull, 'GET', '/__api/session-profiles')).status).toBe(200);
    expect((await call(tFull, 'PUT', '/__api/session-profiles', { profiles: {} })).status).toBe(403);
    expect((await call(admin, 'PUT', '/__api/session-profiles', { profiles: { 'Bad Id': {} } })).status).toBe(400);
  });

  test('a Full session is spawned exactly as before: no profile, no policy flags, no profile env', async () => {
    const s = (await call(admin, 'GET', `/__api/sessions/${full}`)).json;
    expect(s.profile).toBeUndefined();
    const sp = await spawnOf(full);
    expect(sp.argv).not.toContain('--disallowedTools');
    expect(sp.argv).not.toContain('--settings');
    expect(sp.env.ARIGAMI_PROFILE).toBeUndefined();
  });

  test('a Full session creates a restricted child; the child is spawned with host-enforced limits', async () => {
    const c = await create(tFull, { title: 'worker', profile: 'worker' });
    worker = c.id;
    expect(c.profile).toMatchObject({ name: 'worker', parent: full, maySpawn: true, desktop: 'own' });
    const sp = await spawnOf(worker);
    const dis = sp.argv[sp.argv.indexOf('--disallowedTools') + 1];
    expect(dis.split(',')).toContain('WebFetch');
    expect(dis.split(',')).toContain('CronCreate');
    expect(sp.argv).toContain('--settings');
    expect(sp.env.ARIGAMI_PROFILE).toBe('worker');
    tWorker = sp.env.ARIGAMI_TOKEN;
  });

  test('unknown profile ids and host-shaped profiles are refused', async () => {
    expect((await call(admin, 'POST', '/__api/sessions', { title: 'x', profile: 'nope' })).status).toBe(400);
    expect((await call(admin, 'POST', '/__api/sessions', { title: 'x', profile: { layers: [] } })).status).toBe(400);
  });

  test('its children inherit and can only narrow — asking for more changes nothing', async () => {
    const c = await create(tWorker, { title: 'kid', profile: { tools: null, desktop: 'shared', maySpawn: true, triggers: true, hostRoutes: ['memory'] } });
    kid = c.id;
    expect(c.profile).toMatchObject({ parent: worker, desktop: 'own', maySpawn: true, triggers: false, hostRoutes: [] });
    expect(c.metadata.master).toBe(worker);
    tKid = await tokenOf(kid);
    const k = (await call(tKid, 'GET', `/__api/sessions/${kid}/policy?names=WebFetch,cronjob,memory_write,create_session,report_to_master`)).json;
    expect(k.hidden.sort()).toEqual(['WebFetch', 'cronjob', 'memory_write']);
    // a dispatch child (kind) also inherits
    const d = await call(tWorker, 'POST', '/__api/sessions', { title: 'ro', kind: 'readonly', master: worker });
    expect(d.status).toBe(201);
    expect(d.json.profile).toMatchObject({ parent: worker, name: 'worker' });
    expect((await call(tWorker, 'DELETE', `/__api/sessions/${d.json.id}`)).status).toBe(200);
    // never under another master, never as an agent
    expect((await call(tWorker, 'POST', '/__api/sessions', { title: 'x', kind: 'readonly', master: stranger })).status).toBe(403);
    expect((await call(tWorker, 'POST', '/__api/sessions', { title: 'x', agent: 'anyone' })).status).toBe(403);
    // a child without maySpawn cannot spawn at all
    const leaf = await create(tWorker, { title: 'leaf', profile: { maySpawn: false } });
    expect((await call(await tokenOf(leaf.id), 'POST', '/__api/sessions', { title: 'x' })).status).toBe(403);
    expect((await call(tWorker, 'DELETE', `/__api/sessions/${leaf.id}`)).status).toBe(200);
  });

  test('its token reaches its own session, its family and nothing else', async () => {
    expect((await call(tWorker, 'GET', `/__api/sessions/${worker}`)).status).toBe(200);
    expect((await call(tWorker, 'GET', `/__api/sessions/${kid}`)).status).toBe(200);
    expect((await call(tWorker, 'GET', `/__api/sessions/${stranger}`)).status).toBe(403);
    expect((await call(tWorker, 'GET', `/__api/sessions/${full}`)).status).toBe(403); // its parent: send only
    const list = (await call(tWorker, 'GET', '/__api/sessions?full=1')).json.map((s: any) => s.id).sort();
    expect(list).toEqual([full, worker, kid].sort());
    for (const [m, p] of [['GET', '/__api/config'], ['GET', '/__api/triggers'], ['POST', '/__api/triggers'], ['GET', '/__api/memory/search?query=x'], ['GET', '/__api/agents'], ['GET', '/__api/accounts'], ['PUT', '/__api/session-profiles'], ['POST', `/__api/sessions/${worker}/listeners`], ['POST', `/__api/sessions/${worker}/adopt-agent`], ['DELETE', `/__api/sessions/${stranger}`], ['POST', `/__api/sessions/${stranger}/send`], ['GET', '/__artifacts/'], ['POST', '/__api/host/restart']])
      expect([m, p, (await call(tWorker, m, p, m === 'GET' ? undefined : {})).status]).toEqual([m, p, 403]);
  });

  test('no WebSocket for a restricted token', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/__ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', authorization: `Bearer ${tWorker}` } });
      req.on('upgrade', (res) => resolve(res.statusCode || 101));
      req.on('response', (res) => resolve(res.statusCode || 0));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  test('messaging: parent and own children only, always as itself', async () => {
    expect((await call(tWorker, 'POST', `/__api/sessions/${full}/send`, { text: 'hi parent', from: worker })).status).toBe(200);
    expect((await call(tWorker, 'POST', `/__api/sessions/${kid}/send`, { text: 'hi kid', from: worker })).status).toBe(200);
    expect((await call(tWorker, 'POST', `/__api/sessions/${full}/send`, { text: 'spoof', from: stranger })).status).toBe(403);
    expect((await call(tWorker, 'POST', `/__api/sessions/${stranger}/send`, { text: 'x', from: worker })).status).toBe(403);
    expect((await call(tKid, 'POST', `/__api/sessions/${full}/send`, { text: 'grandparent', from: kid })).status).toBe(403);
    // report_to_master wakes the recorded parent, never one it names
    const r = await call(tKid, 'POST', `/__api/sessions/${kid}/report`, { state: 'milestone', note: 'n', master: stranger });
    expect(r.status).toBe(200);
    expect(r.json.master).toBe(worker);
    // a blocking host call must name its own session
    expect((await call(tWorker, 'POST', '/__mcp/permission', { session_id: stranger, tool_name: 'Bash' })).status).toBe(403);
  });

  test('its own PATCH: cockpit fields only — never its parent, its agent, its screen, archive or folder', async () => {
    const r = await call(tWorker, 'PATCH', `/__api/sessions/${worker}`, { title: 'renamed', archived: true, folderId: 'fld_x', metadata: { note: 1, master: stranger, agent: 'bot', screen: { vncPort: 5900 } } });
    expect(r.status).toBe(200);
    const s = (await call(admin, 'GET', `/__api/sessions/${worker}`)).json;
    expect(s.title).toBe('renamed');
    expect(s.archived).toBe(false);
    expect(s.metadata.note).toBe(1);
    expect(s.metadata.master).toBeUndefined();
    expect(s.metadata.agent).toBeUndefined();
    expect(s.metadata.screen).toBeUndefined();
    expect(s.profile.parent).toBe(full);
  });

  test('the policy check the PreToolUse hook asks (claude and codex alike) answers from the profile', async () => {
    expect((await call(tWorker, 'POST', `/__api/sessions/${worker}/policy/check`, { tool_name: 'WebFetch', input: {} })).json.allow).toBe(false);
    expect((await call(tWorker, 'POST', `/__api/sessions/${worker}/policy/check`, { tool_name: 'shell', input: {} })).json.allow).toBe(true); // codex alias of Bash
    expect((await call(tWorker, 'POST', `/__api/sessions/${worker}/policy/check`, { tool_name: 'mcp__arigami__cronjob', input: {} })).json.allow).toBe(false);
  });

  test('triggers: only when the profile allows, only its own, only to its family', async () => {
    await call(admin, 'PUT', '/__api/session-profiles', { profiles: { worker: { tools: ['git'], maySpawn: true, desktop: 'own' }, sched: { tools: ['git'], triggers: true } }, attach: {} });
    const sched = await create(tFull, { title: 'sched', profile: 'sched' });
    const tS = await tokenOf(sched.id);
    expect((await call(tS, 'POST', '/__api/triggers', { type: 'cron', name: 'x', prompt: 'p', schedule: { kind: 'interval', value: '1h' }, sessionMode: `existing:${stranger}` })).status).toBe(403);
    expect((await call(tS, 'POST', '/__api/triggers', { type: 'linear', name: 'x' })).status).toBe(403);
    const own = await call(tS, 'POST', '/__api/triggers', { type: 'cron', name: 'mine', prompt: 'p', schedule: { kind: 'interval', value: '1h' } });
    expect(own.status).toBe(201);
    const ownerTrig = await call(admin, 'POST', '/__api/triggers', { type: 'cron', name: 'owner', prompt: 'p', schedule: { kind: 'interval', value: '1h' } });
    expect(ownerTrig.status).toBe(201);
    expect((await call(tS, 'GET', '/__api/triggers')).json.map((t: any) => t.id)).toEqual([own.json.id]);
    expect((await call(tS, 'DELETE', `/__api/triggers/${ownerTrig.json.id}`)).status).toBe(403);
    expect((await call(tS, 'PATCH', `/__api/triggers/${own.json.id}`, { sessionMode: `existing:${stranger}` })).status).toBe(403);
    // its runs are born under its profile, with it as the parent
    const run = await call(admin, 'POST', `/__api/triggers/${own.json.id}/run`);
    expect(run.status).toBe(200);
    const runS = (await call(admin, 'GET', `/__api/sessions/${run.json.sessionId}`)).json;
    expect(runS.profile).toMatchObject({ parent: sched.id, triggers: true });
    // a listener is its own session's only
    expect((await call(tS, 'POST', `/__api/sessions/${sched.id}/listeners`, { type: 'host-load', threshold: 99 })).status).not.toBe(403);
  });

  test('a project folder and an agent can carry a profile; their sessions get it', async () => {
    const f = await call(admin, 'POST', '/__api/folders', { name: 'locked' });
    expect(f.status).toBe(201);
    expect((await call(admin, 'POST', '/__api/agents', { name: 'Helper', slug: 'helper' })).status).toBe(201);
    await call(admin, 'PUT', '/__api/session-profiles', { profiles: { worker: { tools: ['git'], maySpawn: true, desktop: 'own' } }, attach: { [`folder:${f.json.id}`]: 'worker', 'agent:helper': 'restricted' } });
    const inFolder = await create(admin, { title: 'in folder', folderId: f.json.id });
    expect(inFolder.profile).toMatchObject({ name: 'worker' });
    const fromAgent = await create(admin, { title: 'from agent', agent: 'helper' });
    expect(fromAgent.profile).toMatchObject({ name: 'Restricted', maySpawn: false });
    // the A3 agent policy and the profile are both in force
    const sp = await spawnOf(fromAgent.id);
    expect(sp.argv).toContain('--settings');
  });

  test('codex: the same profile installs the policy hook in $CODEX_HOME; a Full codex session gets none', async () => {
    const fullCodex = await create(admin, { title: 'full codex', engine: 'codex' });
    const restrictedCodex = await create(tFull, { title: 'restricted codex', engine: 'codex', profile: 'restricted' });
    const home = (id: string) => path.join(dir, 'codex', id);
    await until(async () => fs.existsSync(path.join(home(restrictedCodex.id), 'config.toml')) && fs.existsSync(path.join(home(fullCodex.id), 'config.toml')));
    const hooks = path.join(home(restrictedCodex.id), 'hooks.json');
    await until(async () => fs.existsSync(hooks));
    expect(JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks.PreToolUse[0].hooks[0].command).toContain('policy-hook.js');
    expect(fs.existsSync(path.join(home(fullCodex.id), 'hooks.json'))).toBe(false);
    // the host side is engine-blind: the codex session's token is scoped exactly like a claude one
    const rs = (await call(admin, "GET", `/__api/sessions/${restrictedCodex.id}`)).json;
    expect(rs.profile).toMatchObject({ name: 'Restricted', parent: full });
  });

  test('a Full session keeps today\'s reach', async () => {
    expect((await call(tFull, 'GET', `/__api/sessions/${stranger}`)).status).toBe(200);
    expect((await call(tFull, 'POST', `/__api/sessions/${stranger}/send`, { text: 'hi', from: full })).status).toBe(200);
    expect((await call(tFull, 'GET', '/__api/triggers')).status).toBe(200);
    expect((await call(tFull, 'GET', '/__api/config')).status).toBe(200);
    expect((await call(tFull, 'GET', '/__api/sessions?full=1')).json.length).toBeGreaterThan(4);
  });
});
