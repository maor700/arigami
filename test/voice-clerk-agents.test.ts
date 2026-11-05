// Team by voice (docs/VOICE.md): the clerk's list_agents / ask_agent / create_session({agent}) against a stubbed registry,
// spoken-name resolution (Hebrew + ASR variants), reuse-vs-create, unknown names, the persona's team line, and one tool
// table shared by the web mints and the phone bridge. In-process (no disk); the audit-card case runs in a child.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';
import { tmpDir } from './_tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rtp = () => import(path.join(ROOT, 'server/voice-realtime.ts'));

const TEAM = [
  { slug: 'chief', name: "צ'יף", emoji: '🎩', description: 'אתה הצ\'יף אוף סטאף של מאור.' },
  { slug: 'kesher', name: 'קשר', emoji: '💬', description: 'וואטסאפ ופייסבוק.' },
  { slug: 'studio', name: 'סטודיו', emoji: '🎨' },
  { slug: 'astra', name: 'Astra', emoji: '🛰️' },
  { slug: 'nadlan', name: 'נדל"ן', emoji: '🏠' },
  { slug: 'social-manager', name: 'Social manager', emoji: '📢' },
];

type Ev = Record<string, unknown> & { seq: number };
function fakeHost(answer?: (id: string, text: string) => Ev[] | void, team = TEAM) {
  const chats = new Map<string, Ev[]>();
  const seqs = new Map<string, number>();
  const sessions: any[] = [
    { id: 'sess_chief_old', title: 'צ\'יף: ישן', folderId: null, claude: { state: 'idle' }, metadata: { agent: 'chief' }, updatedAt: '2026-11-01T00:00:00Z' },
    { id: 'sess_chief_home', title: 'צ\'יף', folderId: null, claude: { state: 'idle' }, metadata: { agent: 'chief', agentHome: true }, updatedAt: '2026-11-02T00:00:00Z' },
    { id: 'sess_chief_new', title: 'צ\'יף: חדש', folderId: null, claude: { state: 'idle' }, metadata: { agent: 'chief' }, updatedAt: '2026-11-04T00:00:00Z' },
    { id: 'sess_chief_busy', title: 'צ\'יף: עסוק', folderId: 'f1', claude: { state: 'working' }, metadata: { agent: 'chief' }, updatedAt: '2026-11-05T00:00:00Z' },
    { id: 'sess_chief_f1', title: 'צ\'יף: בפרויקט', folderId: 'f1', claude: { state: 'idle' }, metadata: { agent: 'chief' }, updatedAt: '2026-10-01T00:00:00Z' },
    { id: 'sess_plain', title: 'Docs', folderId: 'f1', claude: { state: 'idle' }, metadata: {} },
    { id: 'sess_gone', title: 'Gone', archived: true, claude: { state: 'idle' }, metadata: { agent: 'kesher' } },
  ];
  const log: string[] = [];
  const created: any[] = [];
  const append = (id: string, ev: Record<string, unknown>) => {
    const seq = (seqs.get(id) || 0) + 1;
    seqs.set(id, seq);
    (chats.get(id) || chats.set(id, []).get(id)!).push({ ...ev, seq });
  };
  const deliver = (id: string, text: string) => { append(id, { kind: 'user', text }); for (const ev of answer?.(id, text) || []) setTimeout(() => append(id, ev), ev.seq); };
  const host = {
    sessions, log, chats, created,
    listSessions: () => sessions,
    getSession: (id: string) => sessions.find((s) => s.id === id) || null,
    listAgents: () => team,
    sendMessage: (id: string, text: string) => { log.push(`msg ${id}: ${text}`); deliver(id, text); },
    interrupt: (id: string) => true,
    createSession: (o: { title: string; prompt: string; agent?: string | null }) => {
      const s = { id: `sess_new${created.length + 1}`, title: o.title, claude: { state: 'working' }, metadata: { createdBy: 'voice', ...(o.agent ? { agent: o.agent } : {}) } };
      sessions.push(s); created.push(o); log.push(`create ${o.title}${o.agent ? ` as ${o.agent}` : ''}: ${o.prompt}`); deliver(s.id, o.prompt);
      return s;
    },
    chatSeq: (id: string) => seqs.get(id) || 0,
    getChat: (id: string, since: number) => (chats.get(id) || []).filter((e) => e.seq > since),
    appendChat: append,
    folderName: (fid: string) => (fid === 'f1' ? 'Work' : null),
  };
  return host;
}

