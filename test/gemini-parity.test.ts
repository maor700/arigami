// Gemini as a peer of claude and codex: the pre-tool hook, native skills, the model ladder, the 3-minute tool wait,
// the question card, sign-in and cleanup. Facts marked "measured" were probed against agy 1.5.14 (docs/ENGINES.md).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';
import { hookDecision, hooksJson, skillStub, agyConversationPaths, readsOnlyUnder } from '../server/lib/gemini-cli.ts';
import { makeBlockingCall, stillWaiting } from '../mcp/blocking-call.js';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(ROOT, 'mcp/policy-hook.js');

let dir: string;
let fakeAgy: string;
let gemHome: string;
beforeAll(() => {
  dir = tmpDir('gem-parity-');
  gemHome = path.join(dir, 'gemini');
  // a fake agy: `acp --login` prints a Google link, reads the code, and "signs in" by writing the token file
  fakeAgy = path.join(dir, 'agy');
  fs.writeFileSync(
    fakeAgy,
    `#!/bin/sh\ncase "$*" in *--login*)\n  echo "Open this link in a browser to log in with Google:"; echo "  https://accounts.google.com/o/oauth2/auth?client_id=x&state=y"\n  read code\n  if [ "$code" = "good-code" ]; then mkdir -p "$ARIGAMI_GEMINI_HOME/antigravity-cli"; echo tok > "$ARIGAMI_GEMINI_HOME/antigravity-cli/antigravity-oauth-token"; echo "Logged in."; else echo "login failed: invalid authorization code"; exit 1; fi;;\nesac\nexit 0\n`,
    { mode: 0o755 }
  );
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const signIn = () => {
  fs.mkdirSync(path.join(gemHome, 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(gemHome, 'antigravity-cli', 'antigravity-oauth-token'), 'x');
};
const env = (extra: Record<string, string> = {}) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_PORT: '',
  ARIGAMI_FUNNEL_QUIET: '1',
  ARIGAMI_AGY_BIN: fakeAgy,
  ARIGAMI_GEMINI_HOME: gemHome,
  CLAUDE_CONFIG_DIR: path.join(dir, 'no-claude-config'),
  ...extra,
});

const PRELUDE =
  "const st=await import('./server/state.ts');" +
  "const cl=await import('./server/claude.js');" +
  "const g=await import('./server/gemini-acp.ts');" +
  "const api=await import('./server/api.ts');" +
  "const fs=await import('node:fs');const path=await import('node:path');" +
  "const s=st.createSession({title:'gem',engine:'gemini',cwd:process.cwd()});" +
  'const wrote=[];' +
  "const proc={id:s.id,sent:[],resume:false,child:{stdin:{writableEnded:false,destroyed:false,write:(l)=>wrote.push(JSON.parse(l))},once(){}}};" +
  'const A=g.stateOf(s.id);A.proc=proc;A.ready=true;A.modeId="default";A.sessionId="sid1";' +
  'const tick=()=>new Promise((r)=>setTimeout(r,20));' +
  'const chat=()=>cl.getChat(s.id,0);' +
  "const up=(u)=>g.acpHandleEvent(s.id,{jsonrpc:'2.0',method:'session/update',params:{sessionId:'sid1',update:u}});";

function run(body: string, extra: Record<string, string> = {}) {
  const r = runInChild(PRELUDE + body, env(extra));
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}
const of = (events: any[], kind: string) => events.filter((e: any) => e.kind === kind);

// ---- the pre-tool hook -------------------------------------------------------------------

test('hook answers: bypass allows, ask mode sends an edit to a card, agy keeps its own default for the rest', () => {
  expect(hookDecision('bypassPermissions', 'Bash')).toBe('allow');
  expect(hookDecision(null, 'Write')).toBe('allow');
  expect(hookDecision('default', 'Write')).toBe('force_ask'); // measured: a workspace edit raises no request unless forced
  expect(hookDecision('default', 'Edit')).toBe('force_ask');
  expect(hookDecision('default', 'Bash')).toBe('ask'); // agy asks for commands and MCP tools by itself
  expect(hookDecision('default', 'Read')).toBe('ask');
  expect(hookDecision('acceptEdits', 'Write')).toBe('allow');
  expect(hookDecision('acceptEdits', 'Bash')).toBe('ask');
  expect(hookDecision('plan', 'Write')).toBe('ask');
  // a skill file outside the workspace is read without a card; anything else, or a write, is not
  expect(readsOnlyUnder('Read', { Path: '/pack/dispatch/SKILL.md' }, ['/pack', null])).toBe(true);
  expect(readsOnlyUnder('Grep', { SearchPath: '/pack/x', Query: 'a' }, ['/pack'])).toBe(true);
  expect(readsOnlyUnder('Read', { Path: '/pack/../etc/passwd' }, ['/pack'])).toBe(false);
  expect(readsOnlyUnder('Read', { Path: '/packed/x' }, ['/pack'])).toBe(false);
  expect(readsOnlyUnder('Write', { Path: '/pack/x' }, ['/pack'])).toBe(false);
  expect(readsOnlyUnder('Read', {}, ['/pack'])).toBe(false);
  const h = JSON.parse(hooksJson('bun hook --agy', { post: true }));
  expect(h.arigami.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: 'bun hook --agy', timeout: 30 }] }]);
  expect(h.arigami.PostToolUse).toHaveLength(1);
  expect(JSON.parse(hooksJson('x')).arigami.PostToolUse).toBeUndefined();
});

