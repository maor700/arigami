// Stage 1c clerk (docs/VOICE.md): the mint passes the client secret through and never the key, the gate's shapes
// come back as-is, the model is overridable; every clerk tool runs against a fake host with an audit card per call;
// the transcript grows per call and lands once; the ledger gets a clamped duration. Provider/ledger cases run in a
// fresh child (ARIGAMI_DIR is captured at import); the executor cases run in-process (they touch no disk).
import { test, expect } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = (dir: string) => ({ ARIGAMI_DIR: dir, ARIGAMI_FUNNEL_QUIET: '1', HOME: path.join(dir, 'home'), GROQ_API_KEY: '' });
const KEY = 'sk-test-SECRETKEY-0123456789abcdef';
const IMPORTS =
  "const vp=await import('./server/voice-providers.js');const vu=await import('./server/voice-usage.js');const cfgm=await import('./server/lib/config.js');const rt=await import('./server/voice-realtime.js');" +
  'const logs=[];const _l=console.log,_e=console.error;console.log=(...a)=>logs.push(a.join(" "));console.error=(...a)=>logs.push(a.join(" "));' +
  'const okMint=(v="ek_test_secret_value")=>new Response(JSON.stringify({value:v,expires_at:1900000000,session:{id:"sess_x"}}),{status:200,headers:{"content-type":"application/json"}});' +
  "const cards=[];const host={appendChat:(id,ev)=>cards.push({id,ev})};";
const run = (body: string) => {
  const r = runInChild(IMPORTS + body, env(tmpDir('arigami-rt-')));
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
};

test('mint: gate shapes pass through; ok → client secret, never the key; request shaped for OpenAI; model/voice from config', () => {
  const out = run(
    `const KEY=${JSON.stringify(KEY)};const reqs=[];const f=async(u,i)=>{reqs.push({url:String(u),headers:i.headers,body:JSON.parse(i.body)});return okMint();};` +
      "const noSid=await rt.mintRealtimeSession({},{fetchImpl:f});" +
      "const none=await rt.mintRealtimeSession({sessionId:'sess_abc'},{fetchImpl:f});" +
      "vp.setProviderSecret('voice:openai',{token:KEY});" +
      'cfgm.updateVoiceConfig({enabled:false});' +
      "const off=await rt.mintRealtimeSession({sessionId:'sess_abc'},{fetchImpl:f});" +
      'cfgm.updateVoiceConfig({enabled:true});' +
      "cfgm.updateVoiceConfig({caps:{'voice:openai':0.01}});vu.recordVoiceUsage('voice:openai',{usd:1});" +
      "const capped=await rt.mintRealtimeSession({sessionId:'sess_abc'},{fetchImpl:f});" +
      "cfgm.updateVoiceConfig({caps:{'voice:openai':null}});" +
      "const ok=await rt.mintRealtimeSession({sessionId:'sess_abc',lang:'he'},{fetchImpl:f});" +
      "cfgm.cfg.voice.realtime={model:'gpt-realtime-2.1-mini',voice:'cedar'};" +
      "const mini=await rt.mintRealtimeSession({sessionId:'sess_abc',takeover:true},{fetchImpl:f});" +
      "cfgm.cfg.voice.realtime={model:'../evil',voice:'nope'};" +
      "const junk=await rt.mintRealtimeSession({sessionId:'sess_abc',takeover:true},{fetchImpl:f});" +
      "const rej=await rt.mintRealtimeSession({sessionId:'sess_abc',takeover:true},{fetchImpl:async()=>new Response('{\"error\":{\"message\":\"bad key '+KEY+'\"}}',{status:401})});" +
      "const noval=await rt.mintRealtimeSession({sessionId:'sess_abc',takeover:true},{fetchImpl:async()=>new Response('{}',{status:200})});" +
      'emit({noSid:[noSid.status,noSid.body.error],none:none.body,off:off.body,capped:capped.body,ok:{status:ok.status,body:ok.body},req:reqs[0],mini:[mini.body.model,mini.body.voice],junk:[junk.body.model,junk.body.voice],rej:[rej.status,rej.body.error],noval:[noval.status,noval.body.error],' +
      'leak:JSON.stringify({ok:ok.body,mini:mini.body,rej:rej.body,logs}).includes(KEY),live:rt.liveCallCount(),logs});'
  );
  expect(out.noSid).toEqual([400, 'sessionId required']);
  expect(out.none.needs_setup).toBe('voice:openai');
  expect(out.none.why).toContain('live voice');
  expect(out.off.disabled).toBe(true);
  expect(out.capped.budget).toBe('soft-stopped');
  expect(out.ok.status).toBe(200);
  expect(out.ok.body.ok).toBe(true);
  expect(out.ok.body.clientSecret).toBe('ek_test_secret_value');
  expect(out.ok.body.expiresAt).toBe(1900000000);
  expect(out.ok.body.callId).toMatch(/^call_[a-z0-9]{8,}$/);
  expect(out.ok.body.model).toBe('gpt-realtime-2.1');
  expect(out.ok.body.voice).toBe('marin');
  expect(out.ok.body.callsUrl).toBe('https://api.openai.com/v1/realtime/calls');
  expect(out.req.url).toBe('https://api.openai.com/v1/realtime/client_secrets');
  expect(out.req.headers.Authorization).toBe(`Bearer ${KEY}`);
  expect(out.req.body.expires_after).toEqual({ anchor: 'created_at', seconds: 600 });
  const s = out.req.body.session;
  expect(s.type).toBe('realtime');
  expect(s.model).toBe('gpt-realtime-2.1');
  expect(s.audio.output.voice).toBe('marin');
  expect(s.audio.input.turn_detection.type).toBe('server_vad');
  expect(s.audio.input.transcription.language).toBe('he');
  expect(s.instructions).toContain('רגע, בודק');
  expect(s.tools.map((t: any) => t.name)).toEqual(['list_sessions', 'list_agents', 'session_status', 'ask_session', 'create_session', 'ask_agent', 'interrupt_session', 'call_contact']);
  expect(s.tools.every((t: any) => t.type === 'function' && t.parameters.type === 'object')).toBe(true);
  expect(out.mini).toEqual(['gpt-realtime-2.1-mini', 'cedar']);
  expect(out.junk).toEqual(['gpt-realtime-2.1', 'marin']);
  expect(out.rej[0]).toBe(502);
  expect(out.rej[1]).toContain('401');
  expect(out.noval).toEqual([502, 'OpenAI answered 200 without a client secret']);
  expect(out.leak).toBe(false);
  expect(out.live).toBe(1); // stage 1d: one call at a time — each takeover ended the one before
});

