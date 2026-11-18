// Engine-native scheduling / remote execution (session-profile.ts ENGINE_NATIVE_SCHEDULING) on an ISOLATED host with
// auth on and stub engines that record how they were started:
//   - a restricted CLAUDE session is spawned with all of them in --disallowedTools (hidden, not only refused);
//   - a restricted CODEX session gets the PreToolUse policy hook in $CODEX_HOME/hooks.json, and the host refuses each
//     name for it (codex ships no such tool of its own; the hook covers any that appears);
//   - even triggers:true does not bring them back; a Full session is spawned without any of it.
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


const NATIVE = ['RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'];
const disallowedOf = (argv: string[]) => {
  const i = argv.indexOf('--disallowedTools');
  return i >= 0 ? argv[i + 1].split(',') : [];
};

describe('engine-native scheduling is denied in every restricted profile', () => {
  test('claude: --disallowedTools carries every one of them; triggers:true does not bring them back; Full has none', async () => {
    const put = await call(admin, 'PUT', '/__api/session-profiles', { profiles: { cronny: { tools: ['git'], triggers: true } }, attach: {} });
    expect(put.status).toBe(200);
    const full = await create(admin, { title: 'full' });
    const r1 = await create(admin, { title: 'restricted', profile: 'restricted' });
    const r2 = await create(admin, { title: 'restricted, triggers on', profile: 'cronny' });
    const fullArgv = (await spawnOf(full.id)).argv;
    expect(fullArgv).not.toContain('--disallowedTools');
    for (const s of [r1, r2]) {
      const d = disallowedOf((await spawnOf(s.id)).argv);
      for (const t of NATIVE) expect(d).toContain(t);
      const tok = await tokenOf(s.id);
      const hidden = (await call(tok, 'GET', `/__api/sessions/${s.id}/policy?names=${NATIVE.join(',')}`)).json.hidden;
      expect(hidden.sort()).toEqual([...NATIVE].sort());
    }
  });

  test('codex: the restricted session gets the policy hook, and the host refuses each name for it', async () => {
    const full = await create(admin, { title: 'full codex', engine: 'codex' });
    const rc = await create(admin, { title: 'restricted codex', engine: 'codex', profile: 'restricted' });
    const home = (id: string) => path.join(dir, 'codex', id);
    await until(async () => fs.existsSync(path.join(home(rc.id), 'hooks.json')) && fs.existsSync(path.join(home(full.id), 'config.toml')));
    const hooks = JSON.parse(fs.readFileSync(path.join(home(rc.id), 'hooks.json'), 'utf8'));
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain('policy-hook.js');
    expect(fs.existsSync(path.join(home(full.id), 'hooks.json'))).toBe(false);
    // (the codex stub records no env; the verdict is the SESSION's policy whoever asks — the hook asks the same route)
    for (const t of NATIVE) {
      const v = await call(admin, 'POST', `/__api/sessions/${rc.id}/policy/check`, { tool_name: t, input: {} });
      expect(v.json.allow).toBe(false);
    }
  });
});
