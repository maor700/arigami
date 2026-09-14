// The codex app-server driver (server/codex-app.ts) against recorded real runs in test/fixtures/codex-app/ (codex-cli 0.153.4, gpt-5.5).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const FIX = path.resolve(import.meta.dir, 'fixtures/codex-app');

let dir: string;
let codexHome: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxapp-drv-'));
  codexHome = path.join(dir, 'real-codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt"}');
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  ARIGAMI_DIR: dir,
  ARIGAMI_PORT: '',
  ARIGAMI_FUNNEL_QUIET: '1',
  ARIGAMI_CODEX_HOME: codexHome,
  ARIGAMI_CODEX_TRANSPORT: '',
  CLAUDE_CONFIG_DIR: path.join(dir, 'no-claude-config'),
  ...extra,
});

// A child with state/claude/codex-app loaded, a codex session `s`, and a fake live proc whose stdin records what the driver writes.
const PRELUDE =
  "const st=await import('./server/state.ts');" +
  "const cl=await import('./server/claude.js');" +
  "const app=await import('./server/codex-app.ts');" +
  "const api=await import('./server/api.ts');" +
  "const fs=await import('node:fs');" +
  "const s=st.createSession({title:'codex',engine:'codex'});" +
  'const wrote=[];' +
  "const proc={id:s.id,sent:[],child:{stdin:{writableEnded:false,destroyed:false,write:(l)=>wrote.push(JSON.parse(l))}}};" +
  'const A=app.stateOf(s.id);A.proc=proc;A.ready=true;A.threadId="t1";' +
  "const feed=(f)=>{for(const line of fs.readFileSync(f,'utf8').split('\\n')){if(!line.trim())continue;app.appHandleEvent(s.id,JSON.parse(line));}};" +
  'const tick=()=>new Promise((r)=>setTimeout(r,20));';