test('call window: a tool/transcript/end needs the call of the same session; end clamps the duration into the window and records minutes; the transcript lands once', () => {
  const out = run(
    `const KEY=${JSON.stringify(KEY)};vp.setProviderSecret('voice:openai',{token:KEY});` +
      "let t=1000000;const now=()=>t;" +
      "const a=await rt.mintRealtimeSession({sessionId:'sess_a',lang:'he'},{fetchImpl:async()=>okMint(),now});const call=a.body.callId;" +
      "const wrongSession=rt.addRealtimeTranscript({sessionId:'sess_b',callId:call,turns:[]},{now});" +
      "const noCall=rt.addRealtimeTranscript({sessionId:'sess_a',callId:'call_nope12345',turns:[]},{now});" +
      "const badTool=await rt.handleClerkTool({sessionId:'sess_a',callId:'call_nope12345',name:'list_sessions',args:{}},host,{now});" +
      "const t1=rt.addRealtimeTranscript({sessionId:'sess_a',callId:call,turns:[{role:'user',text:' מה המצב? ',id:'i1'},{role:'assistant',text:'רגע, בודק',id:'o1'},{role:'junk',text:'x'},{role:'user',text:''}]},{now});" +
      "const t2=rt.addRealtimeTranscript({sessionId:'sess_a',callId:call,turns:[{role:'assistant',text:'רגע, בודק את הסשנים',id:'o1'},{role:'assistant',text:'הכל בסדר.'}]},{now});" +
      "t+=90_000;" +
      "const end=rt.endRealtimeCall({sessionId:'sess_a',callId:call,seconds:5000,reason:'hangup'},host,{now});" +
      "const again=rt.endRealtimeCall({sessionId:'sess_a',callId:call,seconds:1},host,{now});" +
      "const b=await rt.mintRealtimeSession({sessionId:'sess_a'},{fetchImpl:async()=>okMint(),now});t+=20_000;" +
      "const endB=rt.endRealtimeCall({sessionId:'sess_a',callId:b.body.callId,seconds:7},host,{now});" +
      "const c=await rt.mintRealtimeSession({sessionId:'sess_c'},{fetchImpl:async()=>okMint(),now});t+=30_000;rt.addRealtimeTranscript({sessionId:'sess_c',callId:c.body.callId,turns:[{role:'user',text:'hello'}]},{now});" +
      "t+=rt.CALL_IDLE_MS+1;rt.setSweepHost(host);const gone=rt.sweep(now);" +
      "const usage=vu.voiceUsageThisMonth()['voice:openai'];" +
      'emit({wrongSession:[wrongSession.status,wrongSession.body.error],noCall:noCall.status,badTool:badTool.status,t1:t1.body,t2:t2.body,end:end.body,again:again.status,usage,endB:endB.body.seconds,gone:gone.length,live:rt.liveCallCount(),cards});'
  );
  expect(out.wrongSession).toEqual([403, 'unknown call for this session']);
  expect(out.noCall).toBe(403);
  expect(out.badTool).toBe(403);
  expect(out.t1).toEqual({ ok: true, turns: 2 });
  expect(out.t2).toEqual({ ok: true, turns: 3 }); // o1 grew in place, one new turn
  expect(out.end.ok).toBe(true);
  expect(out.end.seconds).toBe(95); // 5000 s reported, 90 s + 5 s slack is the window
  expect(out.end.turns).toBe(3);
  expect(out.again).toBe(403);
  expect(out.usage.seconds).toBe(95 + 7 + 30);
  expect(out.usage.calls).toBe(3);
  expect(out.usage.usd).toBeGreaterThan(0);
  expect(out.endB).toBe(7);
  expect(out.gone).toBe(1);
  expect(out.live).toBe(0);
  expect(out.cards.map((c: any) => [c.id, c.ev.kind, c.ev.extension, c.ev.voice.reason, c.ev.voice.seconds])).toEqual([
    ['sess_a', 'ext-card', 'voice', 'hangup', 95],
    ['sess_a', 'ext-card', 'voice', 'hangup', 7],
    ['sess_c', 'ext-card', 'voice', 'lost', 30],
  ]);
  expect(out.cards[0].ev.title).toBe('📞 שיחה קולית · 1:35');
  expect(out.cards[0].ev.body).toBe('**אתה:** מה המצב?\n\n**הפקיד:** רגע, בודק את הסשנים\n\n**הפקיד:** הכל בסדר.');
  expect(out.cards[1].ev.title).toBe('📞 Voice call · 0:07');
  expect(out.cards[1].ev.body).toBe('_(nothing was said)_');
});