test('schemas: list_agents + ask_agent exist, create_session/list_sessions take an optional agent; the web mints and the phone bridge share one table', async () => {
  const rt = await rtp();
  const names = rt.CLERK_TOOLS.map((t: any) => t.name);
  expect(names).toEqual(['list_sessions', 'list_agents', 'session_status', 'ask_session', 'create_session', 'ask_agent', 'interrupt_session']);
  const byName = (n: string) => rt.CLERK_TOOLS.find((t: any) => t.name === n) as any;
  expect(byName('ask_agent').parameters.required).toEqual(['agent', 'prompt']);
  expect(byName('create_session').parameters.required).toEqual(['title', 'prompt']);
  expect(Object.keys(byName('create_session').parameters.properties)).toEqual(['title', 'prompt', 'agent']);
  expect(Object.keys(byName('list_sessions').parameters.properties)).toEqual(['agent']);
  expect(byName('list_agents').parameters.required).toEqual([]);
  // one table: OpenAI session config (web + phone), Gemini setup (web + phone) and the phone persona all carry the same seven tools
  const openai = rt.realtimeSessionConfig({ instructions: rt.phoneInstructions(TEAM) }).tools.map((t: any) => t.name);
  const gemini = (rt.geminiSetup({ instructions: rt.phoneInstructions(TEAM) }).tools as any)[0].functionDeclarations.map((t: any) => t.name);
  expect([openai, gemini]).toEqual([names, names]);
});

test('persona: the team line names every agent with its slug (web + phone), maps "תן ל-X" to ask_agent, asks to confirm a garbled name; no team → no line', async () => {
  const rt = await rtp();
  const web = rt.clerkInstructions(null, TEAM);
  const phone = rt.phoneInstructions(TEAM);
  for (const s of [web, phone]) {
    expect(s).toContain("צ'יף (chief), קשר (kesher), סטודיו (studio), Astra (astra), נדל\"ן (nadlan), Social manager (social-manager)");
    expect(s).toContain('"תן ל-X", "תבקש מ-X", "מה X עושה"');
    expect(s).toContain('ask_agent(agent, prompt)');
    expect(s).toContain('confirm it back in one word');
    expect(s).toContain('צ׳יף/chief');
  }
  expect(phone).toContain('calling by phone');
  expect(web).not.toContain('calling by phone');
  expect(rt.clerkInstructions(null, [])).toBe(rt.CLERK_INSTRUCTIONS + rt.HEBREW_FIRST);
  expect(rt.clerkInstructions(null, null, 'en')).toBe(rt.CLERK_INSTRUCTIONS);
  expect(rt.phoneInstructions()).toBe(rt.CLERK_INSTRUCTIONS + rt.HEBREW_FIRST + rt.PHONE_INSTRUCTIONS);
  expect(rt.clerkInstructions({ id: 'sess_x', title: 'T' }, TEAM)).toMatch(/\(social-manager\).*The owner has the session "T"/);
  expect(rt.CLERK_INSTRUCTIONS.length + rt.teamInstructions(TEAM).length).toBeLessThan(2200); // short persona
});

