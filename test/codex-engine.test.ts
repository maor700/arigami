// The codex EngineDriver (server/codex.ts), driven against the RECORDED output
// of real `codex exec --json` runs in test/fixtures/codex-stream/. Nothing here
// spawns codex: the fixtures are the contract, so a codex upgrade that changes
// the stream shape is caught by re-recording them, not by a flaky live call.
//
// What each group covers:
//   · normalization — every fixture replayed through handleEvent, asserting the
//     seven chat kinds that come out (this is the whole point of the driver)
//   · argv/env      — buildSpawn for a fresh turn and for a resume
//   · prepare()     — the generated $CODEX_HOME (config.toml, skills, auth)
//
// Everything runs out-of-process (test/_child.js): server modules capture
// ARIGAMI_DIR at import time, and `bun test` shares one module registry.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

const FIX = path.resolve(import.meta.dir, 'fixtures/codex-stream');
const fixture = (prefix: string): string => {
  const f = fs.readdirSync(FIX).find((n) => n.startsWith(prefix) && n.endsWith('.jsonl'));
  if (!f) throw new Error(`no fixture starting with ${prefix} in ${FIX}`);
  return path.join(FIX, f);
};

let dir: string;
let codexHome: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-codexdrv-'));
  // A stand-in for a real `codex login`: prepare() only ever symlinks this file.
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
  ...extra,
});

/**
 * Replay one fixture through the driver in a child process and hand back the
 * normalized chat log. The line loop is deliberately the SAME one spawnProc
 * runs on stdout — split on newlines, skip anything that doesn't parse — which
 * is what makes the interleaved plain-text log lines in the noauth fixture a
 * tested case rather than an assumption.
 */
function replay(prefix: string, extraEnv: Record<string, string> = {}) {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cl=await import('./server/claude.js');" +
      "const cx=await import('./server/codex.ts');" +
      "const fs=await import('node:fs');" +
      "const s=st.createSession({title:'codex',engine:'codex'});" +
      `const lines=fs.readFileSync(${JSON.stringify(fixture(prefix))},'utf8').split('\\n');` +
      'let skipped=0;' +
      'for(const line of lines){' +
      '  if(!line.trim())continue;' +
      '  let j;try{j=JSON.parse(line);}catch{skipped++;continue;}' +
      '  cx.codexHandleEvent(s.id,j);' +
      '}' +
      'emit({skipped,events:cl.getChat(s.id,0),claude:st.getSession(s.id).claude,engine:st.getSession(s.id).engine});',
    env(extraEnv)
  );
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

const kinds = (events: any[]) => events.map((e: any) => e.kind);
const of = (events: any[], kind: string) => events.filter((e: any) => e.kind === kind);

// ---- normalization ---------------------------------------------------------

test('the success run: host tool calls are suppressed, the prose lands, the thread id is stored', () => {
  const { events, claude, engine } = replay('success-test');
  expect(engine).toBe('codex');
  // thread.started is where a codex session id comes from — there is no
  // --session-id to pin, so this is what makes the NEXT turn a resume.
  expect(claude.sessionId).toBe('01a08616-3f7d-71c2-9a85-de4b285dd45a');
  expect(claude.state).toBe('idle');
  // set_status + publish_artifact are arigami's own tools: they drive the UI
  // directly, so neither the call nor its JSON result may echo into the
  // transcript — exactly as claude suppresses mcp__arigami__*.
  expect(of(events, 'tool-use')).toHaveLength(0);
  expect(of(events, 'tool-result')).toHaveLength(0);
  expect(kinds(events)).toEqual(['assistant-text', 'assistant-text', 'result']);
  expect(events[1].text).toContain('e7xgUUJ2b38');
});