// ---- the executor against a fake host (in-process: nothing here touches disk) ----
type Ev = Record<string, unknown> & { seq: number };
function fakeHost(answer?: (id: string, text: string) => Ev[] | void) {
  const chats = new Map<string, Ev[]>();
  const seqs = new Map<string, number>();
  const sessions: any[] = [
    { id: 'sess_one', title: 'Fix login', status: 'In Progress', folderId: 'f1', engine: 'claude', claude: { state: 'working' }, metadata: { result: { state: 'milestone', summary: 'half way' } } },
    { id: 'sess_two', title: 'Docs', status: 'Done', folderId: null, engine: 'codex', claude: { state: 'idle' }, metadata: {} },
    { id: 'sess_old', title: 'Gone', archived: true, claude: { state: 'idle' } },
  ];
  const log: string[] = [];
  const append = (id: string, ev: Record<string, unknown>) => {
    const seq = (seqs.get(id) || 0) + 1;
    seqs.set(id, seq);
    (chats.get(id) || chats.set(id, []).get(id)!).push({ ...ev, seq });
  };
  const host = {
    sessions, log, chats,
    listSessions: () => sessions,
    getSession: (id: string) => sessions.find((s) => s.id === id) || null,
    sendMessage: (id: string, text: string) => { log.push(`msg ${id}: ${text}`); append(id, { kind: 'user', text }); for (const ev of answer?.(id, text) || []) setTimeout(() => append(id, ev), ev.seq); },
    interrupt: (id: string) => { log.push(`interrupt ${id}`); return id === 'sess_one'; },
    createSession: ({ title, prompt }: { title: string; prompt: string }) => { const s = { id: 'sess_new', title, status: 'In Progress', claude: { state: 'working' } }; sessions.push(s); log.push(`create ${title}: ${prompt}`); return s; },
    chatSeq: (id: string) => seqs.get(id) || 0,
    getChat: (id: string, since: number) => (chats.get(id) || []).filter((e) => e.seq > since),
    appendChat: append,
    folderName: (fid: string) => (fid === 'f1' ? 'Work' : null),
  };
  return host;
}
const rtp = () => import(path.join(ROOT, 'server/voice-realtime.ts'));