test('the session dir: hooks.json runs the policy hook in agy\'s dialect, every Arigami skill gets a native stub, and the spawn adds the dir', () => {
  signIn();
  const out = run(
    "const d=g.writeSessionDir(s);const b=g.acpBuildSpawn(s,{resume:false,sessionId:null});" +
      "const hooks=JSON.parse(fs.readFileSync(path.join(d,'.agents','hooks.json'),'utf8'));" +
      "const skills=fs.readdirSync(path.join(d,'.agents','skills')).sort();" +
      "const stub=fs.readFileSync(path.join(d,'.agents','skills','dispatch','SKILL.md'),'utf8');" +
      "const ag=await import('./server/agents.ts');ag.createAgent({name:'Reader',slug:'reader',tools:['web']});st.patchSession(s.id,{metadata:{agent:'reader'}});" +
      "g.writeSessionDir(st.getSession(s.id));const restricted=JSON.parse(fs.readFileSync(path.join(d,'.agents','hooks.json'),'utf8'));" +
      'emit({d,args:b.args,cmd:hooks.arigami.PreToolUse[0].hooks[0].command,post:!!hooks.arigami.PostToolUse,skills,stub,rcmd:restricted.arigami.PreToolUse[0].hooks[0].command});'
  );
  expect(out.d).toBe(path.join(dir, 'gemini', path.basename(out.d)));
  expect(out.args).toEqual(['acp', '--gemini-dir', gemHome, '--add-dir', out.d]);
  expect(out.cmd).toContain('policy-hook.js');
  expect(out.cmd).toContain('--agy');
  expect(out.cmd).not.toContain('--restricted');
  expect(out.rcmd).toContain('--restricted'); // an agent with an allowlist fails closed
  expect(out.post).toBe(false); // PostToolUse only while a mod is installed
  for (const name of ['dispatch', 'project-manager', 'explain-changes', 'machine-work', 'connect-gemini']) expect(out.skills).toContain(name);
  expect(out.skills.some((n: string) => n.startsWith('_'))).toBe(false);
  expect(out.stub).toMatch(/^---\nname: dispatch\ndescription: ".+"\n---\n/);
  expect(out.stub).toContain(path.join(ROOT, 'skills', 'dispatch', 'SKILL.md'));
  expect(skillStub('x', 'a  "quoted"\nline', '/pack/x')).toBe('---\nname: x\ndescription: "a \\"quoted\\" line"\n---\nThis is an Arigami skill. Read /pack/x/SKILL.md now and follow it exactly; any path it mentions is relative to /pack/x.\n');
});