test('agent_message / command_execution / file_change all map to their kinds', () => {
  const { events } = replay('full-kinds');
  expect(kinds(events)).toEqual([
    'assistant-text',
    'tool-use', // shell #1
    'tool-result',
    'tool-use', // shell #2
    'tool-result',
    'tool-use', // the file edit
    'tool-result',
    'assistant-text',
    'result',
  ]);
  const uses = of(events, 'tool-use');
  expect(uses[0].name).toBe('Bash');
  expect(uses[0].input.command).toContain('CODEX-POC-SHELL-OK');
  expect(uses[2].name).toBe('FileChange');
  expect(uses[2].input.changes[0].path).toBe('/tmp/codex-poc-scratch/hello.html');

  const results = of(events, 'tool-result');
  // exit_code 0 → not an error; the shell's own output is the result body.
  expect(results[0].isError).toBe(false);
  expect(results[1].content).toContain('CODEX-POC-SHELL-OK');
  expect(results[2].content).toBe('update: /tmp/codex-poc-scratch/hello.html');
  // Each result is tied to the call that produced it by codex's item id.
  expect(results.map((r: any) => r.toolUseId)).toEqual(['item_1', 'item_2', 'item_3']);
  expect(uses.map((u: any) => u.toolUseId)).toEqual(['item_1', 'item_2', 'item_3']);
});

test('item.started and item.completed on the SAME id are one call, not two', () => {
  // The real blocking run: request_screen opened at +11.9s and closed at +50.3s
  // when a human answered, with an unrelated agent_message emitted in between
  // while the call was still in flight.
  const { events } = replay('blocking-real');
  expect(of(events, 'tool-use')).toHaveLength(0); // arigami tool → suppressed
  expect(of(events, 'tool-result')).toHaveLength(0);
  expect(kinds(events)).toEqual(['assistant-text', 'assistant-text', 'assistant-text', 'result']);
});

test('a tool that timed out is a failed result, and the turn still completes', () => {
  // tool_timeout_sec=15 with nobody answering: codex reports `status:"failed"`
  // with an error.message, and then fires turn.completed anyway — a tool
  // timeout is a failed tool, not a failed turn.
  const { events } = replay('blocking-short');
  expect(kinds(events)).toEqual(['assistant-text', 'assistant-text', 'result']);
  expect(of(events, 'error')).toHaveLength(0);
  expect(events[1].text).toContain('timed out awaiting tools/call after 15s');
});

test('a non-arigami tool failure surfaces as an error-flagged tool-result', () => {
  // Same failed-mcp_tool_call shape as blocking-short, but on a server whose
  // results are NOT suppressed, so the failure has to reach the transcript.
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cl=await import('./server/claude.js');" +
      "const cx=await import('./server/codex.ts');" +
      "const s=st.createSession({title:'codex',engine:'codex'});" +
      "cx.codexHandleEvent(s.id,{type:'item.started',item:{id:'i1',type:'mcp_tool_call',server:'linear',tool:'list_issues',arguments:{q:'x'},status:'in_progress'}});" +
      "cx.codexHandleEvent(s.id,{type:'item.completed',item:{id:'i1',type:'mcp_tool_call',server:'linear',tool:'list_issues',arguments:{q:'x'},result:null,error:{message:'tool call error: connection closed'},status:'failed'}});" +
      'emit({events:cl.getChat(s.id,0),mcp:st.getSession(s.id).claude.mcp});',
    env()
  );
  expect(r.ok).toBe(true);
  const { events, mcp } = r.out[0];
  expect(kinds(events)).toEqual(['tool-use', 'tool-result']);
  // Codex reports {server, tool} in separate fields; every A3 allowlist and
  // every persona line is written against the flat name, so the driver has to
  // compose it.
  expect(events[0].name).toBe('mcp__linear__list_issues');
  expect(events[1].isError).toBe(true);
  expect(events[1].content).toContain('connection closed');
  // A live tool result is also the strongest MCP health signal there is.
  expect(mcp.servers.linear.status).toBe('degraded');
});

test('a successful tool result marks its MCP server connected', () => {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cx=await import('./server/codex.ts');" +
      "const s=st.createSession({title:'codex',engine:'codex'});" +
      "cx.codexHandleEvent(s.id,{type:'item.completed',item:{id:'i1',type:'mcp_tool_call',server:'arigami',tool:'set_status',arguments:{},result:{content:[{type:'text',text:'{\"ok\":true}'}]},error:null,status:'completed'}});" +
      'emit({mcp:st.getSession(s.id).claude.mcp});',
    env()
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].mcp.servers.arigami.status).toBe('connected');
});