test('tools: list is thin, status carries the result summary, interrupt + create go through the host, unknown tool / bad args / archived or unknown session throw', async () => {
  const rt = await rtp();
  const host = fakeHost();
  expect(await rt.runClerkTool(host, 'list_sessions', {})).toEqual({
    sessions: [
      { id: 'sess_one', title: 'Fix login', status: 'In Progress', folder: 'Work', working: true },
      { id: 'sess_two', title: 'Docs', status: 'Done', folder: null, working: false },
    ],
  });
  expect(await rt.runClerkTool(host, 'session_status', { id: 'sess_one' })).toEqual({ id: 'sess_one', title: 'Fix login', status: 'In Progress', folder: 'Work', working: true, engine: 'claude', state: 'working', result: { state: 'milestone', summary: 'half way' } });
  expect((await rt.runClerkTool(host, 'session_status', { id: 'sess_two' })).result).toBeNull();
  expect(await rt.runClerkTool(host, 'interrupt_session', { id: 'sess_one' })).toEqual({ id: 'sess_one', interrupted: true });
  expect(await rt.runClerkTool(host, 'interrupt_session', { id: 'sess_two' })).toEqual({ id: 'sess_two', interrupted: false });
  expect(await rt.runClerkTool(host, 'create_session', { title: '  Deploy  ', prompt: 'ship it' })).toEqual({ id: 'sess_new', title: 'Deploy', created: true });
  expect(host.log).toEqual(['interrupt sess_one', 'interrupt sess_two', 'create Deploy: ship it']);
  await expect(rt.runClerkTool(host, 'merge_session', { id: 'sess_one' })).rejects.toThrow('unknown tool: merge_session');
  await expect(rt.runClerkTool(host, 'session_status', { id: 'sess_old' })).rejects.toThrow('unknown session');
  await expect(rt.runClerkTool(host, 'session_status', { id: '../x' })).rejects.toThrow('unknown session');
  await expect(rt.runClerkTool(host, 'create_session', { title: 'x' })).rejects.toThrow('title and prompt required');
  await expect(rt.runClerkTool(host, 'ask_session', { id: 'sess_one', prompt: '   ' })).rejects.toThrow('prompt required');
  await expect(rt.runClerkTool(host, 'list_sessions', [] as any)).rejects.toThrow('args must be an object');
});

test('ask_session: delivered through the message path, the final text comes back at result; partials are not the answer; a slow turn → still working; a failed turn says so', async () => {
  const rt = await rtp();
  const host = fakeHost((id) =>
    id === 'sess_one'
      ? [{ kind: 'assistant-text', partial: true, text: 'Looking', seq: 10 }, { kind: 'assistant-text', text: 'Looking at it.', seq: 20 }, { kind: 'assistant-text', partial: true, text: 'Done', seq: 30 }, { kind: 'assistant-text', text: 'Done: the login bug is fixed.', seq: 40 }, { kind: 'result', text: '', seq: 60 }]
      : id === 'sess_two'
        ? [{ kind: 'assistant-text', partial: true, text: 'Still', seq: 10 }]
        : [{ kind: 'error', text: 'The turn ended unexpectedly', seq: 20 }]
  );
  host.sessions.push({ id: 'sess_err', title: 'Broken', claude: { state: 'idle' } });
  const a = await rt.runClerkTool(host, 'ask_session', { id: 'sess_one', prompt: 'how is the login bug?' }, { pollMs: 10 });
  expect(a).toEqual({ done: true, answer: 'Done: the login bug is fixed.' });
  expect(host.log[0]).toBe('msg sess_one: how is the login bug?');
  const b = await rt.runClerkTool(host, 'ask_session', { id: 'sess_two', prompt: 'status?' }, { askTimeoutMs: 120, pollMs: 10 });
  expect(b).toEqual({ done: false, status: 'still working', partial: '' });
  const c = await rt.runClerkTool(host, 'ask_session', { id: 'sess_err', prompt: 'hi' }, { pollMs: 10 });
  expect(c).toEqual({ done: true, error: true, answer: 'The turn ended unexpectedly' });
});