test('tool check: an agent allowlist denies with a reason the model reads; otherwise the permission mode decides', () => {
  const out = run(
    "A.servers=['arigami','composio-mcp'];" +
      "const free={bypass:g.geminiToolCheck(s.id,'run_command',{CommandLine:'ls'}).decision};" +
      "st.setClaude(s.id,{permissionMode:'default'});" +
      "free.askEdit=g.geminiToolCheck(s.id,'write_file',{Path:'/w/a',Content:'x'}).decision;free.askCmd=g.geminiToolCheck(s.id,'run_command',{CommandLine:'ls'}).decision;" +
      "const ag=await import('./server/agents.ts');ag.createAgent({name:'Reader',slug:'reader',tools:['web']});st.patchSession(s.id,{metadata:{agent:'reader'}});" +
      "const cmd=g.geminiToolCheck(s.id,'run_command',{CommandLine:'rm -rf x'});" +
      "const edit=g.geminiToolCheck(s.id,'write_file',{Path:'/w/a',Content:'x'});" +
      "const mail=g.geminiToolCheck(s.id,'mcp_composio-mcp_GMAIL_SEND_EMAIL',{to:'a'});" +
      "const read=g.geminiToolCheck(s.id,'read_file',{Path:'/w/a'});" +
      "const core=g.geminiToolCheck(s.id,'mcp_arigami_set_status',{status:'x'});" +
      // the failed card shows why
      "up({sessionUpdate:'tool_call',toolCallId:'c1',name:'run_command',status:'in_progress',kind:'execute',rawInput:{CommandLine:'rm -rf x'}});" +
      "up({sessionUpdate:'tool_call_update',toolCallId:'c1',name:'run_command',status:'failed',rawOutput:{output:''}});" +
      'emit({free,cmd,edit,mail,read:read.decision,core:core.decision,card:chat().find((e)=>e.kind==="tool-result")});'
  );
  expect(out.free).toEqual({ bypass: 'allow', askEdit: 'force_ask', askCmd: 'ask' });
  expect(out.cmd.decision).toBe('deny');
  expect(out.cmd.reason).toContain('[arigami policy]');
  expect(out.cmd.reason).toContain('"Bash" is not in agent reader\'s allowlist');
  expect(out.cmd.tool.name).toBe('Bash');
  expect(out.edit.decision).toBe('deny'); // a file edit is checked too — it never reached the permission request
  expect(out.mail.decision).toBe('deny');
  expect(out.mail.tool.name).toBe('mcp__composio-mcp__GMAIL_SEND_EMAIL');
  expect(out.read).toBe('ask'); // read-only built-ins and the core host tools stay available
  expect(out.core).toBe('ask');
  expect(out.card).toMatchObject({ isError: true });
  expect(out.card.content).toContain('[arigami policy]');
});

// The hook script itself, against a fake host. Async spawn: an in-process server and spawnSync deadlock in bun.
function hookRun(args: string[], stdin: unknown, envExtra: Record<string, string>): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['--no-env-file', HOOK, ...args], { env: { ...process.env, ...envExtra }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ out, code }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