test('the 401 run: log noise is dropped, reconnect spam is dropped, the real failure is not', () => {
  const { events, skipped, claude } = replay('error-noauth');
  // The raw stream interleaves plain-text warnings and RUST_LOG lines with the
  // JSON — the same skip-what-does-not-parse loop spawnProc uses handles it.
  expect(skipped).toBeGreaterThan(0);
  // Ten near-identical "Reconnecting... N/5" lines are transport chatter the
  // human cannot act on; the actionable failure arrives as turn.failed.
  const errors = of(events, 'error');
  expect(errors.map((e: any) => e.text.slice(0, 40))).toEqual([
    'Falling back from WebSockets to HTTPS tr',
    'unexpected status 401 Unauthorized: Miss',
  ]);
  expect(errors.every((e: any) => !/Reconnecting/.test(e.text))).toBe(true);
  // turn.failed is the ONLY signal that the turn failed — the process still
  // exits 0 on this run, so the exit code says nothing.
  expect(of(events, 'result')).toHaveLength(0);
  expect(claude.state).toBe('idle');
});

test('a turn.failed shaped like a 429 gets a plain-language quota note, not just the raw error', () => {
  // No fixture backs this — no live run here ever hit a real quota wall (see
  // the NOT VERIFIED comment on rateLimitNote() in server/codex.ts). This only
  // tests OUR heuristic against the one wrapper shape that IS verified live
  // (codex-cli wraps every HTTP failure as "unexpected status <code> ..." —
  // see error-noauth), not that codex actually reports quota this way.
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cl=await import('./server/claude.js');" +
      "const cx=await import('./server/codex.ts');" +
      "const s=st.createSession({title:'codex',engine:'codex'});" +
      "cx.codexHandleEvent(s.id,{type:'turn.failed',error:{message:'unexpected status 429 Too Many Requests: resets in 2 hours'}});" +
      'emit({events:cl.getChat(s.id,0)});',
    env()
  );
  expect(r.ok).toBe(true);
  const { events } = r.out[0];
  expect(kinds(events)).toEqual(['error', 'system']);
  expect(events[1].text).toContain('quota');
  expect(events[1].text).toContain('resets in 2 hours');
});

test('an ordinary turn.failed does not get a quota note', () => {
  const { events } = replay('error-noauth');
  expect(of(events, 'system')).toHaveLength(0);
});

test('a run that only talks produces prose and a result footer', () => {
  const { events } = replay('error-badmodel');
  expect(kinds(events)).toEqual(['assistant-text', 'result']);
  expect(events[0].text).toBe('SHOULD-NOT-REACH-HERE');
});

test('request_action is suppressed like every other arigami tool', () => {
  const { events } = replay('timeout-short');
  expect(kinds(events)).toEqual(['assistant-text', 'assistant-text', 'result']);
});

test('codex usage field names are mapped onto the context meter', () => {
  const { claude } = replay('success-test');
  // codex's input_tokens 113904 already includes cached_input 96000.
  expect(claude.usage.breakdown).toMatchObject({ input: 113904 - 96000, cacheRead: 96000, cacheCreation: 0, output: 298 });
  expect(claude.usage.ctxTokens).toBe(113904);
});

test('parseRolloutTail: last turn_context model, last request usage and the window codex reported', () => {
  const lines = [
    '{"type":"turn_con',
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10 }, model_context_window: 100 } } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-terra' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 228197, cached_input_tokens: 226560 }, model_context_window: 258400 } } }),
  ].join('\n');
  const r = runInChild(
    "const cx=await import('./server/codex.ts');" + `emit(cx.parseRolloutTail(${JSON.stringify(lines)}));emit(cx.parseRolloutTail(''));`,
    env()
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ model: 'gpt-5.6-terra', last: { input_tokens: 228197, cached_input_tokens: 226560 }, window: 258400 });
  expect(r.out[1]).toEqual({ model: null, last: null, window: null });
});

test('turn.completed: the session model and live context come from the thread rollout, the window from codex', () => {
  const r = runInChild(
    "const fs=require('node:fs');const path=require('node:path');" +
      "const st=await import('./server/state.ts');const cx=await import('./server/codex.ts');" +
      "const s=st.createSession({title:'codex',engine:'codex'});st.setClaude(s.id,{sessionId:'th-1'});" +
      "const d=path.join(cx.codexHomeFor(s.id),'sessions','2026','09','14');fs.mkdirSync(d,{recursive:true});" +
      "fs.writeFileSync(path.join(d,'rollout-2026-09-14T00-00-00-th-1.jsonl')," +
      JSON.stringify(
        [
          JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-terra' } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 129200, cached_input_tokens: 129000, output_tokens: 5 }, model_context_window: 258400 } } }),
        ].join('\n') + '\n'
      ) +
      ");" +
      "cx.codexHandleEvent(s.id,{type:'turn.completed',usage:{input_tokens:900000,cached_input_tokens:800000,output_tokens:50}});" +
      'emit(st.getSession(s.id).claude);',
    env()
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].model).toBe('gpt-5.6-terra');
  expect(r.out[0].usage).toMatchObject({ ctxTokens: 129200, ctxWindow: 258400, ctxPct: 50, ctxAssumed: false });
});