test('names: slug, display name, Hebrew/ASR variants and unique prefixes resolve; ambiguity and unknown names answer with the team', async () => {
  const rt = await rtp();
  const r = (q: string) => { const m = rt.resolveAgent(TEAM, q); return 'agent' in m ? m.agent.slug : `error: ${m.error}`; };
  for (const q of ['chief', 'Chief', "צ'יף", 'צ׳יף', 'ציף', ' הצ\'יף ', 'chief of staff', "צ'יף אוף סטאף"]) expect([q, r(q)]).toEqual([q, 'chief']);
  for (const q of ['kesher', 'קשר']) expect([q, r(q)]).toEqual([q, 'kesher']);
  for (const q of ['studio', 'סטודיו', 'Studio']) expect([q, r(q)]).toEqual([q, 'studio']);
  for (const q of ['astra', 'Astra', 'אסטרה', 'אסטרא']) expect([q, r(q)]).toEqual([q, 'astra']);
  for (const q of ['nadlan', 'נדל"ן', 'נדלן', 'נדל״ן', "נדל'ן"]) expect([q, r(q)]).toEqual([q, 'nadlan']);
  for (const q of ['social-manager', 'Social manager', 'social manager', 'social_manager', 'סושיאל', 'סושיאל מנג\'ר', 'social']) expect([q, r(q)]).toEqual([q, 'social-manager']);
  expect(r('nadl')).toBe('nadlan'); // unique prefix
  expect(r('merge')).toBe("error: no agent called \"merge\" — the team is: צ'יף (chief), קשר (kesher), סטודיו (studio), Astra (astra), נדל\"ן (nadlan), Social manager (social-manager)");
  expect(r('')).toMatch(/^error: which agent\? the team is: /);
  expect(r('s')).toMatch(/^error: no agent called "s"/); // too short to be a prefix
  const two = [{ slug: 'sam', name: 'Sam' }, { slug: 'samir', name: 'Samir' }];
  expect(rt.resolveAgent(two, 'sam')).toEqual({ agent: two[0] }); // exact beats prefix
  expect(rt.resolveAgent(two, 'sami')).toEqual({ agent: two[1] });
  expect(rt.resolveAgent([{ slug: 'sam', name: 'Sam' }, { slug: 'samir', name: 'Samir' }, { slug: 'samuel', name: 'Samuel' }], 'samu')).toEqual({ agent: { slug: 'samuel', name: 'Samuel' } });
  expect(rt.resolveAgent([{ slug: 'abc-x', name: 'A' }, { slug: 'abc-y', name: 'B' }], 'abc')).toEqual({ error: 'did you mean A or B?' });
  expect(rt.resolveAgent([], 'chief')).toEqual({ error: 'the owner has no team agents yet' });
  expect(rt.nameKey("נדל\"ן")).toBe(rt.nameKey('נדלן'));
  expect(rt.nameKey("צ'יף")).toBe(rt.nameKey('צ׳יף'));
});

test('list_agents reads the stubbed registry (slug, name, one-line description); list_sessions carries the agent and filters by a spoken name', async () => {
  const rt = await rtp();
  const host = fakeHost();
  expect(await rt.runClerkTool(host, 'list_agents', {})).toEqual({
    agents: [
      { slug: 'chief', name: "צ'יף", description: 'אתה הצ\'יף אוף סטאף של מאור.' },
      { slug: 'kesher', name: 'קשר', description: 'וואטסאפ ופייסבוק.' },
      { slug: 'studio', name: 'סטודיו' },
      { slug: 'astra', name: 'Astra' },
      { slug: 'nadlan', name: 'נדל"ן' },
      { slug: 'social-manager', name: 'Social manager' },
    ],
  });
  expect(await rt.runClerkTool(fakeHost(undefined, []), 'list_agents', {})).toEqual({ agents: [] });
  const all = (await rt.runClerkTool(host, 'list_sessions', {})) as any;
  expect(all.sessions.map((s: any) => [s.id, s.agent ?? null])).toEqual([
    ['sess_chief_old', 'chief'], ['sess_chief_home', 'chief'], ['sess_chief_new', 'chief'], ['sess_chief_busy', 'chief'], ['sess_chief_f1', 'chief'], ['sess_plain', null],
  ]);
  const mine = (await rt.runClerkTool(host, 'list_sessions', { agent: 'צ׳יף' })) as any;
  expect(mine.agent).toBe('chief');
  expect(mine.sessions.map((s: any) => s.id)).toEqual(['sess_chief_old', 'sess_chief_home', 'sess_chief_new', 'sess_chief_busy', 'sess_chief_f1']);
  expect(await rt.runClerkTool(host, 'list_sessions', { agent: 'kesher' })).toEqual({ agent: 'kesher', sessions: [] }); // archived ones are not shown
  await expect(rt.runClerkTool(host, 'list_sessions', { agent: 'nobody' })).rejects.toThrow(/no agent called "nobody" — the team is: /);
});