test('policy-hook --agy: relays the host\'s decision, and a dead host means ask — or deny for a restricted agent', async () => {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url!.endsWith('/gemini/tool-check') ? { decision: 'deny', reason: '[arigami policy] no shell' } : { pass: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const live = { ARIGAMI_URL: `http://127.0.0.1:${port}`, ARIGAMI_TOKEN: 'tok', ARIGAMI_SESSION_ID: 'sess_h' };
  const pre = { hookEventName: 'PreToolUse', toolCall: { id: 'toolu_1', name: 'run_command', args: { CommandLine: 'ls' } } };
  try {
    const denied = await hookRun(['--agy', '--mods'], pre, live);
    expect(JSON.parse(denied.out)).toEqual({ decision: 'deny', reason: '[arigami policy] no shell' });
    expect(denied.code).toBe(0);
    expect(seen[0]).toMatchObject({ url: '/__api/sessions/sess_h/gemini/tool-check', auth: 'Bearer tok', body: { name: 'run_command', args: { CommandLine: 'ls' }, tool_use_id: 'toolu_1', mods: true } });
    // PostToolUse: agy hands over no output, so it only closes the mods chain
    const post = await hookRun(['--agy', '--mods'], { ...pre, hookEventName: 'PostToolUse' }, live);
    expect(JSON.parse(post.out)).toEqual({});
    expect(seen[1].url).toBe('/__api/sessions/sess_h/mods/tool-post');
  } finally {
    server.close();
  }
  const dead = { ARIGAMI_URL: 'http://127.0.0.1:1', ARIGAMI_TOKEN: 'tok', ARIGAMI_SESSION_ID: 'sess_h' };
  expect(JSON.parse((await hookRun(['--agy'], pre, dead)).out)).toEqual({ decision: 'ask' });
  const closed = JSON.parse((await hookRun(['--agy', '--restricted'], pre, dead)).out);
  expect(closed.decision).toBe('deny');
  expect(closed.reason).toContain('cannot verify "run_command"');
  // not an Arigami session (agy run by hand with the same hooks file): agy's own default
  expect(JSON.parse((await hookRun(['--agy'], pre, { ARIGAMI_SESSION_ID: '' })).out)).toEqual({ decision: 'ask' });
}, 60000);

// ---- the 3-minute tool wait ---------------------------------------------------------------

test('a blocking tool answers still_waiting before agy gives up, and the same key resumes the same request', async () => {
  const calls: any[] = [];
  let answer: ((v: unknown) => void) | null = null;
  const landed = new Promise((r) => (answer = r));
  // the host: every leg stays pending until the human answers
  const api = async (_m: string, p: string, body: any) => {
    calls.push({ p, key: body.wait_key });
    return Promise.race([landed, new Promise((r) => setTimeout(() => r({ pending: true, wait_key: body.wait_key }), 40))]);
  };
  const blockingCall = makeBlockingCall(api, { maxWaitMs: 100 });
  const first: any = await blockingCall('/__mcp/screen-request', { prompt: 'log in' });
  expect(first.still_waiting).toBe(true);
  expect(first.wait_key).toMatch(/^wait_/);
  expect(first.hint).toContain(`"wait_key":"${first.wait_key}"`);
  expect(calls[0]).toEqual({ p: '/__mcp/screen-request', key: first.wait_key });
  const n = calls.length;
  setTimeout(() => answer!({ status: 'done' }), 30);
  const second = await blockingCall('/__mcp/screen-request', { prompt: 'log in' }, first.wait_key);
  expect(second).toEqual({ status: 'done' });
  // the resume re-attached by key: no second screen request was filed
  expect(calls.slice(n).every((c) => c.p === '/__mcp/wait' && c.key === first.wait_key)).toBe(true);
  // other engines keep waiting as long as it takes
  const forever = makeBlockingCall(async () => ({ ok: 1 }));
  expect(await forever('/x', {})).toEqual({ ok: 1 });
  expect(stillWaiting('wait_abcdefgh').still_waiting).toBe(true);
});

test('only a gemini session is offered wait_key on the tools that wait for a human', async () => {
  const names = async (engine: string) => {
    const child = spawn('bun', ['--no-env-file', path.join(ROOT, 'mcp/host-mcp.js')], { env: { ...process.env, ARIGAMI_URL: 'http://127.0.0.1:1', ARIGAMI_SESSION_ID: 'sess_t', ARIGAMI_AGENT: '', ARIGAMI_ENGINE: engine }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const listed = new Promise<any[]>((resolve, reject) => {
      child.stdout.on('data', (d) => {
        buf += d;
        for (const line of buf.split('\n')) {
          try { const j = JSON.parse(line); if (j.id === 2) resolve(j.result.tools); } catch { /* partial */ }
        }
      });
      setTimeout(() => reject(new Error('no tools/list answer')), 20000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    try {
      const tools = await listed;
      return tools.filter((t) => t.inputSchema?.properties?.wait_key).map((t) => t.name).sort();
    } finally {
      child.kill();
    }
  };
  expect(await names('gemini')).toEqual(['request_screen', 'request_setup', 'sign_in', 'vault_collect', 'vault_fill']);
  expect(await names('')).toEqual([]);
}, 60000);

// ---- the question card ----------------------------------------------------------------------

test('agy\'s ask_question becomes the question card and stays open for the next message (the shape a real run sent)', () => {
  const out = run(
    "g.acpWriteMessage(proc,{text:'go'});await tick();" +
      "up({sessionUpdate:'tool_call',toolCallId:'q1',name:'ask_question',status:'in_progress',kind:'other',rawInput:{questions:[{is_multi_select:false,options:['(Recommended) red','blue'],question:'Please choose between red and blue:'}]}});" +
      "g.acpHandleEvent(s.id,{jsonrpc:'2.0',id:1,result:{stopReason:'end_turn'}});await tick();" +
      'emit({events:chat()});'
  );
  const card = of(out.events, 'tool-use')[0];
  expect(card).toMatchObject({ name: 'AskUserQuestion', toolUseId: 'q1' });
  expect(card.input.questions[0]).toEqual({ question: 'Please choose between red and blue:', header: '', multiSelect: false, options: [{ label: 'red', description: 'Recommended' }, { label: 'blue', description: '' }] });
  expect(of(out.events, 'tool-result')).toHaveLength(0); // no result closes the card — the human's answer is the next message
});

// ---- quota and the model ladder ----------------------------------------------------------------

test('recovery plan: a spent bucket is not routed around by a lighter Gemini model; an unavailable model steps down', async () => {
  const q = await import('../server/lib/gemini-quota.ts');
  const chain = ['gemini-4-neon', 'gemini-4-argon', 'gemini-3.8-flash'];
  const now = Date.parse('2026-11-22T00:00:00Z');
  const full = { available: true, session: { pct: 100, resetsAt: '2026-11-22T03:34:12Z', windowMins: 300 }, week: null, limitReached: true } as any;
  const fine = { available: true, session: { pct: 12, resetsAt: '2026-11-22T03:34:12Z', windowMins: 300 }, week: null, limitReached: false } as any;
  const wait = q.planGeminiRecovery({ text: 'RESOURCE_EXHAUSTED: quota exceeded', usage: full, chain, rung: 0, now });
  expect(wait).toMatchObject({ action: 'wait', verdict: 'confirmed', resetAt: '2026-11-22T03:34:12Z', pct: 100 });
  // a rung outside Gemini's bucket (Claude through Google has its own) is the only way around it
  const around = q.planGeminiRecovery({ text: '429 quota', usage: full, chain: [...chain, 'claude-sonnet-5-5'], rung: 0, now });
  expect(around).toMatchObject({ action: 'model-down', model: 'claude-sonnet-5-5', rung: 3 });
  const down = q.planGeminiRecovery({ text: 'The model is overloaded. Please try again later (503 UNAVAILABLE)', usage: fine, chain, rung: 0, now });
  expect(down).toMatchObject({ action: 'model-down', verdict: 'not-limited', model: 'gemini-4-argon', rung: 1 });
  expect(q.planGeminiRecovery({ text: 'quota', usage: fine, chain, rung: 0, now }).action).toBe('none'); // the word alone, with the bucket at 12%
  expect(q.planGeminiRecovery({ text: 'usage limit reached', usage: null, chain, rung: 1, now })).toMatchObject({ action: 'model-down', verdict: 'unknown', model: 'gemini-3.8-flash' });
  expect(q.planGeminiRecovery({ text: 'overloaded', usage: fine, chain, rung: 2, now }).action).toBe('none'); // bottom rung
  expect(q.planGeminiRecovery({ text: 'syntax error', usage: full, chain, rung: 0, now }).action).toBe('none');
  expect(q.geminiLimitNote('429 quota', 'confirmed', 100)).toContain('Every Gemini model draws on the same quota');
  expect(q.geminiLimitNote('503 overloaded', 'not-limited', 12)).toContain('not taking requests');
  expect(q.geminiLimitNote('boom')).toBeNull();
  // the chain is families: the picked one on top, filtered to what the account is offered
  expect(q.geminiChain({ modelChoice: 'gemini-4-hydrogen-xhigh', catalog: ['gemini-4-neon', 'gemini-4-argon', 'gemini-4-hydrogen'] })).toEqual(['gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-argon']);
  expect(q.geminiLadder(chain, { modelChoice: 'gemini-4-argon-high' })).toMatchObject({ rung: 1, model: 'gemini-4-argon', rungsLeft: 1 });
  expect(q.sharesGeminiBucket('gemini-3.8-flash')).toBe(true);
  expect(q.sharesGeminiBucket('claude-sonnet-5-5')).toBe(false);
});

test('a failed turn that looks like a limit: confirmed quota waits and says when; an overloaded model steps down live and climbs back', () => {
  const out = run(
    "const rec=await import('./server/gemini-recovery.ts');" +
      "const avail=['neon','argon'].flatMap((f)=>['low','medium','high','xhigh'].filter((e)=>f==='neon'||e!=='xhigh').map((e)=>({modelId:`gemini-4-${f}-${e}`,name:f})));" +
      "A.models=avail;A.modelId='gemini-4-neon-xhigh';st.setClaude(s.id,{modelChoice:'gemini-4-neon',effort:'xhigh'});" +
      "cl.appendChat(s.id,{kind:'user',text:'do the thing'});" +
      "const full={available:true,session:{pct:100,resetsAt:new Date(Date.now()+3600e3).toISOString(),windowMins:300},week:null,limitReached:true};" +
      "const fine={available:true,session:{pct:10,resetsAt:null,windowMins:300},week:null,limitReached:false};" +
      "const ladder0=cl.ladderState(s.id);" +
      "const waited=await rec.onGeminiLimit(s.id,'RESOURCE_EXHAUSTED: quota',{usage:async()=>full});" +
      'const afterWait={model:st.getSession(s.id).claude.modelChoice,err:cl.lastTurnError(s.id)};' +
      "const down=await rec.onGeminiLimit(s.id,'503 UNAVAILABLE: the model is overloaded',{usage:async()=>fine});await tick();" +
      "g.acpHandleEvent(s.id,{jsonrpc:'2.0',id:1,result:{}});await tick();" +
      'const c1={...st.getSession(s.id).claude};const ladder1=cl.ladderState(s.id);' +
      'const top=cl.restoreModel(s.id);await tick();const c2={...st.getSession(s.id).claude};' +
      'emit({ladder0,waited,afterWait,down,ladder1,c1,top,c2,wrote:wrote.filter((w)=>w.method==="session/set_model").map((w)=>w.params.modelId),sys:chat().filter((e)=>e.kind==="system"||e.kind==="error").map((e)=>e.text)});'
  );
  expect(out.ladder0).toMatchObject({ chain: ['gemini-4-neon', 'gemini-4-argon', 'gemini-3.8-flash'], rung: 0 });
  expect(out.waited.action).toBe('wait');
  expect(out.afterWait).toEqual({ model: 'gemini-4-neon', err: 'limit' }); // nothing moved; the supervisor reads it as a limit
  expect(out.sys[0]).toContain("Gemini's 5-hour quota ran out — confirmed");
  expect(out.sys[1]).toContain('resets around');
  expect(out.down).toMatchObject({ action: 'model-down', model: 'gemini-4-argon' });
  expect(out.ladder1).toMatchObject({ rung: 1, model: 'gemini-4-argon' });
  // argon has no xhigh: it runs at its own default and the top rung's effort is kept for the climb back
  expect(out.c1).toMatchObject({ modelChoice: 'gemini-4-argon', modelRung: 1, modelDowngradedFrom: 'gemini-4-neon', effort: null, effortDowngradedFrom: 'xhigh', model: 'gemini-4-argon-high' });
  expect(out.wrote[0]).toBe('gemini-4-argon-high');
  expect(out.top).toBe('gemini-4-neon');
  expect(out.c2).toMatchObject({ modelChoice: 'gemini-4-neon', modelRung: 0, effort: 'xhigh', modelRestoreAt: null });
});

// ---- sign-in, cleanup, and the rest of the host ---------------------------------------------------

test('sign-in: agy prints the Google link, the code goes back on stdin, and the token file is the proof', () => {
  fs.rmSync(gemHome, { recursive: true, force: true });
  const r = runInChild(
    "const gl=await import('./server/gemini-login.ts');" +
      'const wait=async(id,s)=>{for(let i=0;i<100&&gl.loginStatus(id).state!==s;i++)await new Promise((r)=>setTimeout(r,30));return gl.loginStatus(id);};' +
      "const a=gl.startLogin();const ready=await wait(a.id,'awaiting-code');const same=gl.startLogin().id===a.id;" +
      "const bad=await gl.submitCode(a.id,'wrong');" +
      "const b=gl.startLogin();await wait(b.id,'awaiting-code');const ok=await gl.submitCode(b.id,'good-code');" +
      "const c=gl.startLogin();await wait(c.id,'awaiting-code');const cancelled=gl.cancelLogin(c.id);" +
      "emit({ready,same,bad,ok,cancelled:cancelled.state,unknown:gl.loginStatus('gem_nope').state});",
    env()
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.ready).toMatchObject({ state: 'awaiting-code', url: 'https://accounts.google.com/o/oauth2/auth?client_id=x&state=y' });
  expect(o.same).toBe(true); // one login at a time
  expect(o.bad).toMatchObject({ ok: false, state: 'error', error: 'login failed: invalid authorization code' });
  expect(o.ok).toMatchObject({ ok: true, state: 'done' });
  expect(o.cancelled).toBe('cancelled');
  expect(o.unknown).toBe('error');
  expect(fs.existsSync(path.join(gemHome, 'antigravity-cli', 'antigravity-oauth-token'))).toBe(true);
});

test('deleting a session removes its customization dir and the conversations agy kept for it', () => {
  signIn();
  const conv = '11111111-2222-4333-8444-555555555555';
  const other = '99999999-2222-4333-8444-555555555555';
  const app = path.join(gemHome, 'antigravity-cli');
  for (const id of [conv, other]) {
    fs.mkdirSync(path.join(app, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(app, 'brain', id), { recursive: true });
    fs.mkdirSync(path.join(app, 'annotations'), { recursive: true });
    fs.mkdirSync(path.join(app, 'presence'), { recursive: true });
    fs.writeFileSync(path.join(app, 'conversations', `${id}.db`), 'x');
    fs.writeFileSync(path.join(app, 'annotations', `${id}.pbtxt`), 'x');
    fs.writeFileSync(path.join(app, 'presence', `${id}.lock`), 'x');
  }
  const out = run(`const d=g.writeSessionDir(s);g.removeGeminiSession(s.id,[${JSON.stringify(conv)},'../../etc']);emit({d,gone:!fs.existsSync(d)});`);
  expect(out.gone).toBe(true);
  expect(agyConversationPaths(gemHome, conv).some((p) => fs.existsSync(p))).toBe(false);
  expect(agyConversationPaths(gemHome, other).every((p) => fs.existsSync(p))).toBe(true); // somebody else's conversation
  expect(agyConversationPaths(gemHome, '../../etc')).toEqual([]);
  expect(fs.existsSync(path.join(app, 'antigravity-oauth-token'))).toBe(true);
});

test('the host around the engine: capability, MCP grant truth, telemetry, the default model chain', () => {
  signIn();
  const out = run(
    "const caps=await import('./server/capabilities.ts');const mc=await import('./server/mcp-connections.ts');const tm=await import('./server/telemetry.ts');const cf=await import('./server/lib/config.ts');" +
      "const cap=caps.getCapability('gemini');const status=await caps.statusOf(cap);" +
      "const facts=await tm.collectFacts?.();" +
      "emit({isId:caps.isCapabilityId('gemini'),title:cap.title,playbook:cap.playbook,kind:cap.manual.kind,status,engines:tm.ENGINES,counted:facts?.engines,chain:cf.cfg.geminiModelChain});"
  );
  expect(out.isId).toBe(true);
  expect(out).toMatchObject({ title: 'Gemini', playbook: 'connect-gemini', kind: 'oauth' });
  expect(out.status).toMatchObject({ ok: true, detail: 'signed in' });
  expect(out.engines).toEqual(['claude', 'codex', 'gemini']);
  expect(out.chain).toEqual(['gemini-4-neon', 'gemini-4-argon', 'gemini-3.8-flash']);
  if (out.counted) expect(out.counted.gemini).toBe(1); // this very session
});