// ---- session id policy -----------------------------------------------------

test('the session id is observed off thread.started, never assigned', () => {
  const r = runInChild(
    "const cx=await import('./server/codex.ts');" +
      "const ed=await import('./server/lib/engine-driver.ts');" +
      'const d=ed.pickEngine({engine:"codex"});' +
      'emit({' +
      '  mode:d.sessionId.mode,' +
      '  hasAssign:typeof d.sessionId.assign,' +
      '  fromStart:d.sessionId.from({type:"thread.started",thread_id:"abc-123"}),' +
      '  fromOther:d.sessionId.from({type:"turn.started"}),' +
      '  permissions:d.permissions,' +
      '  injectMcp:d.injectMcp({id:"x"}),' +
      '});',
    env()
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toMatchObject({
    mode: 'observed',
    hasAssign: 'undefined',
    fromStart: 'abc-123',
    fromOther: null,
    // `codex exec` has no --permission-prompt-tool equivalent at all.
    permissions: { kind: 'none' },
    // MCP is file-based for codex: config.toml, written by prepare().
    injectMcp: [],
  });
});

// ---- buildSpawn ------------------------------------------------------------

function built(patch: string, resume: boolean, sessionId: string | null) {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cx=await import('./server/codex.ts');" +
      "const s=st.createSession({title:'codex',engine:'codex',cwd:'/tmp'});" +
      `st.setClaude(s.id,${patch});` +
      `const b=cx.codexBuildSpawn(st.getSession(s.id),{resume:${resume},sessionId:${JSON.stringify(sessionId)}});` +
      'emit({args:b.args,cwd:b.cwd,bin:b.bin,env:{CODEX_HOME:b.env.CODEX_HOME,ARIGAMI_SESSION_ID:b.env.ARIGAMI_SESSION_ID,CLAUDE_CODE_OAUTH_TOKEN:b.env.CLAUDE_CODE_OAUTH_TOKEN||null},id:s.id});',
    env()
  );
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

test('a fresh turn: exec, the bypass flag, and `-` so the prompt comes from stdin', () => {
  const b = built('{}', false, null);
  expect(b.args).toEqual([
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '-',
  ]);
  // `-` last is load-bearing: with a prompt on argv AND a piped stdin, codex
  // prints "Reading additional input from stdin..." and blocks forever.
  expect(b.args[b.args.length - 1]).toBe('-');
  expect(b.cwd).toBe('/tmp');
  expect(b.env.CODEX_HOME).toContain(b.id); // per-session home, not the shared ~/.codex
  // A claude account token has no meaning to codex and must not ride along.
  expect(b.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(null);
});

test('a resume turn: `exec resume <thread>`, and no -C (that flag does not exist there)', () => {
  const b = built('{}', true, '01a08616-3f7d-71c2-9a85-de4b285dd45a');
  expect(b.args.slice(0, 3)).toEqual(['exec', 'resume', '01a08616-3f7d-71c2-9a85-de4b285dd45a']);
  expect(b.args).not.toContain('-C');
  expect(b.args).not.toContain('--cd');
  expect(b.args[b.args.length - 1]).toBe('-');
});

test('model and effort: a codex model and effort ride argv, a claude alias does not', () => {
  const b = built("{modelChoice:'gpt-5.6-terra',effort:'high'}", false, null);
  expect(b.args).toContain('-m');
  expect(b.args[b.args.indexOf('-m') + 1]).toBe('gpt-5.6-terra');
  // effort is a CONFIG key on codex, not a flag — but `-c` works on both `exec`
  // and `exec resume`, so it stays argv rather than being baked into the file.
  expect(b.args).toContain('-c');
  expect(b.args[b.args.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"');

  // `ultra` is gpt-5.6-terra's top rung and the launcher offers it (see
  // CODEX_MODELS in web/src/lib/engines.js) — so it must reach argv. If the
  // server dropped it, the turn would quietly run at the model's default while
  // the cockpit kept showing "Ultra".
  const top = built("{modelChoice:'gpt-5.6-terra',effort:'ultra'}", false, null);
  expect(top.args[top.args.indexOf('-c') + 1]).toBe('model_reasoning_effort="ultra"');

  // Codex silently falls back to its default for a model it doesn't know, so a
  // claude alias leaking in from the launcher would look like it had worked.
  // Same for an effort rung no codex model has.
  const alias = built("{modelChoice:'opus',effort:'medium-high'}", false, null);
  expect(alias.args).not.toContain('-m');
  expect(alias.args).not.toContain('-c');
});

// ---- codexModels(): the catalog is per login --------------------------------

const CACHE_ROW = (slug: string, priority: number, efforts: string[], extra: Record<string, unknown> = {}) => ({
  slug,
  display_name: slug.toUpperCase(),
  description: `${slug} desc`,
  visibility: 'list',
  priority,
  default_reasoning_level: 'medium',
  supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effort })),
  ...extra,
});

test('parseCodexModelsCache: slug-keyed rows, priority order, hidden rows dropped, ladder from the row', () => {
  const r = runInChild(
    "const cx=await import('./server/codex.ts');" +
      'emit(cx.parseCodexModelsCache(' +
      JSON.stringify({
        fetched_at: 'x',
        models: [
          CACHE_ROW('gpt-5.5', 12, ['low', 'medium', 'high', 'xhigh'], { default_reasoning_level: 'xhigh' }),
          CACHE_ROW('gpt-reserve', 3, ['low'], { visibility: 'hide' }),
          CACHE_ROW('gpt-6-astra', 1, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], { context_window: 272000, effective_context_window_percent: 95 }),
          { id: 'legacy-id-row', name: 'Legacy', visibility: 'list', priority: 5 },
          { junk: true },
        ],
      }) +
      '));' +
      'emit(cx.parseCodexModelsCache({}));emit(cx.parseCodexModelsCache(null));',
    env()
  );
  expect(r.ok).toBe(true);
  const [rows, empty1, empty2] = r.out;
  expect(rows.map((m: any) => m.id)).toEqual(['gpt-6-astra', 'legacy-id-row', 'gpt-5.5']);
  expect(rows[0]).toEqual({ id: 'gpt-6-astra', name: 'GPT-6-ASTRA', desc: 'gpt-6-astra desc', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium', contextWindow: 258_400 });
  expect(rows[2].defaultEffort).toBe('xhigh');
  expect(rows[1]).toEqual({ id: 'legacy-id-row', name: 'Legacy', desc: '', efforts: [], defaultEffort: null, contextWindow: null });
  expect(empty1).toEqual([]);
  expect(empty2).toEqual([]);
});

test('codexModels(): the ACTIVE codex account\'s models_cache.json wins over the machine home, which wins over the static fallback', () => {
  const adir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-codexmodels-'));
  try {
    // machine home (~/.codex stand-in): the personal login's catalog
    const home = path.join(adir, 'machine-home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.json'), '{"auth_mode":"chatgpt"}');
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [CACHE_ROW('gpt-5.6-terra', 7, ['low', 'medium'])] }));
    // a chatgpt account with its own home under codex-accounts/<id>/: a business catalog
    const accHome = path.join(adir, 'codex-accounts', 'acc_biz');
    fs.mkdirSync(accHome, { recursive: true });
    fs.writeFileSync(path.join(accHome, 'auth.json'), '{"auth_mode":"chatgpt"}');
    fs.writeFileSync(path.join(accHome, 'models_cache.json'), JSON.stringify({ models: [CACHE_ROW('gpt-6-astra', 1, ['low', 'medium', 'ultra']), CACHE_ROW('gpt-5.6-terra', 7, ['low'])] }));
    // With a codex account present the store makes it active on load (seed),
    // so "no active codex account" means no chatgpt/api-key account at all.
    const accounts = (activeCodex: string | null) => ({
      activeId: null,
      activeIds: { claude: null, codex: activeCodex },
      accounts: activeCodex ? [{ id: activeCodex, provider: 'codex', type: 'chatgpt', label: 'biz', email: null, plan: null, createdAt: 1 }] : [],
    });
    const run = (active: string | null) => {
      fs.writeFileSync(path.join(adir, 'accounts.json'), JSON.stringify(accounts(active)));
      return runInChild(
        "const ac=await import('./server/accounts.js');ac.initAccounts();" +
          "const cx=await import('./server/codex.ts');" +
          "emit({active:ac.getActiveId('codex'),ids:cx.codexModels().map(m=>m.id)});",
        { ARIGAMI_DIR: adir, ARIGAMI_PORT: '', ARIGAMI_FUNNEL_QUIET: '1', ARIGAMI_CODEX_HOME: home }
      );
    };
    const biz = run('acc_biz');
    expect(biz.ok).toBe(true);
    expect(biz.out[0].active).toBe('acc_biz');
    expect(biz.out[0].ids).toEqual(['gpt-6-astra', 'gpt-5.6-terra']);

    // no chatgpt/api-key account → the machine's own login (seeded as the
    // codex-home account) → its catalog
    const none = run(null);
    expect(none.ok).toBe(true);
    expect(none.out[0].ids).toEqual(['gpt-5.6-terra']);

    // no cache anywhere → the static fallback, never an empty picker
    fs.rmSync(path.join(home, 'models_cache.json'));
    fs.rmSync(path.join(accHome, 'models_cache.json'));
    const fallback = run('acc_biz');
    expect(fallback.ok).toBe(true);
    expect(fallback.out[0].ids).toEqual(['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
  } finally {
    fs.rmSync(adir, { recursive: true, force: true });
  }
});

