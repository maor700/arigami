// CHAT1 — "I answered the card and the chat is stuck". Against an ISOLATED
// host (tmp ARIGAMI_DIR, own port, auth off) with a stub `claude` that plays
// the CLI's side of the AskUserQuestion protocol: on a user line it emits the
// tool_use, then — exactly like the real MCP process — calls the host's
// permission endpoint through mcp/blocking-call.js and turns the permission
// result into the tool's result the way the CLI does (updatedInput.answers →
// "Your questions have been answered: …"). It also records every stdin line,
// so the test can prove nothing is written onto stdin while the tool waits
// (the old bug: a stdin tool_result cancelled the pending tool and the answer
// was dropped).
//
// Covers:
//   1. a question card answered from the cockpit resolves the SAME turn via
//      the permission result (delivered:'tool'), the stub sees the picks, the
//      transcript carries permission-answer{toolUseId, answers}, the session
//      goes back to idle — and stdin stayed silent meanwhile;
//   2. long-poll legs: with a 300 ms leg the MCP side re-attaches through
//      POST /__mcp/wait, and an answer that comes after several legs still
//      lands (the 5-minute fetch timeout is what used to kill it);
//   3. nothing pending any more (the card timed out) → the answer goes in as
//      a plain user message (delivered:'message') and the stub gets a user
//      line — the card is never silently swallowed;
//   4. /__mcp/wait with an unknown key → 404 (host restarted, request gone);
//   5. an old-style answer (content lines only) still maps onto the questions.
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
let stubDir: string; // per-session stub logs: <sid>.stdin.jsonl, <sid>.legs
let log = '';

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
    await sleep(40);
  }
  throw new Error('condition not met in time');
}
const chat = async (sid: string): Promise<any[]> => (await api('GET', `/__api/sessions/${sid}/chat`)).json;
const session = async (sid: string): Promise<any> => (await api('GET', `/__api/sessions/${sid}`)).json;
const stdinLines = (sid: string): any[] => {
  const f = path.join(stubDir, `${sid}.stdin.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const legs = (sid: string): number => {
  const f = path.join(stubDir, `${sid}.legs`);
  return fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8').trim() || 0) : 0;
};

async function newSession(title: string): Promise<string> {
  const r = await api('POST', '/__api/sessions', { title, cwd: dir });
  expect([200, 201]).toContain(r.status);
  return r.json.id as string;
}
// Drive the stub to raise a question card; returns the tool_use id + request id.
async function askQuestion(sid: string): Promise<{ toolUseId: string; requestId: string }> {
  expect((await api('POST', `/__api/sessions/${sid}/message`, { text: 'ask' })).status).toBe(200);
  const perm = await until(async () => (await chat(sid)).find((e) => e.kind === 'permission-request' && e.toolName === 'AskUserQuestion'));
  expect(perm.toolUseId).toMatch(/^toolu_/);
  expect((await session(sid)).claude.state).toBe('awaiting-input');
  return { toolUseId: perm.toolUseId, requestId: perm.requestId };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-CHAT1-host-'));
  stubDir = path.join(dir, 'stub');
  fs.mkdirSync(stubDir, { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bun
const fs=require('node:fs');
const { makeBlockingCall } = await import(${JSON.stringify(path.join(ROOT, 'mcp', 'blocking-call.js'))});
const SID=process.env.ARIGAMI_SESSION_ID; const HOST=process.env.ARIGAMI_URL; const DIR=${JSON.stringify(stubDir)};
const sidIdx=process.argv.indexOf('--session-id');const rsIdx=process.argv.indexOf('--resume');
const csid=sidIdx>0?process.argv[sidIdx+1]:rsIdx>0?process.argv[rsIdx+1]:'stub';
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
let legsN=0;
async function api(method,p,body){
  const r=await fetch(HOST+p,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await r.text(); let j; try{j=JSON.parse(text)}catch{j={raw:text}}
  if(!r.ok) throw new Error(j.error||(r.status+' '+text.slice(0,200)));
  if(j&&j.pending===true){legsN++;fs.writeFileSync(DIR+'/'+SID+'.legs',String(legsN));}
  return j;
}
const blockingCall=makeBlockingCall(api);
out({type:'system',subtype:'init',session_id:csid,model:'claude-stub',tools:['AskUserQuestion'],mcp_servers:[{name:'arigami',status:'connected'}]});
let n=0;let buf='';
process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;
  let j={};try{j=JSON.parse(line);}catch{}
  fs.appendFileSync(DIR+'/'+SID+'.stdin.jsonl',JSON.stringify(j)+'\\n');
  if(j.type!=='user')continue;
  const text=(j.message&&j.message.content||[]).map((b)=>b.type==='text'?b.text:'').join('');
  if(/\\bask\\b/.test(text)) { void ask(); return; }
  out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'echo: '+text}],usage:{input_tokens:10,output_tokens:5}}});
  out({type:'result',subtype:'success',session_id:csid,is_error:false,result:'echo',duration_ms:5,num_turns:1,total_cost_usd:0.01});
}});
async function ask(){
  const id='toolu_'+(++n)+'_'+Math.random().toString(36).slice(2,8);
  const input={questions:[{question:'Which color?',header:'Color',multiSelect:false,options:[{label:'Red',description:'warm'},{label:'Blue',description:'cool'}]}]};
  out({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id,name:'AskUserQuestion',input}],usage:{input_tokens:10,output_tokens:5}}});
  // The MCP process side: permission_prompt → host, long-polled.
  let perm;
  try { perm=await blockingCall('/__mcp/permission',{session_id:SID,tool_name:'AskUserQuestion',input,tool_use_id:id}); }
  catch(e){ perm={behavior:'deny',message:'arigami unreachable: '+e.message}; }
  let content;
  if(perm.behavior==='allow'){
    const answers=(perm.updatedInput&&perm.updatedInput.answers)||{};
    const y=input.questions.map(q=>answers[q.question]?'"'+q.question+'"="'+answers[q.question]+'"':null).filter(Boolean).join(', ');
    content=y?'Your questions have been answered: '+y+'. You can now continue with these answers in mind.':'The user did not answer the questions.';
  } else content='denied: '+perm.message;
  out({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content}]}});
  out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'got: '+content}],usage:{input_tokens:10,output_tokens:5}}});
  out({type:'result',subtype:'success',session_id:csid,is_error:false,result:'ok',duration_ms:5,num_turns:1,total_cost_usd:0.02});
}
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
      ARIGAMI_AUTH: 'off',
      ARIGAMI_SCREEN_ENABLED: '0',
      ARIGAMI_CLAUDE_BIN: stub,
      ARIGAMI_WA_DATA_DIR: path.join(dir, 'wa'),
      ARIGAMI_TELEMETRY: '0',
      ARIGAMI_DEFAULT_CWD: dir,
      ARIGAMI_WAIT_LEG_MS: '300', // long-poll legs: many per answer
      ARIGAMI_QUESTION_TIMEOUT_MS: '2500', // question cards expire fast (test 3)
      COMPOSIO_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
}, 60_000); // the host boot below waits up to 30s; bun caps hooks at 5s by default

afterAll(() => {
  try {
    host?.kill('SIGTERM');
  } catch {}
  // The isolated host's output, for a post-mortem when a test fails.
  try {
    fs.writeFileSync(path.join(dir, 'host.log'), log);
    if (process.env.CHAT1_TEST_VERBOSE) console.log(`host log: ${path.join(dir, 'host.log')}\n${log.slice(-4000)}`);
  } catch {}
});

test('question card answered from the cockpit resumes the same turn through the permission result — nothing on stdin meanwhile', async () => {
  const sid = await newSession('q1');
  const { toolUseId, requestId } = await askQuestion(sid);
  const stdinBefore = stdinLines(sid).filter((l) => l.type === 'user').length;
  // Give the stub a couple of legs first (300 ms each) — the answer must land
  // on a re-attached leg, not only on the first request.
  await sleep(800);
  const r = await api('POST', `/__api/sessions/${sid}/question/answer`, {
    toolUseId,
    content: 'Which color?: Red',
    answers: [{ question: 'Which color?', answer: 'Red' }],
  });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: true, delivered: 'tool', requestId });
  // The tool's own result shows the picks the way the CLI formats them.
  const res = await until(async () => (await chat(sid)).find((e) => e.kind === 'tool-result' && e.toolUseId === toolUseId));
  expect(String(res.content)).toContain('Your questions have been answered: "Which color?"="Red"');
  // Same-turn: the stub finished the turn on its own and the session is idle.
  await until(async () => (await session(sid)).claude.state === 'idle');
  const evs = await chat(sid);
  const ans = evs.find((e) => e.kind === 'permission-answer' && e.requestId === requestId);
  expect(ans).toMatchObject({ behavior: 'allow', toolUseId, answers: { 'Which color?': 'Red' } });
  expect(evs.filter((e) => e.kind === 'error').length).toBe(0);
  // The old bug: a tool_result / user message written onto stdin while the
  // tool waited. Only the 'ask' line itself may have reached stdin.
  expect(stdinLines(sid).filter((l) => l.type === 'user').length).toBe(stdinBefore);
  // Long-poll: the MCP side went through more than one leg.
  expect(legs(sid)).toBeGreaterThanOrEqual(2);
}, 20000);

test('an answer that arrives after several long-poll legs still lands (what the 5-minute fetch timeout used to kill)', async () => {
  const sid = await newSession('q2');
  const { toolUseId } = await askQuestion(sid);
  await sleep(1300); // ≥4 legs of 300 ms
  expect(legs(sid)).toBeGreaterThanOrEqual(3);
  const r = await api('POST', `/__api/sessions/${sid}/question/answer`, { toolUseId, answers: [{ question: 'Which color?', answer: 'Blue' }] });
  expect(r.json.delivered).toBe('tool');
  const res = await until(async () => (await chat(sid)).find((e) => e.kind === 'tool-result' && e.toolUseId === toolUseId));
  expect(String(res.content)).toContain('"Which color?"="Blue"');
  await until(async () => (await session(sid)).claude.state === 'idle');
}, 20000);

test('card that already timed out: the answer goes in as a message (delivered:"message"), never swallowed', async () => {
  const sid = await newSession('q3');
  const { toolUseId, requestId } = await askQuestion(sid);
  // Let the host's question timer (2.5 s) fire — the tool returns "denied:
  // … did not answer" and the turn ends; the card is now orphaned.
  const timedOut = await until(async () => (await chat(sid)).find((e) => e.kind === 'permission-answer' && e.requestId === requestId), 6000);
  expect(timedOut).toMatchObject({ behavior: 'deny', message: 'timed out', toolUseId });
  await until(async () => (await session(sid)).claude.state === 'idle');
  const r = await api('POST', `/__api/sessions/${sid}/question/answer`, { toolUseId, answers: [{ question: 'Which color?', answer: 'Red' }] });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: true, delivered: 'message' });
  // A user turn with the answer text — visible in the transcript and on stdin.
  const user = await until(async () => (await chat(sid)).find((e) => e.kind === 'user' && /Which color\?: Red/.test(e.text)));
  expect(user).toBeTruthy();
  const echoed = await until(async () => (await chat(sid)).find((e) => e.kind === 'assistant-text' && e.text.startsWith('echo: ') && e.text.includes('Which color?: Red')));
  expect(echoed).toBeTruthy();
  expect(stdinLines(sid).some((l) => l.type === 'user' && JSON.stringify(l).includes('Which color?: Red'))).toBe(true);
}, 20000);

test('/__mcp/wait with an unknown key → 404 (the request is gone, e.g. host restarted)', async () => {
  const r = await api('POST', '/__mcp/wait', { wait_key: 'wait_deadbeef-0000-0000-0000-000000000000' });
  expect(r.status).toBe(404);
  expect(r.json.error).toMatch(/unknown wait key/);
  expect((await api('POST', '/__mcp/wait', {})).status).toBe(404);
}, 20000);

test('old cockpit build: "label: answer" lines alone still map onto the questions', async () => {
  const sid = await newSession('q5');
  const { toolUseId } = await askQuestion(sid);
  const r = await api('POST', `/__api/sessions/${sid}/question/answer`, { toolUseId, content: 'Which color?: Blue' });
  expect(r.json.delivered).toBe('tool');
  const res = await until(async () => (await chat(sid)).find((e) => e.kind === 'tool-result' && e.toolUseId === toolUseId));
  expect(String(res.content)).toContain('"Which color?"="Blue"');
  expect((await api('POST', `/__api/sessions/${sid}/question/answer`, { toolUseId })).status).toBe(400);
}, 20000);