function run(body: string, extra: Record<string, string> = {}) {
  const r = runInChild(PRELUDE + body, env(extra));
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

const kinds = (events: any[]) => events.map((e: any) => e.kind);
const of = (events: any[], kind: string) => events.filter((e: any) => e.kind === kind);

test('a real turn: shell + apply_patch + message map onto the chat kinds, with usage and the live diff', () => {
  const out = run(
    `A.threadId=null;feed(${JSON.stringify(path.join(FIX, 'turn-gpt55.jsonl'))});` +
      'emit({events:cl.getChat(s.id,0),claude:st.getSession(s.id).claude});'
  );
  const { events, claude } = out;
  expect(kinds(events)).toEqual(['tool-use', 'tool-result', 'tool-use', 'tool-result', 'assistant-text', 'result']);
  const [bash, edit] = of(events, 'tool-use');
  expect(bash.name).toBe('Bash');
  expect(bash.input.command).toContain('echo hi');
  expect(of(events, 'tool-result')[0]).toMatchObject({ content: 'hi\n', isError: false });
  expect(edit.name).toBe('Edit');
  expect(edit.input.file_path).toBe('/work/session/hello.txt');
  expect(edit.additions).toBe(1);
  expect(of(events, 'tool-result')[1].content).toBe('add: /work/session/hello.txt');
  expect(of(events, 'assistant-text')[0].text).toBe('ok');
  expect(claude.state).toBe('idle');
  expect(claude.sessionId).toMatch(/^01a0a1fd-/);
  expect(claude.usage.ctxWindow).toBe(258400);
  expect(claude.usage.ctxTokens).toBeGreaterThan(0);
  expect(claude.turnDiff.additions).toBe(1);
});

test('an approval request becomes the permission card; deny answers decline', () => {
  const out = run(
    `feed(${JSON.stringify(path.join(FIX, 'approval-gpt55.jsonl'))});` +
      'const card=cl.getChat(s.id,0).find((e)=>e.kind==="permission-request");' +
      'const stateWhileAsking=st.getSession(s.id).claude.state;' +
      "api.expirePendingPermissions(s.id,'no');await tick();" +
      'emit({card,stateWhileAsking,wrote,events:cl.getChat(s.id,0)});'
  );
  expect(out.card).toMatchObject({ toolName: 'Bash', toolUseId: expect.stringMatching(/^call_/) });
  expect(out.card.input.command).toContain('touch approved.txt');
  const answer = out.wrote.find((w: any) => w.id === 0 && w.result);
  expect(answer.result).toEqual({ decision: 'decline' });
  expect(kinds(out.events)).toContain('permission-answer');
});

test('answerFor: allow → accept, timeout → cancel, questions → answers by id', () => {
  const out = run(
    "const q={questions:[{id:'q1',header:'Colour',question:'Which colour?',options:[{label:'red',description:''}]}]};" +
      'emit({' +
      "accept:app.answerFor('item/fileChange/requestApproval',{}, {behavior:'allow'})," +
      "cancel:app.answerFor('item/commandExecution/requestApproval',{}, {behavior:'deny',timedOut:true})," +
      "card:app.cardFor('item/tool/requestUserInput',{itemId:'i1',...q})," +
      "answers:app.answerFor('item/tool/requestUserInput',q,{behavior:'allow',updatedInput:{answers:{'Which colour?':'red'}}})," +
      "skipped:app.answerFor('item/tool/requestUserInput',q,{behavior:'deny'})" +
      '});'
  );
  expect(out.accept).toEqual({ decision: 'accept' });
  expect(out.cancel).toEqual({ decision: 'cancel' });
  expect(out.card).toMatchObject({ toolName: 'AskUserQuestion', toolUseId: 'i1' });
  expect(out.card.input.questions[0]).toMatchObject({ question: 'Which colour?', options: [{ label: 'red', description: '' }] });
  expect(out.answers).toEqual({ answers: { q1: { answers: ['red'] } } });
  expect(out.skipped).toEqual({ answers: {} });
});

test('compaction: the contextCompaction turn shows as system lines, with no second result footer', () => {
  const out = run(`A.threadId=null;feed(${JSON.stringify(path.join(FIX, 'compact-gpt55.jsonl'))});emit({events:cl.getChat(s.id,0),claude:st.getSession(s.id).claude});`);
  const sys = of(out.events, 'system').map((e: any) => e.text);
  expect(sys).toEqual(['⤷ codex is compacting the context…', '⤷ context compacted']);
  expect(of(out.events, 'result')).toHaveLength(1);
  expect(out.claude.state).toBe('idle');
});

test('writeMessage: turn/start when idle, turn/steer mid-turn, queued before the thread, /compact → thread/compact/start', () => {
  const out = run(
    "st.setClaude(s.id,{modelChoice:'gpt-5.5',effort:'low'});" +
      "app.appWriteMessage(proc,{text:'first'});" +
      "app.appHandleEvent(s.id,{method:'turn/started',params:{threadId:'t1',turn:{id:'turn1'}}});" +
      "app.appWriteMessage(proc,{text:'more',attachments:[{name:'a.png',path:'/x/a.png',isImage:true}]});" +
      "app.appHandleEvent(s.id,{method:'turn/completed',params:{threadId:'t1',turn:{id:'turn1',status:'completed'}}});" +
      "app.appWriteMessage(proc,{text:'/compact'});" +
      'A.ready=false;A.compacting=false;' +
      "app.appWriteMessage(proc,{text:'later'});" +
      'emit({wrote,queued:A.queue.length});'
  );
  const methods = out.wrote.map((w: any) => w.method);
  expect(methods).toEqual(['turn/start', 'turn/steer', 'thread/compact/start']);
  expect(out.wrote[0].params).toMatchObject({ threadId: 't1', model: 'gpt-5.5', effort: 'low', approvalPolicy: 'never', input: [{ type: 'text', text: 'first' }] });
  expect(out.wrote[1].params).toMatchObject({ expectedTurnId: 'turn1', input: [{ type: 'text', text: 'more' }, { type: 'localImage', path: '/x/a.png' }] });
  expect(out.queued).toBe(1);
});

test('permission modes map onto approvalPolicy; auto-compact fires past the threshold', () => {
  const out = run(
    "st.setClaude(s.id,{autoCompactTokens:1000});" +
      "app.appHandleEvent(s.id,{method:'thread/tokenUsage/updated',params:{threadId:'t1',tokenUsage:{last:{inputTokens:5000,cachedInputTokens:4000,outputTokens:3,totalTokens:5003},modelContextWindow:258400}}});" +
      'emit({' +
      "bypass:app.approvalPolicyFor({claude:{permissionMode:'bypassPermissions'}},'never')," +
      "hostAsks:app.approvalPolicyFor({claude:{permissionMode:'bypassPermissions'}},'untrusted')," +
      "ask:app.approvalPolicyFor({claude:{permissionMode:'default'}},'never')," +
      'wrote});'
  );
  expect([out.bypass, out.hostAsks, out.ask]).toEqual(['never', 'untrusted', 'untrusted']);
  expect(out.wrote.map((w: any) => w.method)).toEqual(['thread/compact/start']);
});

test('cfg.codexTransport picks the driver: app-server by default, exec stays selectable', () => {
  const pick =
    "const ed=await import('./server/lib/engine-driver.ts');" +
    "await import('./server/codex-app.ts');" +
    "emit({kind:ed.pickEngine({engine:'codex'}).permissions.kind,handshake:typeof ed.pickEngine({engine:'codex'}).handshake});";
  const def = runInChild(pick, env());
  const exec = runInChild(pick, env({ ARIGAMI_CODEX_TRANSPORT: 'exec' }));
  if (!def.ok) throw new Error(def.error);
  if (!exec.ok) throw new Error(exec.error);
  expect(def.out[0]).toEqual({ kind: 'rpc-request', handshake: 'function' });
  expect(exec.out[0]).toEqual({ kind: 'none', handshake: 'undefined' });
});