// ---- prepare(): the generated $CODEX_HOME ----------------------------------

function prepared(create = "{title:'codex',engine:'codex',cwd:'/tmp'}", pre = '') {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cx=await import('./server/codex.ts');" +
      "const fs=await import('node:fs');" +
      "const path=await import('node:path');" +
      pre +
      `const s=st.createSession(${create});` +
      'cx.codexPrepare(st.getSession(s.id),{resume:false});' +
      'const home=cx.codexHomeFor(s.id);' +
      'const skills=path.join(home,"skills");' +
      'emit({' +
      '  toml:fs.readFileSync(path.join(home,"config.toml"),"utf8"),' +
      '  auth:fs.readlinkSync(path.join(home,"auth.json")),' +
      '  skillRoots:fs.readdirSync(skills).sort(),' +
      '  arigamiSkills:fs.readlinkSync(path.join(skills,"arigami")),' +
      '});',
    env()
  );
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

test('config.toml wires the host MCP server under the snake_case key codex actually reads', () => {
  const { toml } = prepared();
  // Verified live: `[mcpServers.arigami]` — the spelling every other tool uses —
  // produces no error, no warning, and no tools at all.
  expect(toml).toContain('[mcp_servers.arigami]');
  expect(toml).not.toContain('mcpServers');
  expect(toml).toContain('[mcp_servers.arigami.env]');
  expect(toml).toContain('host-mcp.js');
  expect(toml).toMatch(/ARIGAMI_SESSION_ID = "sess_/);
  // The session's cwd is pre-trusted so codex never stops to ask about it.
  expect(toml).toContain('[projects."/tmp"]');
  expect(toml).toContain('trust_level = "trusted"');
});

test('tool_timeout_sec is pinned high enough for a card a human has to click', () => {
  const { toml } = prepared();
  // Measured: at 15s a request_screen died after exactly 15.1s; at 180s a real
  // human answered at 38.35s and it went through. 1800 = the host's own
  // SCREEN_REQUEST_TIMEOUT_MS, so the engine never gives up before the card does.
  expect(toml).toContain('tool_timeout_sec = 1800');
  expect(toml).toContain('startup_timeout_sec = 20');
});

test('skills are handed over verbatim, as a symlink named `arigami`', () => {
  const { skillRoots, arigamiSkills, auth } = prepared();
  // The namespace comes from the ROOT DIRECTORY NAME, so calling it `arigami`
  // is what makes personaBlock's promised `/arigami:<skill>` resolve.
  expect(skillRoots).toContain('arigami');
  expect(arigamiSkills.endsWith('/skills')).toBe(true);
  // `.system` is codex's own pack, wiped on every codex upgrade — nothing of
  // ours may live under it, and we don't link it in either.
  expect(skillRoots).not.toContain('.system');
  // One login serves every session: auth.json is a link, never a copy (a copy
  // would go stale the moment codex refreshes the ChatGPT token).
  expect(auth.endsWith('/auth.json')).toBe(true);
});

test('prepare refuses to spawn without a codex login, instead of failing with a 401 mid-turn', () => {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cx=await import('./server/codex.ts');" +
      "const s=st.createSession({title:'codex',engine:'codex'});" +
      'try{cx.codexPrepare(st.getSession(s.id),{resume:false});emit({threw:false});}' +
      'catch(e){emit({threw:true,msg:e.message});}',
    // point at a directory that has no auth.json
    env({ ARIGAMI_CODEX_HOME: path.join(dir, 'nowhere') })
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].threw).toBe(true);
  expect(r.out[0].msg).toContain('codex login');
});