test('create_session(agent): the host births the session from the resolved slug (metadata agent + createdBy voice); unknown → spoken error, nothing created', async () => {
  const rt = await rtp();
  const host = fakeHost();
  expect(await rt.runClerkTool(host, 'create_session', { title: 'פלאייר', prompt: 'תכין פלאייר לדירה', agent: 'סטודיו' })).toEqual({ id: 'sess_new1', title: 'פלאייר', created: true, agent: 'studio' });
  expect(host.created).toEqual([{ title: 'פלאייר', prompt: 'תכין פלאייר לדירה', agent: 'studio' }]);
  expect(host.getSession('sess_new1').metadata).toEqual({ createdBy: 'voice', agent: 'studio' });
  expect(await rt.runClerkTool(host, 'create_session', { title: 'Plain', prompt: 'go' })).toEqual({ id: 'sess_new2', title: 'Plain', created: true });
  expect(host.created[1]).toEqual({ title: 'Plain', prompt: 'go' });
  expect(await rt.runClerkTool(host, 'create_session', { title: 'Blank agent', prompt: 'go', agent: '  ' })).toEqual({ id: 'sess_new3', title: 'Blank agent', created: true });
  await expect(rt.runClerkTool(host, 'create_session', { title: 'x', prompt: 'y', agent: 'merge' })).rejects.toThrow(/no agent called "merge"/);
  expect(host.created.length).toBe(3);
  // the host's own refusal (budget / unknown at the registry) surfaces as the tool error
  const strict = fakeHost();
  strict.createSession = () => { throw new Error('agent "צ\'יף" hit its daily token budget'); };
  await expect(rt.runClerkTool(strict, 'create_session', { title: 'x', prompt: 'y', agent: 'chief' })).rejects.toThrow('hit its daily token budget');
});

test('ask_agent: reuses the most recent idle session of that agent (the call folder first, then home), else creates one and waits for the first answer; busy/archived never reused', async () => {
  const rt = await rtp();
  const host = fakeHost((id, text) =>
    id === 'sess_chief_new' ? [{ kind: 'assistant-text', text: `חדש: ${text}`, seq: 10 }, { kind: 'result', text: '', seq: 20 }]
    : id === 'sess_chief_f1' ? [{ kind: 'assistant-text', text: 'מהפרויקט', seq: 10 }, { kind: 'result', text: '', seq: 20 }]
    : id === 'sess_chief_home' ? [{ kind: 'assistant-text', text: 'מהבית', seq: 10 }, { kind: 'result', text: '', seq: 20 }]
    : id.startsWith('sess_new') && text.includes('fast') ? [{ kind: 'assistant-text', text: 'ראשון', seq: 10 }, { kind: 'result', text: '', seq: 20 }]
    : id.startsWith('sess_new') ? [{ kind: 'assistant-text', partial: true, text: 'עובד', seq: 10 }]
    : []
  );
  // no folder context → the agent's home (idle), never the busy one
  const a = await rt.runClerkTool(host, 'ask_agent', { agent: 'צ\'יף', prompt: 'מה המצב?' }, { pollMs: 10 });
  expect(a).toEqual({ agent: 'chief', session: 'sess_chief_home', title: 'צ\'יף', created: false, done: true, answer: 'מהבית' });
  expect(host.created).toEqual([]);
  // the call's folder wins over the home
  const b = await rt.runClerkTool(host, 'ask_agent', { agent: 'chief', prompt: 'סטטוס' }, { pollMs: 10, folderId: 'f1' });
  expect(b).toMatchObject({ session: 'sess_chief_f1', created: false, answer: 'מהפרויקט' });
  // home busy → the newest root-level idle one; a session in another folder is never taken
  host.sessions.find((s) => s.id === 'sess_chief_home').claude.state = 'working';
  const c = await rt.runClerkTool(host, 'ask_agent', { agent: 'chief', prompt: 'שלום' }, { pollMs: 10, folderId: 'f9' });
  expect(c).toMatchObject({ session: 'sess_chief_new', answer: 'חדש: שלום' });
  expect(rt.idleAgentSession(host, 'chief', null)?.id).toBe('sess_chief_new');
  for (const s of host.sessions) if (s.id.startsWith('sess_chief') && !s.folderId) s.claude.state = 'working';
  expect(rt.idleAgentSession(host, 'chief', null)).toBeNull(); // only sess_chief_f1 is idle, in a folder the call is not in
  expect(rt.idleAgentSession(host, 'chief', 'f1')?.id).toBe('sess_chief_f1');
  expect(rt.idleAgentSession(host, 'kesher')).toBeNull(); // only an archived session
  // no idle session → a new one born from the agent, first prompt delivered once, its answer awaited
  const d = await rt.runClerkTool(host, 'ask_agent', { agent: 'סטודיו', prompt: 'fast: תכין לי פלאייר לדירה בנתיבות עם שלוש תמונות' }, { pollMs: 10 });
  expect(d).toEqual({ agent: 'studio', session: 'sess_new1', title: 'סטודיו: fast: תכין לי פלאייר לדירה בנתיבות עם שלוש תמונו…', created: true, done: true, answer: 'ראשון' });
  expect(host.created).toEqual([{ title: 'סטודיו: fast: תכין לי פלאייר לדירה בנתיבות עם שלוש תמונו…', prompt: 'fast: תכין לי פלאייר לדירה בנתיבות עם שלוש תמונות', agent: 'studio' }]);
  expect(host.log.filter((l) => l.startsWith('msg sess_new1'))).toEqual([]); // not sent twice
  // slow first turn → still working (a streaming partial is not an answer, same as ask_session)
  const e = await rt.runClerkTool(host, 'ask_agent', { agent: 'astra', prompt: 'תבדוק משהו' }, { askTimeoutMs: 120, pollMs: 10 });
  expect(e).toEqual({ agent: 'astra', session: 'sess_new2', title: 'Astra: תבדוק משהו', created: true, done: false, status: 'still working', partial: '' });
  await expect(rt.runClerkTool(host, 'ask_agent', { agent: 'nobody', prompt: 'hi' })).rejects.toThrow(/no agent called "nobody"/);
  await expect(rt.runClerkTool(host, 'ask_agent', { agent: 'chief', prompt: '  ' })).rejects.toThrow('prompt required');
  await expect(rt.runClerkTool(host, 'ask_agent', { prompt: 'hi' })).rejects.toThrow(/which agent\?/);
  expect(host.created.length).toBe(2);
});