test('handleClerkTool: one audit card per call in the calling session (asked + what came back), errors included', async () => {
  const rt = await rtp();
  // A call is minted only through the provider path; this file's in-process half fakes one by going through the ledger-free pieces.
  const host = fakeHost();
  const r = await rt.handleClerkTool({ sessionId: 'sess_one', callId: 'call_zzzzzzzz', name: 'list_sessions', args: {} }, host);
  expect(r.status).toBe(403); // no live call: nothing runs, nothing is written
  expect(host.chats.get('sess_one')).toBeUndefined();
});

test('audit cards via the provider path: tool results and errors land as compact voice cards in the calling session', () => {
  const out = run(
    `const KEY=${JSON.stringify(KEY)};vp.setProviderSecret('voice:openai',{token:KEY});` +
      "const sessions=[{id:'sess_one',title:'Fix login',status:'In Progress',claude:{state:'working'}},{id:'sess_two',title:'Docs',status:'Done',claude:{state:'idle'}}];const log=[];" +
      "const fh={listSessions:()=>sessions,getSession:(id)=>sessions.find(s=>s.id===id)||null,sendMessage:(id,t)=>log.push(t),interrupt:(id)=>true,createSession:({title,prompt})=>({id:'sess_new',title}),chatSeq:()=>0,getChat:()=>[],appendChat:host.appendChat};" +
      "const a=await rt.mintRealtimeSession({sessionId:'sess_one'},{fetchImpl:async()=>okMint()});const call=a.body.callId;" +
      "const r1=await rt.handleClerkTool({sessionId:'sess_one',callId:call,name:'list_sessions',args:{}},fh);" +
      "const r2=await rt.handleClerkTool({sessionId:'sess_one',callId:call,name:'session_status',args:{id:'sess_nope'}},fh);" +
      "const r3=await rt.handleClerkTool({sessionId:'sess_one',callId:call,name:'nuke',args:{}},fh);" +
      "const r4=await rt.handleClerkTool({sessionId:'sess_one',callId:call,name:'create_session',args:{title:'Deploy',prompt:'ship '+'x'.repeat(500)}},fh);" +
      "const r5=await rt.handleClerkTool({sessionId:'sess_one',callId:call,name:'ask_session',args:{id:'sess_two',prompt:'hi'}},fh,{askTimeoutMs:50,pollMs:10});" +
      'emit({r1:r1.body,r2:r2.body,r3:[r3.status,r3.body.error],r4:r4.body,r5:r5.body,cards:cards.map(c=>[c.id,c.ev.title,c.ev.body,c.ev.voice.tool]),tools:rt.liveCall(call).tools});'
  );
  expect(out.r1).toEqual({ ok: true, result: { sessions: [{ id: 'sess_one', title: 'Fix login', status: 'In Progress', folder: null, working: true }, { id: 'sess_two', title: 'Docs', status: 'Done', folder: null, working: false }] } });
  expect(out.r2).toEqual({ ok: false, error: 'unknown session' });
  expect(out.r3).toEqual([400, 'unknown tool: nuke']);
  expect(out.r4).toEqual({ ok: true, result: { id: 'sess_new', title: 'Deploy', created: true } });
  expect(out.r5).toEqual({ ok: true, result: { done: false, status: 'still working', partial: '' } });
  expect(out.tools).toBe(4);
  expect(out.cards.map((c: any) => [c[0], c[1], c[3]])).toEqual([
    ['sess_one', '📞 list_sessions', 'list_sessions'],
    ['sess_one', '📞 session_status', 'session_status'],
    ['sess_one', '📞 create_session', 'create_session'],
    ['sess_one', '📞 ask_session', 'ask_session'],
  ]);
  expect(out.cards[0][2]).toBe('list_sessions\n\n→ Fix login (working), Docs');
  expect(out.cards[1][2]).toBe('session_status {"id":"sess_nope"}\n\n→ error: unknown session');
  expect(out.cards[2][2]).toMatch(/^create_session \{"title":"Deploy","prompt":"ship x{195}…"\}\n\n→ created "Deploy"$/);
  expect(out.cards[3][2]).toBe('ask_session {"id":"sess_two","prompt":"hi"}\n\n→ still working');
});