test('ENGINE/A3: an agent with an allowlist runs — its policy hook is written to $CODEX_HOME/hooks.json and the spawn trusts it', () => {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const a=await import('./server/agents.ts');" +
      "const cx=await import('./server/codex.ts');" +
      "const fs=await import('node:fs');" +
      "const path=await import('node:path');" +
      "a.createAgent({name:'Bot',slug:'bot',engine:'codex',model:'gpt-6-astra',tools:['gmail','open_tab']});" +
      "const s=st.createSession({title:'codex',engine:'codex',cwd:'/tmp',model:'gpt-6-astra',metadata:{agent:'bot'}});" +
      'cx.codexPrepare(st.getSession(s.id),{resume:false});' +
      'const home=cx.codexHomeFor(s.id);' +
      'const hooks=JSON.parse(fs.readFileSync(path.join(home,"hooks.json"),"utf8"));' +
      'const b=cx.codexBuildSpawn(st.getSession(s.id),{resume:false,sessionId:null});' +
      "a.updateAgent('bot',{tools:[]});" +
      'cx.codexPrepare(st.getSession(s.id),{resume:false});' +
      'const b2=cx.codexBuildSpawn(st.getSession(s.id),{resume:false,sessionId:null});' +
      'emit({hooks,args:b.args,gone:!fs.existsSync(path.join(home,"hooks.json")),args2:b2.args});',
    env()
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  // Claude Code's hooks shape — codex reads exactly this (measured live).
  const hook = o.hooks.hooks.PreToolUse[0].hooks[0];
  expect(hook.type).toBe('command');
  expect(hook.command).toContain('policy-hook.js');
  // without the flag codex skips the hooks silently
  expect(o.args).toContain('--dangerously-bypass-hook-trust');
  expect(o.args).toContain('-m');
  expect(o.args[o.args.indexOf('-m') + 1]).toBe('gpt-6-astra');
  expect(o.gone).toBe(true);
  expect(o.args2).not.toContain('--dangerously-bypass-hook-trust');
});