test('audit cards carry the agent slug (title, voice.agent); the folder of the call context steers the reuse (child, provider path)', () => {
  const dir = tmpDir('arigami-clerk-agents-');
  const r = runInChild(
    "const rt=await import('./server/voice-realtime.js');const cards=[];console.log=()=>{};console.error=()=>{};" +
      "const team=[{slug:'chief',name:\"צ'יף\"},{slug:'studio',name:'סטודיו'}];" +
      "const sessions=[{id:'sess_ctx',title:'Ctx',folderId:'f1',claude:{state:'idle'},metadata:{}},{id:'sess_c1',title:'צ׳יף א',folderId:null,claude:{state:'idle'},metadata:{agent:'chief'},updatedAt:'2026-11-05'},{id:'sess_c2',title:'צ׳יף ב',folderId:'f1',claude:{state:'idle'},metadata:{agent:'chief'},updatedAt:'2026-11-01'}];" +
      "const host={listSessions:()=>sessions,getSession:(id)=>sessions.find(s=>s.id===id)||null,listAgents:()=>team,sendMessage:()=>{},interrupt:()=>true,createSession:(o)=>({id:'sess_new',title:o.title}),chatSeq:()=>0,getChat:()=>[],appendChat:(id,ev)=>cards.push({id,ev})};" +
      "const o=rt.openHostCall({sessionId:'sess_home',provider:'voice:gemini',model:'m'});const c=rt.liveCall(o.callId);c.contextSessionId='sess_ctx';" +
      "const r1=await rt.handleClerkTool({sessionId:'sess_home',callId:o.callId,name:'ask_agent',args:{agent:'ציף',prompt:'hi'}},host,{askTimeoutMs:30,pollMs:5});" +
      "const r2=await rt.handleClerkTool({sessionId:'sess_home',callId:o.callId,name:'create_session',args:{title:'T',prompt:'p',agent:'studio'}},host);" +
      "const r3=await rt.handleClerkTool({sessionId:'sess_home',callId:o.callId,name:'create_session',args:{title:'T',prompt:'p',agent:'nope'}},host);" +
      "const r4=await rt.handleClerkTool({sessionId:'sess_home',callId:o.callId,name:'list_agents',args:{}},host);" +
      'emit({r1:r1.body,r2:r2.body,r3:r3.body,r4:r4.body,cards:cards.map(c=>[c.id,c.ev.title,c.ev.body,c.ev.voice.agent||null])});',
    { ARIGAMI_DIR: dir, ARIGAMI_FUNNEL_QUIET: '1', HOME: path.join(dir, 'home'), GROQ_API_KEY: '' }
  );
  if (!r.ok) throw new Error(r.error);
  const o = r.out[0];
  expect(o.r1).toEqual({ ok: true, result: { agent: 'chief', session: 'sess_c2', title: 'צ׳יף ב', created: false, done: false, status: 'still working', partial: '' } }); // the context's folder wins over the newer one
  expect(o.r2).toEqual({ ok: true, result: { id: 'sess_new', title: 'T', created: true, agent: 'studio' } });
  expect(o.r3).toEqual({ ok: false, error: "no agent called \"nope\" — the team is: צ'יף (chief), סטודיו (studio)" });
  expect(o.r4).toEqual({ ok: true, result: { agents: [{ slug: 'chief', name: "צ'יף" }, { slug: 'studio', name: 'סטודיו' }] } });
  expect(o.cards).toEqual([
    ['sess_home', '📞 ask_agent · chief', 'ask_agent {"agent":"ציף","prompt":"hi"}\n\n→ chief ("צ׳יף ב"): still working', 'chief'],
    ['sess_home', '📞 create_session · studio', 'create_session {"title":"T","prompt":"p","agent":"studio"}\n\n→ created "T" as studio', 'studio'],
    ['sess_home', '📞 create_session', 'create_session {"title":"T","prompt":"p","agent":"nope"}\n\n→ error: no agent called "nope" — the team is: צ\'יף (chief), סטודיו (studio)', null],
    ['sess_home', '📞 list_agents', "list_agents\n\n→ צ'יף (chief), סטודיו (studio)", null],
  ]);
});