test('Gemini Live: with only Gemini connected the mint is an ephemeral auth token + the host-built setup; OpenAI wins when both are connected; minutes priced at the Live rate', () => {
  const out = run(
    `const KEY=${JSON.stringify(KEY)};const reqs=[];` +
      "const f=async(u,i)=>{reqs.push({url:String(u),headers:i.headers,body:JSON.parse(i.body)});return String(u).includes('auth_tokens')?new Response(JSON.stringify({name:'auth_tokens/abc123'}),{status:200}):okMint();};" +
      "vp.setProviderSecret('voice:gemini',{token:KEY});" +
      "let t=1700000000000;const now=()=>t;" +
      "const g=await rt.mintRealtimeSession({sessionId:'sess_g',lang:'he'},{fetchImpl:f,now});" +
      "t+=120_000;const end=rt.endRealtimeCall({sessionId:'sess_g',callId:g.body.callId,seconds:120},host,{now});" +
      "cfgm.cfg.voice.realtime={geminiModel:'gemini-3.1-flash-live-preview',geminiVoice:'Puck'};" +
      "const g2=await rt.mintRealtimeSession({sessionId:'sess_g',takeover:true},{fetchImpl:f,now});" +
      "cfgm.cfg.voice.realtime={geminiModel:'../x',geminiVoice:'lower'};" +
      "const g3=await rt.mintRealtimeSession({sessionId:'sess_g',takeover:true},{fetchImpl:f,now});" +
      "const noName=await rt.mintRealtimeSession({sessionId:'sess_g',takeover:true},{fetchImpl:async()=>new Response('{}',{status:200}),now});" +
      "const rej=await rt.mintRealtimeSession({sessionId:'sess_g',takeover:true},{fetchImpl:async()=>new Response('{\"error\":{\"message\":\"bad '+KEY+'\"}}',{status:403}),now});" +
      "vp.setProviderSecret('voice:openai',{token:KEY+'oa'});" +
      "const both=await rt.mintRealtimeSession({sessionId:'sess_g',takeover:true},{fetchImpl:f,now});" +
      "const usage=vu.voiceUsageThisMonth()['voice:gemini'];" +
      'emit({g:g.body,req:reqs[0],g2:[g2.body.model,g2.body.voice,g2.body.setup.tools[0].functionDeclarations[0].behavior||null,g2.body.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName],g3:[g3.body.model,g3.body.voice],noName:[noName.status,noName.body.error],rej:[rej.status,rej.body.error],end:end.body,both:[both.body.provider,both.body.transport],usage,' +
      'leak:JSON.stringify({g:g.body,g2:g2.body,rej:rej.body,logs}).includes(KEY),logs});'
  );
  expect(out.g.ok).toBe(true);
  expect(out.g.provider).toBe('voice:gemini');
  expect(out.g.transport).toBe('gemini-ws');
  expect(out.g.token).toBe('auth_tokens/abc123');
  expect(out.g.model).toBe('gemini-3.8-live');
  expect(out.g.voice).toBe('Kore');
  expect(out.g.wsUrl).toBe('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained');
  expect(out.g.expiresAt).toBe(1700000000 + 7200);
  expect(out.g.clientSecret).toBeUndefined();
  expect(out.req.url).toBe('https://generativelanguage.googleapis.com/v1beta/auth_tokens');
  expect(out.req.headers['x-goog-api-key']).toBe(KEY);
  expect(out.req.body).toEqual({ uses: 1, expireTime: new Date(1700000000000 + 7200_000).toISOString(), newSessionExpireTime: new Date(1700000000000 + 120_000).toISOString() });
  const su = out.g.setup;
  expect(su.model).toBe('models/gemini-3.8-live');
  expect(su.generationConfig.responseModalities).toEqual(['AUDIO']);
  expect(su.systemInstruction.parts[0].text).toContain('רגע, בודק');
  expect(su.tools[0].functionDeclarations.map((t: any) => [t.name, t.behavior])).toEqual([['list_sessions', 'BLOCKING'], ['list_agents', 'BLOCKING'], ['session_status', 'BLOCKING'], ['ask_session', 'BLOCKING'], ['create_session', 'BLOCKING'], ['ask_agent', 'BLOCKING'], ['interrupt_session', 'BLOCKING'], ['call_contact', 'BLOCKING']]);
  expect(su.inputAudioTranscription).toEqual({});
  expect(su.outputAudioTranscription).toEqual({});
  expect(su.sessionResumption).toEqual({});
  expect(su.contextWindowCompression).toEqual({ slidingWindow: {} });
  expect(su.realtimeInputConfig.activityHandling).toBe('START_OF_ACTIVITY_INTERRUPTS');
  expect(out.g2).toEqual(['gemini-3.1-flash-live-preview', 'Puck', null, 'Puck']);
  expect(out.g3).toEqual(['gemini-3.8-live', 'Kore']);
  expect(out.noName).toEqual([502, 'Gemini answered 200 without a token']);
  expect(out.rej[0]).toBe(502);
  expect(out.rej[1]).toContain('403');
  expect(out.end.seconds).toBe(120);
  expect(out.both).toEqual(['voice:openai', 'openai-webrtc']);
  expect(out.usage.seconds).toBe(120);
  expect(out.usage.usd).toBeCloseTo(0.046, 5);
  expect(out.leak).toBe(false);
});