test('the hook-trust notice codex emits for OUR flag is not surfaced as an error line', () => {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cl=await import('./server/claude.js');" +
      "const cx=await import('./server/codex.ts');" +
      "const s=st.createSession({title:'codex',engine:'codex'});" +
      "cx.codexHandleEvent(s.id,{type:'thread.started',thread_id:'t1'});" +
      "cx.codexHandleEvent(s.id,{type:'error',message:'`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.'});" +
      // measured 2026-09-14: `codex exec --json` actually delivers the notice as two item-level errors, not top-level
      "cx.codexHandleEvent(s.id,{type:'item.completed',item:{id:'item_0',type:'error',message:'`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.'}});" +
      "cx.codexHandleEvent(s.id,{type:'item.completed',item:{id:'item_1',type:'error',message:'`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.'}});" +
      "cx.codexHandleEvent(s.id,{type:'item.completed',item:{id:'item_2',type:'error',message:'real item error'}});" +
      "cx.codexHandleEvent(s.id,{type:'error',message:'something actually wrong'});" +
      'emit({errors:cl.getChat(s.id,0).filter(e=>e.kind===\'error\').map(e=>e.text)});',
    env()
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].errors).toEqual(['real item error', 'something actually wrong']);
});

test('a session with no agent policy gets no hooks.json and no hook-trust flag', () => {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cx=await import('./server/codex.ts');" +
      "const fs=await import('node:fs');" +
      "const path=await import('node:path');" +
      "const s=st.createSession({title:'codex',engine:'codex',cwd:'/tmp'});" +
      'cx.codexPrepare(st.getSession(s.id),{resume:false});' +
      'const b=cx.codexBuildSpawn(st.getSession(s.id),{resume:false,sessionId:null});' +
      'emit({hasHooks:fs.existsSync(path.join(cx.codexHomeFor(s.id),"hooks.json")),args:b.args});',
    env()
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].hasHooks).toBe(false);
  expect(r.out[0].args).not.toContain('--dangerously-bypass-hook-trust');
});

