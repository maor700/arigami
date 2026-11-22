// The gemini driver (server/gemini-acp.ts) against recorded real `agy acp` runs in test/fixtures/gemini-acp/ (agy 1.5.14, gemini-3.8-flash).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';
import {
  splitModelId,
  modelRows,
  resolveModelId,
  effortsFor,
  fallbackEfforts,
  pickerRows,
  agyAcpArgs,
  agyTokenFile,
  utilityModel,
  acpMcpServers,
  aliasToolName,
  toolInput,
  commandOutput,
  skillPrompt,
  parseAgyPrint,
  agyPrintModel,
  requireAgy,
  geminiReady,
} from '../server/lib/gemini-cli.ts';

const FIX = path.resolve(import.meta.dir, 'fixtures/gemini-acp');
const fx = (name: string) => path.join(FIX, name);
const lines = (name: string) => fs.readFileSync(fx(name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

let dir: string;
let fakeAgy: string;
beforeAll(() => {
  dir = tmpDir('gem-drv-');
  // a signed-in agy, as far as prepare() can tell
  fakeAgy = path.join(dir, 'agy');
  fs.writeFileSync(fakeAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'gemini', 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'x');
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_PORT: '',
  ARIGAMI_FUNNEL_QUIET: '1',
  ARIGAMI_AGY_BIN: fakeAgy,
  ARIGAMI_GEMINI_DIR: path.join(dir, 'gemini'),
  CLAUDE_CONFIG_DIR: path.join(dir, 'no-claude-config'),
  ...extra,
});

// A child with state/claude/gemini-acp loaded, a gemini session `s`, and a fake live proc whose stdin records what the driver writes.
const PRELUDE =
  "const st=await import('./server/state.ts');" +
  "const cl=await import('./server/claude.js');" +
  "const g=await import('./server/gemini-acp.ts');" +
  "const api=await import('./server/api.ts');" +
  "const fs=await import('node:fs');" +
  "const s=st.createSession({title:'gem',engine:'gemini',cwd:process.cwd()});" +
  'const wrote=[];' +
  "const proc={id:s.id,sent:[],resume:false,child:{stdin:{writableEnded:false,destroyed:false,write:(l)=>wrote.push(JSON.parse(l))},once(){}}};" +
  'const A=g.stateOf(s.id);A.proc=proc;A.ready=true;A.modeId="default";' +
  "const read=(f)=>fs.readFileSync(f,'utf8').split('\\n').filter((l)=>l.trim()).map((l)=>JSON.parse(l));" +
  'const feed=(f,from=0,to=1e9)=>{for(const j of read(f).slice(from,to))g.acpHandleEvent(s.id,j);};' +
  'const tick=()=>new Promise((r)=>setTimeout(r,20));' +
  'const chat=()=>cl.getChat(s.id,0);';

function run(body: string, extra: Record<string, string> = {}) {
  const r = runInChild(PRELUDE + body, env(extra));
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

const kinds = (events: any[]) => events.map((e: any) => e.kind);
const of = (events: any[], kind: string) => events.filter((e: any) => e.kind === kind);
const TURN_SID = 'd23307da-bbba-4039-b1b8-2af3b18cc5eb';
const TOOLS_SID = 'ba527f42-fc19-4a74-a4ef-281e07a92fd4';
const DENY_SID = 'a66455a5-5fe7-4cb4-b101-6bfbbae41031';

// ---- pure mappings ----------------------------------------------------------------

test('models: availableModels become families with effort levels; model + effort resolve to an offered ACP id', () => {
  const session = lines('session-new.jsonl')[1].result;
  const avail = session.models.availableModels;
  expect(splitModelId('gemini-4-neon-high')).toEqual({ family: 'gemini-4-neon', effort: 'high' });
  expect(splitModelId('gemini-pro-orchestrator-neon')).toEqual({ family: 'gemini-pro-orchestrator-neon', effort: null });
  const rows = modelRows(avail, 1048576);
  const neon = rows.find((r) => r.id === 'gemini-4-neon')!;
  expect(neon).toMatchObject({ name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', contextWindow: 1048576 });
  expect(rows.find((r) => r.id === 'gemini-3.8-flash')!.efforts).toEqual(['low', 'medium', 'high']);
  expect(rows.find((r) => r.id === 'gemini-pro-orchestrator-neon')!.efforts).toEqual([]);
  // the picker gets the four Gemini families only — no Orchestrator, no Claude/GPT through Google
  expect(pickerRows(rows).map((r) => r.id)).toEqual(['gemini-4-neon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash']);

  expect(resolveModelId(null, null, avail, 'gemini-3.8-flash-low')).toEqual({ id: 'gemini-4-neon-high' }); // no pick = Neon at high, whatever agy was on
  expect(resolveModelId('default', 'default', avail)).toEqual({ id: 'gemini-4-neon-high' });
  expect(resolveModelId(null, null, [])).toEqual({ id: null });
  expect(resolveModelId('gemini-3.8-flash', 'low', avail)).toEqual({ id: 'gemini-3.8-flash-low' });
  expect(resolveModelId('gemini-4-neon-high', null, avail)).toEqual({ id: 'gemini-4-neon-high' });
  expect(resolveModelId('gemini-4-neon-high', 'xhigh', avail)).toEqual({ id: 'gemini-4-neon-xhigh' }); // an explicit effort wins over the id's tail
  expect(resolveModelId('gemini-4-argon', null, avail).id).toBe('gemini-4-argon-high');
  expect(resolveModelId(null, 'low', avail)).toEqual({ id: 'gemini-4-neon-low' });
  expect(resolveModelId('gemini-4-hydrogen', 'xhigh', avail)).toEqual({ id: 'gemini-4-hydrogen-xhigh' });
  expect(resolveModelId('gemini-pro-orchestrator-neon', null, avail)).toEqual({ id: 'gemini-pro-orchestrator-neon' });
  const badEffort = resolveModelId('gemini-3.8-flash', 'xhigh', avail);
  expect(badEffort.id).toBe('gemini-3.8-flash-high');
  expect(badEffort.error).toContain('not offered at effort "xhigh"');
  const unknown = resolveModelId('gpt-5.5', null, avail);
  expect(unknown.id).toBeNull();
  expect(unknown.error).toContain('not offered by Antigravity');
  expect(utilityModel(rows)).toBe('gemini-3.8-flash-low'); // what a one-shot runs on when no model is named
  expect(utilityModel([])).toBeNull();
  expect(effortsFor('gemini-4-hydrogen', avail)).toEqual(['low', 'medium', 'high', 'xhigh']);
  expect(effortsFor('gemini-3.8-flash', avail)).toEqual(['low', 'medium', 'high']);
  expect(effortsFor(null, avail)).toEqual(['low', 'medium', 'high', 'xhigh']);
  expect([fallbackEfforts('gemini-4-neon'), fallbackEfforts('gemini-4-hydrogen'), fallbackEfforts(null)]).toEqual(Array(3).fill(['low', 'medium', 'high', 'xhigh']));
  expect([fallbackEfforts('gemini-4-argon'), fallbackEfforts('gemini-3.8-flash')]).toEqual(Array(2).fill(['low', 'medium', 'high']));
});

test('the real agent refuses an unknown model and an unknown mode (fixture)', () => {
  const [, , ok, badModel, badMode] = lines('session-new.jsonl');
  expect(ok.result).toEqual({});
  expect(badModel.error.message).toBe('Unknown model ID: bogus-model');
  expect(badMode.error.message).toBe('Unknown mode: bogus');
});

test('MCP servers: Claude-shaped entries become the ACP array, the token expanded into the header', () => {
  const out = acpMcpServers(
    {
      arigami: { type: 'http', url: 'http://127.0.0.1:3099/__mcp/s/arigami', headers: { Authorization: 'Bearer ${ARIGAMI_TOKEN}' } },
      legacy: { type: 'sse', url: 'http://x/sse' },
      local: { command: 'bun', args: ['mcp/host-mcp.js'], env: { EXTRA: '1' } },
      junk: 7,
    },
    { ARIGAMI_TOKEN: 'tok123' },
    { ARIGAMI_SESSION_ID: 'sess_1' }
  );
  expect(out).toEqual([
    { type: 'http', name: 'arigami', url: 'http://127.0.0.1:3099/__mcp/s/arigami', headers: [{ name: 'Authorization', value: 'Bearer tok123' }] },
    { type: 'sse', name: 'legacy', url: 'http://x/sse', headers: [] },
    { name: 'local', command: 'bun', args: ['mcp/host-mcp.js'], env: [{ name: 'ARIGAMI_SESSION_ID', value: 'sess_1' }, { name: 'EXTRA', value: '1' }] },
  ]);
});

test('tool names: mcp_<server>_<tool> → mcp__<server>__<tool>, built-ins onto Claude names', () => {
  const servers = ['arigami', 'ext-demo', 'composio-mcp', 'linear--sales', 'linear'];
  expect(aliasToolName('mcp_arigami_host_resources', servers)).toEqual({ name: 'mcp__arigami__host_resources', server: 'arigami', tool: 'host_resources' });
  expect(aliasToolName('mcp_ext-demo_demo_get', servers).name).toBe('mcp__ext-demo__demo_get');
  expect(aliasToolName('mcp_composio-mcp_GMAIL_SEND_EMAIL', servers).name).toBe('mcp__composio-mcp__GMAIL_SEND_EMAIL');
  expect(aliasToolName('mcp_linear--sales_list_teams', servers).name).toBe('mcp__linear--sales__list_teams'); // longest server wins
  expect(aliasToolName('mcp_other_do_it', servers).name).toBe('mcp__other__do_it'); // unknown server: first underscore
  expect(aliasToolName('run_command').name).toBe('Bash');
  expect(aliasToolName('write_file').name).toBe('Write');
  expect(aliasToolName('replace_file_content').name).toBe('Edit');
  expect(aliasToolName('view_file').name).toBe('Read');
  expect(aliasToolName('search_web').name).toBe('WebSearch');
  expect(aliasToolName('manage_task').name).toBe('manage_task');
  expect(aliasToolName('', [], 'execute').name).toBe('Bash');
  expect(toolInput('Bash', { CommandLine: 'echo hi', WaitMsBeforeAsync: 5000, toolSummary: 'Run echo' })).toEqual({ command: 'echo hi' });
  expect(toolInput('Write', { Path: '/w/a.txt', Content: 'hi\n' })).toEqual({ file_path: '/w/a.txt', content: 'hi\n' });
  expect(toolInput('mcp__x__y', { a: 1, toolSummary: 'noise' })).toEqual({ a: 1 });
  expect(commandOutput('Created At: t\nCompleted At: t\nCommand exited with code 2.\n\nCommand output:\nboom')).toBe('boom\n(exit code 2)');
  expect(commandOutput('plain text')).toBe('plain text');
});

test('skills: /arigami:<name> becomes "read that SKILL.md"; other slash commands pass through', () => {
  const roots = { arigami: '/pack', 'arigami-user': null };
  const has = (p: string) => p === '/pack/dispatch/SKILL.md';
  expect(skillPrompt('/arigami:dispatch split the work', roots, has)).toBe('Run the Arigami skill "dispatch": read /pack/dispatch/SKILL.md first and follow it exactly.\n\nsplit the work');
  expect(skillPrompt('/arigami:missing x', roots, has)).toBe('/arigami:missing x');
  expect(skillPrompt('/arigami-user:dispatch', roots, has)).toBe('/arigami-user:dispatch');
  expect(skillPrompt('/compact', roots, has)).toBe('/compact');
});

test('print mode: the json envelope gives the response; an ERROR status throws agy\'s own words', () => {
  expect(parseAgyPrint(fs.readFileSync(fx('print.json'), 'utf8'))).toBe('OK-ARGV\n');
  expect(() => parseAgyPrint(fs.readFileSync(fx('print-error.json'), 'utf8'))).toThrow('empty prompt');
  expect(agyPrintModel('gemini-3.8-flash', 'low')).toBe('gemini-3.8-flash-low');
  expect(agyPrintModel('gemini-4-neon-high', 'low')).toBe('gemini-4-neon-high');
  expect(agyPrintModel('haiku')).toBeNull();
  expect(agyPrintModel(undefined)).toBeNull();
});

test('a missing agy fails loudly, and is never "ready"', () => {
  const none = { ARIGAMI_AGY_BIN: '/nonexistent/agy', PATH: '' } as any;
  expect(() => requireAgy(none)).toThrow('Antigravity CLI');
  expect(geminiReady(none)).toBe(false);
});

// ---- the driver against recorded runs ------------------------------------------------

test('a gemini session is created on the engine, pinned to no Arigami account', () => {
  const out = run('emit({engine:s.engine,accountId:s.claude.accountId,model:s.claude.modelChoice,effort:s.claude.effort});');
  expect(out).toEqual({ engine: 'gemini', accountId: null, model: null, effort: null });
});

test('a real turn: command + file write + message map onto the chat kinds; bypass answers the permission request itself', () => {
  const out = run(
    `A.sessionId=${JSON.stringify(TURN_SID)};A.seq=3;` +
      "g.acpWriteMessage(proc,{text:'go'});await tick();" +
      `feed(${JSON.stringify(fx('turn-flash.jsonl'))});await tick();` +
      'emit({events:chat(),claude:st.getSession(s.id).claude,wrote});'
  );
  const { events, claude, wrote } = out;
  expect(wrote[0]).toMatchObject({ id: 4, method: 'session/prompt', params: { sessionId: TURN_SID, prompt: [{ type: 'text', text: 'go' }] } });
  expect(wrote[1]).toEqual({ jsonrpc: '2.0', id: '1', result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  expect(kinds(events)).toEqual(['tool-use', 'tool-result', 'tool-use', 'tool-result', 'assistant-text', 'result']);
  const [bash, write] = of(events, 'tool-use');
  expect(bash).toMatchObject({ name: 'Bash', input: { command: 'echo hello-acp' } });
  expect(of(events, 'tool-result')[0]).toMatchObject({ content: 'hello-acp\n', isError: false }); // agy's status header is stripped
  expect(write).toMatchObject({ name: 'Write', input: { file_path: '/work/session/note.txt', content: 'hi\n' } });
  expect(of(events, 'tool-result')[1].content).toBe('created: /work/session/note.txt');
  expect(of(events, 'assistant-text')[0].text).toContain('Ran the command and created');
  expect(claude.state).toBe('idle');
  expect(claude.usage).toMatchObject({ ctxTokens: 8986, ctxWindow: 1048576, ctxAssumed: false });
  expect(claude.turnDiff).toMatchObject({ additions: 1, deletions: 0 }); // the write's diff block → the Changes tab reloads
});

test('thinking, MCP tools and a read: Arigami\'s own tools stay out of the transcript, the others get mcp__ names', () => {
  const out = run(
    `A.sessionId=${JSON.stringify(TOOLS_SID)};A.seq=4;A.servers=['arigami','ext-demo'];` +
      "g.acpWriteMessage(proc,{text:'go'});await tick();" +
      `feed(${JSON.stringify(fx('tools-thinking-flash.jsonl'))});await tick();` +
      'emit({events:chat(),mcp:st.getSession(s.id).claude.mcp,wrote});'
  );
  expect(kinds(out.events)).toEqual(['thinking', 'tool-use', 'tool-result', 'tool-use', 'tool-result', 'thinking', 'assistant-text', 'result']);
  const uses = of(out.events, 'tool-use');
  expect(uses[0]).toMatchObject({ name: 'mcp__ext-demo__demo_get', input: {} });
  expect(uses[1]).toMatchObject({ name: 'Read', input: { file_path: '/work/session/note.txt' } });
  expect(of(out.events, 'thinking')[0].text).toContain('17*23 equals 391');
  expect(out.mcp.servers.arigami.status).toBe('connected'); // a live call is the health signal
  expect(out.wrote.filter((w: any) => w.result?.outcome?.optionId === 'allow').map((w: any) => w.id)).toEqual(['1', '2']);
});

test('ask mode: a permission request becomes the card; deny answers agy\'s reject option', () => {
  const out = run(
    `A.sessionId=${JSON.stringify(TURN_SID)};A.seq=3;st.setClaude(s.id,{permissionMode:'default'});` +
      "g.acpWriteMessage(proc,{text:'go'});await tick();" +
      `feed(${JSON.stringify(fx('turn-flash.jsonl'))},0,7);` +
      'const card=chat().find((e)=>e.kind==="permission-request");' +
      'const before=wrote.length;' +
      "api.expirePendingPermissions(s.id,'no');await tick();" +
      'emit({card,before,wrote,events:chat()});'
  );
  expect(out.card).toMatchObject({ toolName: 'Bash', toolUseId: 'call_13667380818163367938', input: { command: 'echo hello-acp' } });
  expect(out.before).toBe(1); // nothing answered while the card is open
  expect(out.wrote[1]).toEqual({ jsonrpc: '2.0', id: '1', result: { outcome: { outcome: 'selected', optionId: 'deny' } } });
  expect(kinds(out.events)).toContain('permission-answer');
});

test('a denied command ends as a failed tool result (fixture), and outcomes follow the offered options', () => {
  const out = run(
    `A.sessionId=${JSON.stringify(DENY_SID)};A.seq=5;st.setClaude(s.id,{permissionMode:'default'});` +
      "g.acpWriteMessage(proc,{text:'go'});await tick();" +
      `feed(${JSON.stringify(fx('cancel-deny-flash.jsonl'))},11,16);` +
      "api.expirePendingPermissions(s.id,'no');await tick();" +
      `feed(${JSON.stringify(fx('cancel-deny-flash.jsonl'))},16);await tick();` +
      "const opts=[{optionId:'allow',kind:'allow_once'},{optionId:'deny',kind:'reject_once'}];" +
      "emit({events:chat(),allow:g.outcomeFor(opts,{behavior:'allow'}),deny:g.outcomeFor(opts,{behavior:'deny'}),timeout:g.outcomeFor(opts,{behavior:'deny',timedOut:true}),none:g.outcomeFor([],{behavior:'allow'})});"
  );
  const result = of(out.events, 'tool-result')[0];
  expect(result).toMatchObject({ isError: true, content: 'declined by the human' });
  expect(of(out.events, 'user')).toHaveLength(0); // user_message_chunk is agy echoing the prompt
  expect(out.allow).toEqual({ outcome: 'selected', optionId: 'allow' });
  expect(out.deny).toEqual({ outcome: 'selected', optionId: 'deny' });
  expect(out.timeout).toEqual({ outcome: 'cancelled' });
  expect(out.none).toEqual({ outcome: 'cancelled' });
});

test('A3: an agent allowlist denies a request before any card, even under bypass', () => {
  const out = run(
    "const ag=await import('./server/agents.ts');" +
      "ag.createAgent({name:'Reader',slug:'reader',tools:['web']});" +
      "st.patchSession(s.id,{metadata:{agent:'reader'}});" +
      `A.sessionId=${JSON.stringify(TURN_SID)};A.seq=3;` +
      "g.acpWriteMessage(proc,{text:'go'});await tick();" +
      `feed(${JSON.stringify(fx('turn-flash.jsonl'))},0,7);await tick();` +
      'emit({wrote,events:chat()});'
  );
  expect(out.wrote[1]).toEqual({ jsonrpc: '2.0', id: '1', result: { outcome: { outcome: 'selected', optionId: 'deny' } } });
  expect(of(out.events, 'permission-request')).toHaveLength(0);
  expect(of(out.events, 'system')[0].text).toContain("denied by the agent's allowlist");
});

test('a mid-turn message waits for the running prompt; interrupt cancels and drops the queue', () => {
  const out = run(
    'A.sessionId="sid1";' +
      "g.acpWriteMessage(proc,{text:'first'});await tick();" +
      "g.acpWriteMessage(proc,{text:'second'});await tick();" +
      'const midTurn=wrote.map((w)=>w.method);' +
      "g.acpHandleEvent(s.id,{jsonrpc:'2.0',id:1,result:{stopReason:'end_turn',usage:{inputTokens:10,outputTokens:1,cachedReadTokens:0,totalTokens:11}}});await tick();" +
      'const afterFirst=wrote.map((w)=>w.method);' +
      "g.acpWriteMessage(proc,{text:'third'});g.acpInterrupt(proc);await tick();" +
      "g.acpHandleEvent(s.id,{jsonrpc:'2.0',id:2,result:{stopReason:'cancelled'}});await tick();" +
      'emit({midTurn,afterFirst,wrote,events:chat(),state:st.getSession(s.id).claude.state,after:A.after.length});'
  );
  expect(out.midTurn).toEqual(['session/prompt']);
  expect(out.afterFirst).toEqual(['session/prompt', 'session/prompt']);
  expect(out.wrote[1].params.prompt).toEqual([{ type: 'text', text: 'second' }]);
  expect(out.wrote[2]).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sid1' } });
  expect(out.wrote).toHaveLength(3); // 'third' was dropped with the interrupt
  expect(of(out.events, 'system').map((e: any) => e.text)).toEqual(['⏹ interrupted']);
  expect(of(out.events, 'result')).toHaveLength(1);
  expect(out.state).toBe('idle');
});

test('the recorded reason for queueing: a second prompt makes agy end the first one at once', () => {
  const rec = lines('second-prompt-flash.jsonl');
  const second = rec.findIndex((r: any) => r.dir === '>' && r.msg.method === 'session/prompt' && r.msg.id === 5);
  const firstDone = rec.findIndex((r: any) => r.dir === '<' && r.msg.id === 4 && r.msg.result);
  expect(firstDone).toBe(second + 1);
  expect(rec[firstDone].msg.result.stopReason).toBe('end_turn');
  expect(rec.some((r: any) => r.msg.params?.update?.status === 'completed')).toBe(false); // the running command never reported its end
});

test('/compact runs as the agent\'s own command and shows as system lines, with no result footer', () => {
  const out = run(
    'A.sessionId="sid1";' +
      "g.acpWriteMessage(proc,{text:'/compact'});await tick();" +
      "g.acpHandleEvent(s.id,{jsonrpc:'2.0',method:'session/update',params:{sessionId:'sid1',update:{sessionUpdate:'usage_update',used:12133,size:1048576}}});" +
      "g.acpHandleEvent(s.id,{jsonrpc:'2.0',id:1,result:{stopReason:'end_turn',usage:{inputTokens:3025,outputTokens:607,cachedReadTokens:8501,totalTokens:12133}}});await tick();" +
      'emit({wrote,events:chat(),usage:st.getSession(s.id).claude.usage});'
  );
  expect(out.wrote[0].params.prompt).toEqual([{ type: 'text', text: '/compact' }]);
  expect(of(out.events, 'system').map((e: any) => e.text)).toEqual(['⤷ compacting the context…', '⤷ context compacted']);
  expect(of(out.events, 'result')).toHaveLength(0);
  expect(out.usage.ctxTokens).toBe(12133);
  // the real run this mirrors
  const rec = lines('resume-image-compact-flash.jsonl');
  const sent = rec.find((r: any) => r.dir === '>' && r.msg.params?.prompt?.[0]?.text === '/compact');
  expect(rec.find((r: any) => r.dir === '<' && r.msg.id === sent.msg.id).msg.result.stopReason).toBe('end_turn');
});

test('auto-compact: past the threshold agy\'s /compact runs once the turn ends, once per crossing, with no respawn', () => {
  const up = (used: number) => `g.acpHandleEvent(s.id,{jsonrpc:'2.0',method:'session/update',params:{sessionId:'sid1',update:{sessionUpdate:'usage_update',used:${used},size:1000000}}});`;
  const done = (id: number) => `g.acpHandleEvent(s.id,{jsonrpc:'2.0',id:${id},result:{stopReason:'end_turn'}});await tick();`;
  const out = run(
    'A.sessionId="sid1";' +
      'const set=cl.setAutoCompact(s.id,80);' +
      "g.acpWriteMessage(proc,{text:'one'});g.acpWriteMessage(proc,{text:'queued'});await tick();" +
      up(850000) + up(860000) +
      'const midTurn=wrote.length;' +
      done(1) + // → /compact (id 2), ahead of the queued message
      up(860000) + done(2) + // the compaction's own reading is still high: no second one
      up(300000) + done(3) + // the queued turn, back under the line
      "g.acpWriteMessage(proc,{text:'two'});await tick();" + up(900000) + done(4) + // crossed again → compacts again
      'emit({set:{pct:set.autoCompactPct},tokens:st.getSession(s.id).claude.autoCompactTokens,midTurn,prompts:wrote.filter((w)=>w.method==="session/prompt").map((w)=>w.params.prompt[0].text),sys:chat().filter((e)=>e.kind==="system").map((e)=>e.text)});'
  );
  expect(out.set.pct).toBe(80);
  expect(out.tokens).toBe(800000); // 80% of the window agy reports
  expect(out.midTurn).toBe(1);
  expect(out.prompts).toEqual(['one', '/compact', 'queued', 'two', '/compact']);
  expect(out.sys[0]).toBe('⤷ compacting the context (auto, 850k ≥ 800k tokens)…'); // the reading that crossed the line
  expect(out.sys.filter((t: string) => t === '⤷ context compacted')).toHaveLength(1); // the second compaction is still running
});

test('images go as ACP image blocks (the shape a real run accepted); other files are listed', () => {
  const out = run(
    "emit({p:g.buildPrompt('look',[{name:'a.png',path:'/x/a.png',isImage:true,type:'image/png',dataBase64:'QUJD'},{name:'notes.txt',path:'/x/notes.txt',isImage:false}]),empty:g.buildPrompt('',[])});"
  );
  expect(out.p[0].type).toBe('text');
  expect(out.p[0].text).toContain('look');
  expect(out.p[0].text).toContain('/x/notes.txt');
  expect(out.p[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'QUJD' });
  expect(out.empty).toEqual([{ type: 'text', text: '(empty message)' }]);
  const rec = lines('resume-image-compact-flash.jsonl');
  const img = rec.find((r: any) => r.dir === '>' && r.msg.params?.prompt?.[1]?.type === 'image');
  expect(Object.keys(img.msg.params.prompt[1]).sort()).toEqual(['data', 'mimeType', 'type']);
});

const HANDSHAKE =
  "const auth=(await import('./server/auth.ts')).auth;" +
  `const fxl=read(${JSON.stringify(fx('session-new.jsonl'))});` +
  'g.resetAcpState(s.id);';

test('handshake: initialize → session/new with the MCP servers and the system prompt → the model is set and validated', () => {
  const out = run(
    HANDSHAKE +
      "st.setClaude(s.id,{modelChoice:'gemini-3.8-flash',effort:'low'});" +
      'g.acpHandshake(proc);await tick();' +
      'g.acpHandleEvent(s.id,fxl[0]);await tick();' +
      'g.acpHandleEvent(s.id,fxl[1]);await tick();' +
      'g.acpHandleEvent(s.id,fxl[2]);await tick();' +
      "emit({wrote,token:auth.tokenForSession(s.id),claude:st.getSession(s.id).claude,ready:g.stateOf(s.id).ready,inSystem:proc.bootstrapInSystem,turn:cl.composeTurnText({...proc,engine:'gemini',preamble:''},'hi'),models:g.geminiModels().map((m)=>m.id),efforts:g.geminiDriver.effortLevels(st.getSession(s.id))});"
  );
  const [init, created, setModel] = out.wrote;
  expect(init).toMatchObject({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } });
  expect(created.method).toBe('session/new');
  expect(created.params.cwd).toBe(process.cwd());
  const arigami = created.params.mcpServers.find((m: any) => m.name === 'arigami');
  expect(arigami).toMatchObject({ type: 'http', headers: [{ name: 'Authorization', value: `Bearer ${out.token}` }] });
  expect(arigami.url).toMatch(/\/__mcp\/s\/arigami$/);
  const append = created.params._meta.antigravity.systemPrompt.append;
  expect(append).toContain('Arigami');
  expect(append).toContain('/arigami:<name>');
  expect(setModel).toMatchObject({ id: 3, method: 'session/set_model', params: { sessionId: 'f753cb3e-4f3b-40b0-8dc7-28542f679e4a', modelId: 'gemini-3.8-flash-low' } });
  expect(out.claude.sessionId).toBe('f753cb3e-4f3b-40b0-8dc7-28542f679e4a');
  expect(out.claude.model).toBe('gemini-3.8-flash-low');
  expect(out.claude.mcpLoaded.servers.map((x: any) => x.name)).toContain('arigami');
  expect(out.ready).toBe(true);
  expect(out.inSystem).toBe(true);
  expect(out.turn).not.toContain('memory snapshot'); // the bootstrap is the system prompt, not a prefix of the first message
  expect(out.models).toEqual(['gemini-4-neon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash']);
  expect(out.efforts).toEqual(['low', 'medium', 'high']);
});

test('handshake: a model the account is not offered is said in the chat, and the session runs on the default', () => {
  const out = run(
    HANDSHAKE +
      "st.setClaude(s.id,{modelChoice:'gpt-5.5'});" +
      'g.acpHandshake(proc);await tick();g.acpHandleEvent(s.id,fxl[0]);await tick();g.acpHandleEvent(s.id,fxl[1]);await tick();' +
      'emit({wrote:wrote.map((w)=>w.method),events:chat(),model:st.getSession(s.id).claude.model});'
  );
  expect(out.wrote).toEqual(['initialize', 'session/new']);
  expect(of(out.events, 'error')[0].text).toContain('model "gpt-5.5" is not offered by Antigravity');
  expect(out.model).toBe('gemini-4-neon-high');
});

test('handshake: a conversation with a turn behind it is resumed by id, with no second system prompt', () => {
  const out = run(
    HANDSHAKE +
      "st.setClaude(s.id,{sessionId:'prev-sid'});cl.appendChat(s.id,{kind:'user',text:'earlier'});" +
      'proc.resume=true;g.acpHandshake(proc);await tick();g.acpHandleEvent(s.id,fxl[0]);await tick();' +
      'const resumed=wrote[1];' +
      "g.acpHandleEvent(s.id,{jsonrpc:'2.0',id:2,error:{code:-32603,message:'Failed to read session prev-sid'}});await tick();" +
      'emit({resumed,then:wrote[2],events:chat(),inSystem:!!proc.bootstrapInSystem});'
  );
  expect(out.resumed).toMatchObject({ method: 'session/resume', params: { sessionId: 'prev-sid' } });
  expect(out.resumed.params._meta).toBeUndefined();
  expect(out.then.method).toBe('session/new'); // a lost conversation starts over, and says so
  expect(out.then.params._meta.antigravity.systemPrompt.append).toContain('Arigami');
  expect(of(out.events, 'system')[0].text).toContain('could not resume');
});

test('model, effort and permission mode change on a live session with no respawn', () => {
  const out = run(
    `A.sessionId="sid1";A.models=read(${JSON.stringify(fx('session-new.jsonl'))})[1].result.models.availableModels;A.modelId='gemini-4-neon-high';` +
      '' +
      "st.setClaude(s.id,{modelChoice:'gemini-4-neon',effort:'low',permissionMode:'acceptEdits'});" +
      "g.geminiDriver.liveSettings(s.id);await tick();g.acpHandleEvent(s.id,{jsonrpc:'2.0',id:1,result:{}});await tick();" +
      "g.acpWriteMessage(proc,{text:'go'});await tick();g.acpHandleEvent(s.id,{jsonrpc:'2.0',id:2,result:{}});await tick();" +
      "emit({wrote,model:st.getSession(s.id).claude.model,modes:[g.acpModeFor('bypassPermissions'),g.acpModeFor('default'),g.acpModeFor('acceptEdits'),g.acpModeFor('plan')]});"
  );
  expect(out.wrote.map((w: any) => w.method)).toEqual(['session/set_model', 'session/set_mode', 'session/prompt']);
  expect(out.wrote[0].params.modelId).toBe('gemini-4-neon-low');
  expect(out.wrote[1].params.modeId).toBe('accept-edits');
  expect(out.model).toBe('gemini-4-neon-low');
  expect(out.modes).toEqual(['default', 'default', 'accept-edits', 'plan']);
});

test('prepare fails loudly without agy or without a login; the spawn is `agy acp` with the session env', () => {
  const ok = run(
    'const b=g.acpBuildSpawn(s,{resume:false,sessionId:null});g.acpPrepare(s,{resume:false});' +
      "emit({bin:b.bin,args:b.args,cwd:b.cwd,sid:b.env.ARIGAMI_SESSION_ID,engine:b.env.ARIGAMI_ENGINE,hasToken:!!b.env.ARIGAMI_TOKEN,leaks:['CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_HOME'].filter((k)=>k in b.env),id:g.geminiDriver.sessionId.from({id:2,result:{sessionId:'abc'}})});",
    { CLAUDE_CODE_OAUTH_TOKEN: 'x', OPENAI_API_KEY: 'y' }
  );
  expect(ok).toMatchObject({ bin: fakeAgy, engine: 'gemini', hasToken: true, leaks: [], id: 'abc' });
  // the gemini home override, then the session's own hooks + skills dir
  expect(ok.args).toEqual(['acp', '--gemini-dir', path.join(dir, 'gemini'), '--add-dir', path.join(dir, 'gemini', ok.sid)]);
  // the gemini home: ~/.gemini unless ARIGAMI_GEMINI_HOME (or the older ARIGAMI_GEMINI_DIR) says otherwise
  expect(agyAcpArgs({} as any)).toEqual(['acp']);
  expect(agyAcpArgs({ ARIGAMI_GEMINI_HOME: '/g/home', ARIGAMI_GEMINI_DIR: '/g/dir' } as any, ['--x'])).toEqual(['acp', '--gemini-dir', '/g/home', '--x']);
  expect(agyTokenFile({ ARIGAMI_GEMINI_HOME: '/g/home' } as any)).toBe('/g/home/antigravity-cli/antigravity-oauth-token');
  expect(ok.sid).toMatch(/^sess_/);
  const missing = runInChild(PRELUDE + 'try{g.acpPrepare(s,{resume:false});emit({threw:false});}catch(e){emit({threw:e.message});}', env({ ARIGAMI_AGY_BIN: '/nonexistent/agy' }));
  if (!missing.ok) throw new Error(missing.error);
  expect(missing.out[0].threw).toContain('Antigravity CLI (`agy`) and it is not installed');
  const signedOut = runInChild(PRELUDE + 'try{g.acpPrepare(s,{resume:false});emit({threw:false});}catch(e){emit({threw:e.message});}', env({ ARIGAMI_GEMINI_DIR: path.join(dir, 'nowhere') }));
  if (!signedOut.ok) throw new Error(signedOut.error);
  expect(signedOut.out[0].threw).toContain('not signed in');
});

// ---- the engine everywhere else ----------------------------------------------------------

test('gemini is a first-class engine id: registry, agents, default engine, one-shot routing', () => {
  const out = run(
    "const ed=await import('./server/lib/engine-driver.ts');" +
      "const ag=await import('./server/agents.ts');" +
      "const cf=await import('./server/lib/config.ts');" +
      "const os=await import('./server/lib/oneshot.ts');" +
      'const d=ed.pickEngine(s);' +
      "const a=ag.createAgent({name:'Gem',slug:'gem',engine:'gemini',model:'gemini-4-neon'}).agent;" +
      'const before=cf.defaultEngine();' +
      "const set=cf.updateDefaultEngine('gemini');" +
      "cf.setEngineReadiness((e)=>e==='codex');const fallback=cf.defaultEngine();" +
      "cf.setEngineReadiness((e)=>e==='gemini');const ready=cf.defaultEngine();cf.setEngineReadiness(null);" +
      "const child=st.createSession({title:'c'});" +
      "emit({id:d.id,perm:d.permissions.kind,handshake:typeof d.handshake,isId:[ed.isEngineId('gemini'),ed.isEngineId('llama')],agentEngine:a.engine,spawn:ag.engineForSpawn(undefined,a),explicit:ag.engineForSpawn('gemini',null),parent:ag.engineForSpawn(undefined,null,{engine:'gemini'}),before,set,fallback,ready,byDefault:child.engine,sessionEngine:os.sessionEngine(s),junk:cf.updateDefaultEngine('llama')});"
  );
  expect(out).toMatchObject({
    id: 'gemini', perm: 'rpc-request', handshake: 'function', isId: [true, false],
    agentEngine: 'gemini', spawn: 'gemini', explicit: 'gemini', parent: 'gemini',
    before: 'claude', set: 'gemini', fallback: 'codex', ready: 'gemini', byDefault: 'gemini', sessionEngine: 'gemini', junk: 'claude',
  });
});

test('claude\'s own recovery never touches a gemini session; it has its own ladder', async () => {
  const out = run(
    "cl.appendChat(s.id,{kind:'error',text:'gemini: usage limit reached, 429'});" +
      'emit({down:cl.downgradeModel(s.id),restore:cl.restoreModel(s.id),ladder:cl.ladderState(s.id),err:cl.lastTurnError(s.id),recover:await cl.recoverAuth(s.id)});'
  );
  expect(out.down).toEqual({ ok: false, reason: 'engine' });
  expect(out.restore).toBeNull(); // on its top rung: nothing to climb back to
  expect(out.ladder).toMatchObject({ chain: ['gemini-4-neon', 'gemini-4-argon', 'gemini-3.8-flash'], rung: 0, rungsLeft: 2 });
  expect(out.err).toBe('limit');
  expect(out.recover).toBe(false);
});