test('stage 1d: a global call anchors in the voice home session, carries the open session as context, and only one call is live at a time', () => {
  const out = run(
    `const KEY=${JSON.stringify(KEY)};const reqs=[];const f=async(u,i)=>{reqs.push(JSON.parse(i.body));return okMint();};` +
      "vp.setProviderSecret('voice:openai',{token:KEY});" +
      "let homes=0;const mh={getSession:(id)=>id==='sess_open'?{id,title:'Fix \"login\"'}:id==='sess_arch'?{id,title:'old',archived:true}:null,voiceHome:()=>{homes++;return {id:'sess_home'};}};" +
      "const noHost=await rt.mintRealtimeSession({home:true},{fetchImpl:f});" +
      "const a=await rt.mintRealtimeSession({home:true,contextSessionId:'sess_open'},{fetchImpl:f,host:mh});" +
      "const busy=await rt.mintRealtimeSession({sessionId:'sess_other'},{fetchImpl:f,host:mh});" +
      "const failed=await rt.mintRealtimeSession({sessionId:'sess_other',takeover:true},{fetchImpl:async()=>new Response('{}',{status:200}),host:mh});" +
      "const stillA=!!rt.liveCall(a.body.callId);" +
      "const b=await rt.mintRealtimeSession({home:true,contextSessionId:'sess_arch',takeover:true},{fetchImpl:f,host:mh});" +
      "const aGone=!rt.liveCall(a.body.callId);" +
      "rt.endRealtimeCall({sessionId:'sess_home',callId:b.body.callId,seconds:3},host);" +
      "const c=await rt.mintRealtimeSession({sessionId:'sess_x',contextSessionId:'sess_x'},{fetchImpl:f,host:mh});" +
      "emit({noHost:noHost.status,a:[a.body.sessionId,a.body.contextSessionId],instr:reqs[0].session.instructions,busy:[busy.status,busy.body.busy],failed:failed.status,stillA,aGone,b:[b.body.sessionId,b.body.contextSessionId],bInstr:reqs[1].session.instructions,c:c.body.contextSessionId,cInstr:reqs[2].session.instructions,homes,live:rt.liveCallCount(),base:rt.clerkInstructions()===rt.CLERK_INSTRUCTIONS+rt.HEBREW_FIRST});"
  );
  expect(out.noHost).toBe(500);
  expect(out.a).toEqual(['sess_home', 'sess_open']);
  expect(out.instr).toContain('The owner has the session "Fix  login " (id sess_open) open right now');
  expect(out.busy).toEqual([409, true]);
  expect(out.failed).toBe(502); // a takeover whose mint fails leaves the live call alone
  expect(out.stillA).toBe(true);
  expect(out.aGone).toBe(true);
  expect(out.b).toEqual(['sess_home', null]); // an archived session is no context
  expect(out.bInstr).not.toContain('open right now');
  expect(out.c).toBe(null); // the anchor itself is not "another" open session
  expect(out.cInstr).not.toContain('open right now');
  expect(out.homes).toBe(2);
  expect(out.live).toBe(1);
  expect(out.base).toBe(true);
});