// ---- writeMessage ----------------------------------------------------------

test('a turn is written to stdin and stdin is closed — the EOF is what starts codex', () => {
  const r = runInChild(
    "const cx=await import('./server/codex.ts');" +
      'let written="",ended=false;' +
      'const proc={id:"sess_x",child:{stdin:{writableEnded:false,end(t){written+=t||"";ended=true;this.writableEnded=true;},write(t){written+=t||"";}},once(){}}};' +
      'cx.codexDriver.writeMessage(proc,{text:"hello codex"});' +
      'emit({written,ended,done:proc.codexStdinDone});',
    env()
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toMatchObject({ written: 'hello codex\n', ended: true, done: true });
});

test('a message that arrives mid-turn is carried over, not written into a closed stdin', () => {
  // node makes a write-after-end an async 'error' event, not a throw — so
  // without this the second message would vanish with no trace at all.
  const r = runInChild(
    "const cx=await import('./server/codex.ts');" +
      'let written="",hooked=false;' +
      'const proc={id:"sess_x",child:{stdin:{writableEnded:false,end(t){written+=t||"";this.writableEnded=true;},write(t){written+=t||"";}},once(){hooked=true;}}};' +
      'cx.codexDriver.writeMessage(proc,{text:"first"});' +
      'cx.codexDriver.writeMessage(proc,{text:"second"});' +
      'emit({written,hooked});',
    env()
  );
  expect(r.ok).toBe(true);
  // Only the first turn reached the process; the second waits for its exit.
  expect(r.out[0].written).toBe('first\n');
  expect(r.out[0].hooked).toBe(true);
});

test('attachments are listed by path — codex takes images only at spawn', () => {
  const r = runInChild(
    "const cx=await import('./server/codex.ts');" +
      'let written="";' +
      'const proc={id:"sess_x",child:{stdin:{writableEnded:false,end(t){written+=t||"";this.writableEnded=true;}}, once(){}}};' +
      'cx.codexDriver.writeMessage(proc,{text:"look",attachments:[{name:"a.png",path:"/tmp/a.png",isImage:true}]});' +
      'emit({written});',
    env()
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].written).toContain('- a.png → /tmp/a.png (image)');
});

// ---- lifecycle -------------------------------------------------------------

test('deleting a session takes its $CODEX_HOME with it', () => {
  // The thread history lives in that directory, so it survives every turn —
  // which makes cleaning it up on delete the only thing standing between a
  // long-lived host and a disk full of dead codex homes.
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cx=await import('./server/codex.ts');" +
      "const fs=await import('node:fs');" +
      "const s=st.createSession({title:'codex',engine:'codex',cwd:'/tmp'});" +
      'cx.codexPrepare(st.getSession(s.id),{resume:false});' +
      'const home=cx.codexHomeFor(s.id);' +
      'const before=fs.existsSync(home);' +
      'cx.removeCodexSession(s.id);' +
      'emit({before,after:fs.existsSync(home)});',
    env()
  );
  expect(r.ok).toBe(true);
  expect(r.out[0]).toEqual({ before: true, after: false });
});

test('the tool timeout is overridable, so the give-up path can be exercised', () => {
  const r = runInChild(
    "const st=await import('./server/state.ts');" +
      "const cx=await import('./server/codex.ts');" +
      "const fs=await import('node:fs');" +
      "const path=await import('node:path');" +
      "const s=st.createSession({title:'codex',engine:'codex',cwd:'/tmp'});" +
      'cx.codexPrepare(st.getSession(s.id),{resume:false});' +
      'emit({toml:fs.readFileSync(path.join(cx.codexHomeFor(s.id),"config.toml"),"utf8")});',
    env({ ARIGAMI_CODEX_TOOL_TIMEOUT_SEC: '15' })
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].toml).toContain('tool_timeout_sec = 15');
});