test('language: the phone and web setups default to Hebrew — persona opens in Hebrew, Gemini speechConfig he-IL, OpenAI transcription he; ARIGAMI_VOICE_LANG=en drops both (child)', async () => {
  const rt = await rtp();
  expect(rt.voiceLang()).toBe('he');
  expect(rt.speechLang()).toBe('he-IL');
  expect(rt.speechLang('en')).toBe('en-US');
  expect(rt.speechLang('pt')).toBe('pt');
  const phone = rt.geminiSetup({ instructions: rt.phoneInstructions(TEAM) }) as any;
  expect(phone.generationConfig.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }, languageCode: 'he-IL' });
  expect(phone.systemInstruction.parts[0].text).toContain("Open in Hebrew ('שלום, כאן הפקיד של אריגמי')");
  expect(phone.systemInstruction.parts[0].text).toContain('calling by phone');
  const web = rt.geminiSetup() as any;
  expect(web.generationConfig.speechConfig.languageCode).toBe('he-IL');
  expect(web.systemInstruction.parts[0].text).toContain('Open in Hebrew');
  const oa = rt.realtimeSessionConfig() as any;
  expect(oa.audio.input.transcription).toEqual({ model: 'gpt-4o-transcribe', language: 'he' });
  expect(oa.instructions).toContain('Open in Hebrew');
  const en = rt.geminiSetup({ lang: 'en' }) as any;
  expect(en.generationConfig.speechConfig.languageCode).toBe('en-US');
  expect(en.systemInstruction.parts[0].text).not.toContain('Open in Hebrew');
  const dir = tmpDir('arigami-clerk-lang-');
  const r = runInChild(
    "const rt=await import('./server/voice-realtime.js');const g=rt.geminiSetup({instructions:rt.phoneInstructions()});const o=rt.realtimeSessionConfig();" +
      'emit({lang:rt.voiceLang(),code:g.generationConfig.speechConfig.languageCode,he:g.systemInstruction.parts[0].text.includes("Open in Hebrew"),oa:o.audio.input.transcription.language,oaHe:o.instructions.includes("Open in Hebrew")});',
    { ARIGAMI_DIR: dir, ARIGAMI_FUNNEL_QUIET: '1', HOME: path.join(dir, 'home'), GROQ_API_KEY: '', ARIGAMI_VOICE_LANG: 'en' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0]).toEqual({ lang: 'en', code: 'en-US', he: false, oa: 'en', oaHe: false });
});
