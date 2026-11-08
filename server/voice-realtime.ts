// Stage 1c "voice clerk" (docs/VOICE.md): mint OpenAI Realtime client secrets, run the clerk's tools host-side,
// keep one transcript + an audit card per call. The API key never leaves this process.
import { cfg } from './lib/config.js';
import { requireVoiceProvider, providerSecretFields, scrubProviderSecrets, openaiBase, geminiBase, type VoiceRequirement } from './voice-providers.js';
import { recordVoiceUsage } from './voice-usage.js';

export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1'; // PLAN.md's gpt-realtime-2 family; the mini is selectable via config
export const REALTIME_MINI_MODEL = 'gpt-realtime-2.1-mini';
export const DEFAULT_REALTIME_VOICE = 'marin';
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const MODEL_RE = /^gpt-realtime[A-Za-z0-9.-]{0,40}$/;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-live'; // the stable Live model (2026-09); 3.1-flash-live-preview / 2.5 native-audio still accepted
export const DEFAULT_GEMINI_VOICE = 'Kore';
const GEMINI_MODEL_RE = /^gemini-[A-Za-z0-9.-]{1,60}$/;
const GEMINI_VOICE_RE = /^[A-Z][a-z]{2,20}$/;
export const SECRET_TTL_S = 600;
export const GEMINI_NEW_SESSION_S = 120; // the token may open its session for this long; resumes inside the call ride the same token
export const MAX_CALL_S = 2 * 3600;
export const CALL_IDLE_MS = 10 * 60_000; // no browser post for this long → the call is treated as lost
export const ASK_TIMEOUT_MS = 90_000;
export const ASK_MAX_TIMEOUT_MS = 120_000;
export const ANSWER_MAX_CHARS = 1500;
export const PROMPT_MAX_CHARS = 4000;
const TURN_MAX_CHARS = 2000;
const TURNS_MAX = 400;
const MINT_TIMEOUT_MS = 15_000;
const SESSION_ID_RE = /^sess_[A-Za-z0-9_-]{1,64}$/;
const CALL_ID_RE = /^call_[a-z0-9]{8,40}$/;

export type Json = { kind: 'json'; status: number; body: Record<string, unknown> | VoiceRequirement };
const json = (status: number, body: Record<string, unknown> | VoiceRequirement): Json => ({ kind: 'json', status, body });
const bad = (error: string, status = 400): Json => json(status, { error });

// ---- the clerk: persona + tool schemas (OpenAI function format) ----
export const CLERK_INSTRUCTIONS =
  "You are Arigami's voice clerk: the fast front desk for the owner's work sessions (each session is an AI agent working on a task). " +
  'Keep every reply to one or two short spoken sentences, in the language the person speaks (Hebrew or English). ' +
  'Everything about sessions comes from the tools; never invent a session, a status or a result. ' +
  "Before a tool that takes time (ask_session, create_session) say a short 'רגע, בודק' (or 'one moment, checking'), then report what came back, summarized. " +
  "If a tool answers 'still working', say so and offer to check again later. Refer to sessions by title, never read ids aloud. " +
  'You cannot merge, delete, or do work yourself: offer only what a tool can do. ' +
  'To phone another person for the owner use call_contact: it only puts a card in the app, the owner presses Send there — say so; never guess a number, ask for it.';
// The owner's team (agents) the clerk may hand work to by voice: ask_agent / create_session({agent}); names arrive by ASR, so confirm when unsure.
export const TEAM_INSTRUCTIONS =
  ' The owner also has a team of agents (list_agents): {team}. "תן ל-X", "תבקש מ-X", "מה X עושה" or "ask X" mean that agent: ' +
  'ask_agent(agent, prompt) for a question or a task (it reuses the agent\'s idle session or opens one), list_sessions({agent}) for what it is doing, create_session({agent}) for a fresh task. ' +
  'Spoken names may come garbled (צ\'יף/צ׳יף/chief, נדל"ן/נדלן, אסטרה/astra, קשר/kesher, סטודיו/studio): when the name is unclear, confirm it back in one word before acting.';
// Default spoken language: cfg.voiceLang ('he') — the clerk opens in Hebrew and follows the caller from there (call 3 opened in English, ASR guessed Italian).
export const HEBREW_FIRST = " Open in Hebrew ('שלום, כאן הפקיד של אריגמי') and keep speaking Hebrew unless the person clearly speaks another language.";
export const voiceLang = (): string => (/^[a-z]{2}$/.test(String(cfg.voiceLang || '')) ? String(cfg.voiceLang) : 'he');
const BCP47: Record<string, string> = { he: 'he-IL', en: 'en-US', ru: 'ru-RU', fr: 'fr-FR', es: 'es-ES', ar: 'ar-XA', de: 'de-DE' };
/** The speech-language hint for the providers ('he' → 'he-IL'). */
export const speechLang = (lang: string = voiceLang()): string => BCP47[lang] || lang;
const langInstructions = (lang: string): string => (lang === 'he' ? HEBREW_FIRST : '');
export interface AgentLite { slug: string; name: string; emoji?: string; description?: string }
export const teamInstructions = (team: readonly AgentLite[] | null | undefined): string =>
  team?.length ? TEAM_INSTRUCTIONS.replace('{team}', team.map((a) => `${a.name} (${a.slug})`).join(', ')) : '';

const idParam = { id: { type: 'string', description: 'A session id from list_sessions' } };
export const CLERK_TOOLS = [
  { type: 'function', name: 'list_sessions', description: 'The open work sessions: id, title, status, folder, agent (team member it belongs to, if any), and whether it is working right now. Pass agent to see one team member\'s sessions only.', parameters: { type: 'object', properties: { agent: { type: 'string', description: 'Optional: a team member (slug or spoken name) to filter by' } }, required: [] } },
  { type: 'function', name: 'list_agents', description: "The owner's team: each agent's slug, name and what it does. Use the slug with ask_agent / create_session.", parameters: { type: 'object', properties: {}, required: [] } },
  { type: 'function', name: 'session_status', description: "One session: what it is doing now and its last reported result.", parameters: { type: 'object', properties: idParam, required: ['id'] } },
  { type: 'function', name: 'ask_session', description: "Send a question or instruction to a session's agent and wait up to 90 seconds for its answer. Returns the final text, or 'still working' with what it said so far.", parameters: { type: 'object', properties: { ...idParam, prompt: { type: 'string', description: 'What to ask or tell the agent, in full sentences' } }, required: ['id', 'prompt'] } },
  { type: 'function', name: 'create_session', description: 'Start a new work session with a title and its first instruction; with agent, the session is born from that team member (its persona, engine and permissions).', parameters: { type: 'object', properties: { title: { type: 'string', description: 'A short title' }, prompt: { type: 'string', description: 'The first instruction for the agent' }, agent: { type: 'string', description: 'Optional: the team member (slug or spoken name) the session is born from' } }, required: ['title', 'prompt'] } },
  { type: 'function', name: 'ask_agent', description: "Ask or task a team member by name: reuses its most recent idle session (or opens one) and waits up to 90 seconds for the answer. Returns the final text, or 'still working' with what it said so far.", parameters: { type: 'object', properties: { agent: { type: 'string', description: 'The team member: slug or spoken name (צ\'יף, chief, קשר, סטודיו, astra, נדל"ן…)' }, prompt: { type: 'string', description: 'What to ask or tell the agent, in full sentences' } }, required: ['agent', 'prompt'] } },
  { type: 'function', name: 'interrupt_session', description: "Stop what a session's agent is doing right now.", parameters: { type: 'object', properties: idParam, required: ['id'] } },
  { type: 'function', name: 'call_contact', description: 'Stage 4a: ask the owner to approve a phone call you place to ANOTHER person on their behalf. Files a card in the app (recipient, goal, brief, caller ID, cost); nothing dials until the owner presses Send there. to = a WhatsApp contact name or a full phone number — never guess a number; if unknown, ask.', parameters: { type: 'object', properties: { to: { type: 'string', description: 'Contact name or phone number (+9725…)' }, goal: { type: 'string', description: 'One sentence: what the call should achieve' }, brief: { type: 'string', description: 'What the caller may say and agree to, in full sentences' }, caller_id: { type: 'string', description: 'Optional: "agent" or "owner"' }, language: { type: 'string', description: 'Optional: he or en' } }, required: ['to', 'goal', 'brief'] } },
] as const;
export type ClerkToolName = (typeof CLERK_TOOLS)[number]['name'];
const TOOL_NAMES = new Set<string>(CLERK_TOOLS.map((t) => t.name));

// ---- live calls (in memory; a host restart forgets them) ----
export interface Turn { role: 'user' | 'assistant'; text: string; id?: string }
export type CallChannel = 'phone' | 'phone-out';
interface Call { id: string; sessionId: string; contextSessionId?: string | null; provider: string; model: string; lang: string; startedAt: number; lastSeen: number; turns: Turn[]; tools: number; channel?: CallChannel }
const calls = new Map<string, Call>();
export const liveCall = (callId: string): Readonly<Call> | null => calls.get(callId) || null;
export const liveCallCount = (): number => calls.size;
const newCallId = (): string => `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export function realtimeModel(): string {
  const m = cfg.voice?.realtime?.model;
  return typeof m === 'string' && MODEL_RE.test(m) ? m : DEFAULT_REALTIME_MODEL;
}
export function realtimeVoice(): string {
  const v = cfg.voice?.realtime?.voice;
  return typeof v === 'string' && VOICES.includes(v) ? v : DEFAULT_REALTIME_VOICE;
}

export function geminiModel(): string {
  const m = cfg.voice?.realtime?.geminiModel;
  return typeof m === 'string' && GEMINI_MODEL_RE.test(m) ? m : DEFAULT_GEMINI_MODEL;
}
export function geminiVoice(): string {
  const v = cfg.voice?.realtime?.geminiVoice;
  return typeof v === 'string' && GEMINI_VOICE_RE.test(v) ? v : DEFAULT_GEMINI_VOICE;
}
/** The Live-API `setup` the browser sends first (pure; tests read it): same persona and tools, PCM audio both ways, transcripts on. */
// Stage 1d: the session the owner has open when a global call starts — the clerk's default subject for "this one".
export interface ClerkContext { id: string; title?: string }
export function clerkInstructions(context: ClerkContext | null = null, team: readonly AgentLite[] | null = null, lang: string = voiceLang()): string {
  const base = CLERK_INSTRUCTIONS + langInstructions(lang) + teamInstructions(team);
  if (!context?.id) return base;
  const title = String(context.title || '').replace(/["\n\r]/g, ' ').slice(0, 120);
  return `${base} The owner has the session "${title || 'untitled'}" (id ${context.id}) open right now: when they say "this", "here" or name no session, they mean that one.`;
}

// Stage 2: the same clerk on a phone line — no screen, so even shorter answers.
export const PHONE_INSTRUCTIONS = ' The owner is calling by phone: there is no screen, so keep every answer to one short sentence and never spell out ids or URLs.';
export const phoneInstructions = (team: readonly AgentLite[] | null = null, lang: string = voiceLang()): string => CLERK_INSTRUCTIONS + langInstructions(lang) + teamInstructions(team) + PHONE_INSTRUCTIONS;

export type ToolDef = { type: 'function'; name: string; description: string; parameters: Record<string, unknown> };
export function geminiSetup({ model = geminiModel(), voice = geminiVoice(), handle = '', context = null as ClerkContext | null, instructions = '', lang = voiceLang(), tools = CLERK_TOOLS as readonly ToolDef[] } = {}): Record<string, unknown> {
  const blocking = /^gemini-3\.8-live$/.test(model); // 3.8-live defaults to NON_BLOCKING; the clerk waits for its tools
  return {
    model: `models/${model}`,
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }, languageCode: speechLang(lang) } },
    systemInstruction: { parts: [{ text: instructions || clerkInstructions(context, null, lang) }] },
    tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, ...(blocking ? { behavior: 'BLOCKING' } : {}) })) }],
    realtimeInputConfig: { automaticActivityDetection: {}, activityHandling: 'START_OF_ACTIVITY_INTERRUPTS' },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: handle ? { handle } : {},
    contextWindowCompression: { slidingWindow: {} }, // lifts the 15-minute audio-session cap
  };
}
export const geminiWsUrl = (): string => `${geminiBase().replace(/^http/, 'ws')}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained`;

/** The session config sent to OpenAI (pure; tests read it). */
export function realtimeSessionConfig({ model = realtimeModel(), voice = realtimeVoice(), lang = voiceLang(), context = null as ClerkContext | null, instructions = '', tools = CLERK_TOOLS as readonly ToolDef[] } = {}): Record<string, unknown> {
  return {
    type: 'realtime',
    model,
    instructions: instructions || clerkInstructions(context, null, lang),
    output_modalities: ['audio'],
    audio: {
      input: { transcription: { model: 'gpt-4o-transcribe', ...(lang ? { language: lang } : {}) }, turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } },
      output: { voice },
    },
    tools,
    tool_choice: 'auto',
  };
}

const sessionIdOf = (body: Record<string, unknown>): string | null => (typeof body?.sessionId === 'string' && SESSION_ID_RE.test(body.sessionId) ? body.sessionId : null);
const langOf = (body: Record<string, unknown>): string => (typeof body?.lang === 'string' && /^[a-z]{2}$/.test(body.lang) ? body.lang : '');

export type MintHost = Pick<ClerkHost, 'getSession' | 'listAgents'> & { voiceHome?(): { id: string } };
/** POST /__api/voice/realtime/session {sessionId | home:true, contextSessionId?, takeover?, lang?} → the gate's shape, or
 *  {transport, callId, sessionId, …}. Stage 1d: `home` anchors the call in the voice home session (the rail's global button);
 *  only one call is live at a time — another one answers 409 {busy} unless `takeover` ends it first. */
export async function mintRealtimeSession(body: Record<string, unknown>, opts: { fetchImpl?: typeof fetch; now?: () => number; host?: MintHost | null } = {}): Promise<Json> {
  const home = body?.home === true && !body?.sessionId;
  if (home && !opts.host?.voiceHome) return bad('no voice home session on this host', 500);
  const sessionId = home ? null : sessionIdOf(body);
  if (!home && !sessionId) return bad('sessionId required');
  const gate = requireVoiceProvider('realtime', 'hold a live voice conversation');
  if (!('ok' in gate) || !gate.ok) return json(200, gate);
  const provider = gate.provider;
  const token = providerSecretFields(provider)?.token;
  if (!token) return bad(`no key stored for ${provider}`, 502);
  sweep(opts.now);
  if (calls.size && body?.takeover !== true) return json(409, { error: 'another voice call is live', busy: true });
  const anchor = home ? opts.host!.voiceHome!().id : sessionId!;
  const ctxId = typeof body?.contextSessionId === 'string' && SESSION_ID_RE.test(body.contextSessionId) && body.contextSessionId !== anchor ? body.contextSessionId : null;
  const ctxSession = ctxId ? opts.host?.getSession(ctxId) : null;
  const context = ctxSession && !ctxSession.archived ? { id: ctxSession.id, title: ctxSession.title } : null;
  const lang = langOf(body);
  const f = opts.fetchImpl || fetch;
  const t0 = Date.now();
  try {
    const team = opts.host?.listAgents?.() || null;
    const spoken = lang || voiceLang();
    const minted = provider === 'voice:gemini' ? await mintGemini(token, f, opts.now, context, team, spoken) : await mintOpenAI(token, f, spoken, context, team);
    if ('error' in minted) {
      console.error(`[voice-realtime] ${provider} answered ${minted.status} after ${Date.now() - t0}ms`);
      return bad(scrubProviderSecrets(minted.error, provider), 502);
    }
    const now = (opts.now || Date.now)();
    // takeover: the call that was live ends only once this one is minted (a failed mint leaves it alone)
    for (const c of [...calls.values()]) finish(c, Math.min(MAX_CALL_S, Math.round((now - c.startedAt) / 1000)), 'takeover', sweepHost);
    const call: Call = { id: newCallId(), sessionId: anchor, contextSessionId: context?.id || null, provider, model: String(minted.body.model), lang, startedAt: now, lastSeen: now, turns: [], tools: 0 };
    calls.set(call.id, call);
    console.log(`[voice-realtime] call ${call.id} for ${anchor}${context ? ` (context ${context.id})` : ''} (${call.model}) minted in ${Date.now() - t0}ms`);
    return json(200, { ok: true, callId: call.id, provider, sessionId: anchor, contextSessionId: context?.id || null, ...minted.body });
  } catch (e) {
    const msg = scrubProviderSecrets((e as Error)?.message || String(e), provider);
    console.error(`[voice-realtime] mint failed: ${msg}`);
    return bad(msg, 502);
  }
}
type Minted = { body: Record<string, unknown> } | { error: string; status: number };
const readJson = async (res: Response): Promise<{ detail: string; j: Record<string, unknown> | null }> => {
  let detail = '';
  let j: Record<string, unknown> | null = null;
  try { detail = (await res.text()).slice(0, 400); j = JSON.parse(detail); } catch { /* not JSON */ }
  return { detail, j };
};

// OpenAI: an ephemeral client secret for the WebRTC handshake, the session config attached to it.
async function mintOpenAI(token: string, f: typeof fetch, lang: string, context: ClerkContext | null = null, team: readonly AgentLite[] | null = null): Promise<Minted> {
  const model = realtimeModel();
  const voice = realtimeVoice();
  const res = await f(`${openaiBase()}/v1/realtime/client_secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: SECRET_TTL_S }, session: realtimeSessionConfig({ model, voice, lang, instructions: clerkInstructions(context, team, lang) }) }),
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });
  const { detail, j } = await readJson(res);
  const value = j && typeof j.value === 'string' ? j.value : '';
  if (!res.ok || !value) return { status: res.status, error: `OpenAI answered ${res.status}${res.ok ? ' without a client secret' : detail ? `: ${detail}` : ''}` };
  return { body: { transport: 'openai-webrtc', clientSecret: value, expiresAt: typeof j?.expires_at === 'number' ? j.expires_at : null, model, voice, callsUrl: `${openaiBase()}/v1/realtime/calls` } };
}

// Gemini: an ephemeral auth token for the Live WebSocket; the browser sends the host-built `setup` itself.
async function mintGemini(token: string, f: typeof fetch, now: () => number = Date.now, context: ClerkContext | null = null, team: readonly AgentLite[] | null = null, lang: string = voiceLang()): Promise<Minted> {
  const model = geminiModel();
  const voice = geminiVoice();
  const t = now();
  const res = await f(`${geminiBase()}/v1beta/auth_tokens`, {
    method: 'POST',
    headers: { 'x-goog-api-key': token, 'content-type': 'application/json' },
    body: JSON.stringify({ uses: 1, expireTime: new Date(t + MAX_CALL_S * 1000).toISOString(), newSessionExpireTime: new Date(t + GEMINI_NEW_SESSION_S * 1000).toISOString() }),
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });
  const { detail, j } = await readJson(res);
  const name = j && typeof j.name === 'string' ? j.name : '';
  if (!res.ok || !name) return { status: res.status, error: `Gemini answered ${res.status}${res.ok ? ' without a token' : detail ? `: ${detail}` : ''}` };
  return { body: { transport: 'gemini-ws', token: name, expiresAt: Math.floor(t / 1000) + MAX_CALL_S, model, voice, wsUrl: geminiWsUrl(), setup: geminiSetup({ model, voice, lang, instructions: clerkInstructions(context, team, lang) }) } };
}

/** Stage 2: a call the host opens itself (the phone bridge) — same map, tools, transcript and ledger as a browser call; no mint. */
export function openHostCall(o: { sessionId: string; provider: string; model: string; lang?: string; channel?: CallChannel; now?: () => number }): { callId: string } | { busy: true } {
  sweep(o.now);
  if (calls.size) return { busy: true };
  const now = (o.now || Date.now)();
  const call: Call = { id: newCallId(), sessionId: o.sessionId, contextSessionId: null, provider: o.provider, model: o.model, lang: o.lang || '', startedAt: now, lastSeen: now, turns: [], tools: 0, ...(o.channel ? { channel: o.channel } : {}) };
  calls.set(call.id, call);
  console.log(`[voice-realtime] ${o.channel || 'host'} call ${call.id} for ${o.sessionId} (${call.model})`);
  return { callId: call.id };
}
/** Keeps a host-driven call out of the idle sweep while audio still flows. */
export function touchCall(callId: string, now: () => number = Date.now): void {
  const c = calls.get(callId);
  if (c) c.lastSeen = now();
}

// A call the browser names must exist, belong to the session, and be alive.
function callOf(body: Record<string, unknown>): Call | Json {
  const sessionId = sessionIdOf(body);
  if (!sessionId) return bad('sessionId required');
  const callId = typeof body?.callId === 'string' && CALL_ID_RE.test(body.callId) ? body.callId : '';
  const c = callId ? calls.get(callId) : null;
  if (!c || c.sessionId !== sessionId) return bad('unknown call for this session', 403);
  return c;
}
const isJson = (x: unknown): x is Json => !!x && typeof x === 'object' && (x as Json).kind === 'json';

/** POST /__api/voice/realtime/transcript {sessionId, callId, turns:[{role, text, id?}]} → the call's turn count. */
export function addRealtimeTranscript(body: Record<string, unknown>, opts: { now?: () => number } = {}): Json {
  const c = callOf(body);
  if (isJson(c)) return c;
  const turns = Array.isArray(body.turns) ? body.turns : [];
  for (const t of turns) {
    if (!t || typeof t !== 'object') continue;
    const role = (t as Turn).role === 'user' ? 'user' : (t as Turn).role === 'assistant' ? 'assistant' : null;
    const text = String((t as Turn).text ?? '').trim().slice(0, TURN_MAX_CHARS);
    const id = typeof (t as Turn).id === 'string' ? (t as Turn).id!.slice(0, 64) : undefined;
    if (!role || !text) continue;
    const dup = id ? c.turns.find((x) => x.id === id) : null;
    if (dup) dup.text = text;
    else if (c.turns.length < TURNS_MAX) c.turns.push({ role, text, ...(id ? { id } : {}) });
  }
  c.lastSeen = (opts.now || Date.now)();
  return json(200, { ok: true, turns: c.turns.length });
}

export interface ClerkHost {
  listSessions(): SessionLite[];
  getSession(id: string): SessionLite | null;
  sendMessage(id: string, text: string): void;
  interrupt(id: string): boolean;
  createSession(o: { title: string; prompt: string; agent?: string | null }): { id: string; title: string };
  listAgents?(): AgentLite[];
  chatSeq(id: string): number;
  getChat(id: string, since: number): ChatEvent[];
  appendChat(id: string, ev: Record<string, unknown>): void;
  folderName?(folderId: string): string | null;
  fileCall?(sessionId: string, args: Record<string, unknown>): Promise<Record<string, unknown>>; // stage 4a: call_contact → an outbound card
}
export interface SessionLite {
  id: string;
  title?: string;
  status?: string;
  cwd?: string;
  archived?: boolean;
  folderId?: string | null;
  engine?: string;
  claude?: { state?: string } | null;
  metadata?: { result?: { state?: string; summary?: unknown } | null; agent?: string | null; agentHome?: boolean } | null;
  progress?: unknown;
  updatedAt?: string;
}
export interface ChatEvent { kind?: string; text?: string; partial?: boolean; seq?: number; isError?: boolean }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clip = (s: string, n: number): string => (s.length > n ? `…${s.slice(s.length - n)}` : s);
const head = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const working = (s: SessionLite): boolean => s.claude?.state === 'working';
const liveSession = (host: ClerkHost, id: unknown): SessionLite => {
  const s = typeof id === 'string' && SESSION_ID_RE.test(id) ? host.getSession(id) : null;
  if (!s || s.archived) throw new Error('unknown session');
  return s;
};
const agentOf = (s: SessionLite): string | null => (typeof s.metadata?.agent === 'string' && s.metadata.agent ? s.metadata.agent : null);
const thin = (host: ClerkHost, s: SessionLite) => ({
  id: s.id,
  title: s.title || '',
  status: s.status || '',
  folder: (s.folderId && host.folderName?.(s.folderId)) || null,
  working: working(s),
  ...(agentOf(s) ? { agent: agentOf(s) } : {}),
});

// ---- the team by voice: spoken-name → agent ----
// Hebrew/English forms Maor says for his agents (ASR-friendly); only applied to slugs that exist in the registry.
export const SPOKEN_NAMES: Record<string, string[]> = {
  chief: ["צ'יף", 'ציף', "צ'יף אוף סטאף", 'chief', 'chief of staff', 'הצ\'יף'],
  kesher: ['קשר', 'kesher', 'keshr'],
  studio: ['סטודיו', 'studio', 'סטודיאו'],
  astra: ['אסטרה', 'אסטרא', 'astra'],
  nadlan: ['נדל"ן', 'נדלן', 'נדל״ן', 'nadlan', 'nadlann'],
  'social-manager': ['social manager', 'social', 'סושיאל', 'סושיאל מנג\'ר', 'סושל'],
};
const FINALS: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
/** "צ׳יף" / "נדל"ן" / "Social-Manager" → a comparable key: lowercase, no punctuation or spaces, no Hebrew final letters. */
export const nameKey = (v: unknown): string =>
  String(v ?? '').toLowerCase().replace(/[\u05D0-\u05EA]/g, (ch) => FINALS[ch] || ch).replace(/[^\p{L}\p{N}]+/gu, '');
export type AgentMatch = { agent: AgentLite } | { error: string };
const teamList = (team: readonly AgentLite[]): string => team.map((a) => `${a.name} (${a.slug})`).join(', ');
/** Resolve a slug or a spoken name against the registry; exact first, then a unique prefix; errors are spoken-friendly. */
export function resolveAgent(team: readonly AgentLite[], query: unknown): AgentMatch {
  const q = nameKey(query);
  if (!team.length) return { error: 'the owner has no team agents yet' };
  if (!q) return { error: `which agent? the team is: ${teamList(team)}` };
  const keysOf = (a: AgentLite): string[] => [a.slug, a.name, ...(SPOKEN_NAMES[a.slug] || [])].map(nameKey).filter(Boolean);
  const exact = team.filter((a) => keysOf(a).includes(q));
  if (exact.length === 1) return { agent: exact[0] };
  const near = exact.length ? exact : team.filter((a) => keysOf(a).some((k) => q.length >= 3 && k.startsWith(q)));
  if (near.length === 1) return { agent: near[0] };
  if (near.length > 1) return { error: `did you mean ${near.map((a) => a.name).join(' or ')}?` };
  return { error: `no agent called "${str(query, 40) || '?'}" — the team is: ${teamList(team)}` };
}
const teamOf = (host: ClerkHost): AgentLite[] => host.listAgents?.() || [];
const agentArg = (host: ClerkHost, v: unknown): AgentLite => {
  const m = resolveAgent(teamOf(host), v);
  if ('error' in m) throw new Error(m.error);
  return m.agent;
};
/** The agent's most recent idle session in the call's folder, else its home, else a root-level one; other folders are never hijacked. */
export function idleAgentSession(host: ClerkHost, slug: string, folderId: string | null = null): SessionLite | null {
  const rank = (s: SessionLite): number => (folderId && s.folderId === folderId ? 0 : s.metadata?.agentHome ? 1 : !s.folderId ? 2 : 3);
  const mine = host.listSessions().filter((s) => !s.archived && agentOf(s) === slug && s.claude?.state === 'idle' && rank(s) < 3);
  mine.sort((a, b) => rank(a) - rank(b) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return mine[0] || null;
}

/** ask_session: deliver through the normal message path, then wait (bounded) for the turn's final text. */
export async function askSession(host: ClerkHost, id: string, prompt: string, timeoutMs = ASK_TIMEOUT_MS, pollMs = 250): Promise<Record<string, unknown>> {
  const s = liveSession(host, id);
  const since = host.chatSeq(s.id);
  host.sendMessage(s.id, prompt);
  return awaitAnswer(host, s.id, since, timeoutMs, pollMs);
}
// The bounded wait for a turn's final text after chat seq `since` (the first prompt of a new session was sent by createSession).
async function awaitAnswer(host: ClerkHost, id: string, since: number, timeoutMs: number, pollMs = 250): Promise<Record<string, unknown>> {
  const s = liveSession(host, id);
  const t0 = Date.now();
  let text = '';
  while (Date.now() - t0 < timeoutMs) {
    await sleep(pollMs);
    for (const e of host.getChat(s.id, since)) {
      if (e.kind === 'assistant-text' && !e.partial && typeof e.text === 'string' && e.text.trim()) text = e.text.trim();
      if (e.kind === 'error' || (e.kind === 'result' && e.isError)) return { done: true, error: true, answer: clip(text || String(e.text || 'the turn failed'), ANSWER_MAX_CHARS) };
      if (e.kind === 'result') return { done: true, answer: clip(text, ANSWER_MAX_CHARS) || '(the agent finished without a text answer)' };
    }
  }
  return { done: false, status: 'still working', partial: clip(text, ANSWER_MAX_CHARS) };
}

/** Run one clerk tool with the host's authority; throws on a bad name/args. */
export async function runClerkTool(host: ClerkHost, name: string, args: Record<string, unknown>, opts: { askTimeoutMs?: number; pollMs?: number; folderId?: string | null; sessionId?: string } = {}): Promise<Record<string, unknown>> {
  if (!TOOL_NAMES.has(name)) throw new Error(`unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be an object');
  const askTimeout = Math.min(ASK_MAX_TIMEOUT_MS, opts.askTimeoutMs || ASK_TIMEOUT_MS);
  switch (name as ClerkToolName) {
    case 'list_sessions': {
      const only = str(args.agent, 80) ? agentArg(host, args.agent).slug : null;
      const sessions = host.listSessions().filter((s) => !s.archived && (!only || agentOf(s) === only)).map((s) => thin(host, s));
      return only ? { agent: only, sessions } : { sessions };
    }
    case 'list_agents':
      return { agents: teamOf(host).map((a) => ({ slug: a.slug, name: a.name, ...(a.description ? { description: head(a.description, 160) } : {}) })) };
    case 'ask_agent': {
      const prompt = str(args.prompt, PROMPT_MAX_CHARS);
      if (!prompt) throw new Error('prompt required');
      const a = agentArg(host, args.agent);
      const idle = idleAgentSession(host, a.slug, opts.folderId || null);
      const s = idle || host.createSession({ title: `${a.name}: ${head(prompt.replace(/\s+/g, ' '), 48)}`, prompt, agent: a.slug });
      const r = idle ? await askSession(host, s.id, prompt, askTimeout, opts.pollMs) : await awaitAnswer(host, s.id, host.chatSeq(s.id), askTimeout, opts.pollMs);
      return { agent: a.slug, session: s.id, title: s.title || '', created: !idle, ...r };
    }
    case 'session_status': {
      const s = liveSession(host, args.id);
      const r = s.metadata?.result;
      return { ...thin(host, s), engine: s.engine || null, state: s.claude?.state || 'unknown', result: r && typeof r.summary === 'string' ? { state: r.state || null, summary: head(r.summary, 600) } : null };
    }
    case 'ask_session': {
      const prompt = str(args.prompt, PROMPT_MAX_CHARS);
      if (!prompt) throw new Error('prompt required');
      return askSession(host, String(args.id), prompt, askTimeout, opts.pollMs);
    }
    case 'create_session': {
      const title = str(args.title, 120);
      const prompt = str(args.prompt, PROMPT_MAX_CHARS);
      if (!title || !prompt) throw new Error('title and prompt required');
      const a = str(args.agent, 80) ? agentArg(host, args.agent) : null;
      const s = host.createSession({ title, prompt, ...(a ? { agent: a.slug } : {}) });
      return { id: s.id, title: s.title, created: true, ...(a ? { agent: a.slug } : {}) };
    }
    case 'interrupt_session': {
      const s = liveSession(host, args.id);
      return { id: s.id, interrupted: host.interrupt(s.id) };
    }
    case 'call_contact': {
      if (!host.fileCall || !opts.sessionId) throw new Error('phone calls to others are not available on this host');
      return host.fileCall(opts.sessionId, args);
    }
  }
}

// One compact line of what came back, for the audit card.
function summarize(name: string, r: Record<string, unknown>): string {
  switch (name) {
    case 'list_sessions': return (r.sessions as ReturnType<typeof thin>[]).map((s) => `${s.title}${s.working ? ' (working)' : ''}`).join(', ') || '(none)';
    case 'list_agents': return (r.agents as AgentLite[]).map((a) => `${a.name} (${a.slug})`).join(', ') || '(no team)';
    case 'ask_agent': return `${r.agent}${r.created ? ` (new session "${r.title}")` : ` ("${r.title}")`}: ${r.done ? head(String(r.answer), 400) : `still working${r.partial ? ` — ${head(String(r.partial), 200)}` : ''}`}`;
    case 'session_status': return `${r.title}: ${r.state}${(r.result as { summary?: string } | null)?.summary ? ` — ${head((r.result as { summary: string }).summary, 200)}` : ''}`;
    case 'ask_session': return r.done ? head(String(r.answer), 400) : `still working${r.partial ? ` — ${head(String(r.partial), 200)}` : ''}`;
    case 'create_session': return `created "${r.title}"${r.agent ? ` as ${r.agent}` : ''}`;
    case 'interrupt_session': return r.interrupted ? 'interrupted' : 'nothing to interrupt';
    case 'call_contact': return r.pending ? 'card filed — waiting for the owner\'s Send' : `not filed: ${String(r.error || r.why || 'refused')}`;
    default: return head(JSON.stringify(r), 300);
  }
}
const asked = (name: string, args: Record<string, unknown>): string => {
  const a = { ...args };
  for (const k of ['prompt', 'title', 'brief']) if (typeof a[k] === 'string') a[k] = head(a[k] as string, 200);
  return Object.keys(a).length ? `${name} ${JSON.stringify(a)}` : name;
};

/** POST /__api/voice/realtime/tool {sessionId, callId, name, args} → {ok, result} | {ok:false, error}; an audit card lands in the chat. */
export async function handleClerkTool(body: Record<string, unknown>, host: ClerkHost, opts: { askTimeoutMs?: number; pollMs?: number; now?: () => number } = {}): Promise<Json> {
  const c = callOf(body);
  if (isJson(c)) return c;
  const name = typeof body.name === 'string' ? body.name : '';
  if (!TOOL_NAMES.has(name)) return bad(`unknown tool: ${name || '(none)'}`);
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
  c.lastSeen = (opts.now || Date.now)();
  c.tools += 1;
  const t0 = Date.now();
  let out: Json;
  let got: string;
  let agent: string | null = null;
  const folderId = (c.contextSessionId && host.getSession(c.contextSessionId)?.folderId) || null;
  try {
    const result = await runClerkTool(host, name, args, { ...opts, folderId, sessionId: c.sessionId });
    got = summarize(name, result);
    agent = typeof result.agent === 'string' ? result.agent : null;
    out = json(200, { ok: true, result });
  } catch (e) {
    got = `error: ${(e as Error).message}`;
    out = json(200, { ok: false, error: (e as Error).message });
  }
  try {
    host.appendChat(c.sessionId, { kind: 'ext-card', extension: 'voice', title: `📞 ${name}${agent ? ` · ${agent}` : ''}`, body: `${asked(name, args)}\n\n→ ${got}`, voice: { callId: c.id, tool: name, ms: Date.now() - t0, ...(agent ? { agent } : {}) } });
  } catch (e) {
    console.error('[voice-realtime] audit card failed:', (e as Error).message);
  }
  return out;
}

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
function transcriptCard(c: Call, seconds: number, reason: string): Record<string, unknown> {
  const he = c.lang === 'he';
  const who = (r: Turn['role']): string => (r === 'user' ? (he ? 'אתה' : 'You') : he ? 'הפקיד' : 'Clerk');
  const body = c.turns.map((t) => `**${who(t.role)}:** ${t.text}`).join('\n\n') || (he ? '_(לא נאמר דבר)_' : '_(nothing was said)_');
  const what = c.channel === 'phone' ? (he ? 'שיחת טלפון' : 'Phone call') : he ? 'שיחה קולית' : 'Voice call';
  return { kind: 'ext-card', extension: 'voice', title: `📞 ${what} · ${mmss(seconds)}`, body, voice: { callId: c.id, seconds, tools: c.tools, turns: c.turns.length, reason, model: c.model, ...(c.channel ? { channel: c.channel } : {}) } };
}

function finish(c: Call, seconds: number, reason: string, host: Pick<ClerkHost, 'appendChat'> | null): Record<string, unknown> {
  calls.delete(c.id);
  const usage = recordVoiceUsage(c.provider, { seconds });
  // stage 4a: an outbound call's card is the outcome card (voice-outbound.ts), so the turns go back to the caller
  if (c.channel === 'phone-out') return { ok: true, seconds, turns: c.turns.length, tools: c.tools, usd: usage.usd, transcript: c.turns.map((t) => ({ role: t.role, text: t.text })) };
  try { host?.appendChat(c.sessionId, transcriptCard(c, seconds, reason)); } catch (e) { console.error('[voice-realtime] transcript card failed:', (e as Error).message); }
  console.log(`[voice-realtime] call ${c.id} ended (${reason}) after ${mmss(seconds)}, ${c.tools} tools, ${c.turns.length} turns`);
  return { ok: true, seconds, turns: c.turns.length, tools: c.tools, usd: usage.usd };
}

/** POST /__api/voice/realtime/end {sessionId, callId, seconds?, reason?} → the ledger gets the clamped duration, the chat the transcript. */
export function endRealtimeCall(body: Record<string, unknown>, host: Pick<ClerkHost, 'appendChat'> | null, opts: { now?: () => number } = {}): Json {
  const c = callOf(body);
  if (isJson(c)) return c;
  const now = (opts.now || Date.now)();
  const window = Math.min(MAX_CALL_S, (now - c.startedAt) / 1000 + 5); // the browser's number is trusted only inside the call's own window
  const reported = Number(body.seconds);
  const seconds = Math.round(Math.max(0, Math.min(window, Number.isFinite(reported) ? reported : window)));
  return json(200, finish(c, seconds, typeof body.reason === 'string' ? body.reason.slice(0, 40) : 'hangup', host));
}

let sweepHost: Pick<ClerkHost, 'appendChat'> | null = null;
export const setSweepHost = (h: Pick<ClerkHost, 'appendChat'> | null): void => { sweepHost = h; };
/** A call whose browser went quiet for CALL_IDLE_MS is closed with the time we saw it live. */
export function sweep(now: () => number = Date.now): string[] {
  const t = now();
  const gone: string[] = [];
  for (const c of [...calls.values()]) {
    if (t - c.lastSeen < CALL_IDLE_MS) continue;
    finish(c, Math.min(MAX_CALL_S, Math.round((c.lastSeen - c.startedAt) / 1000)), 'lost', sweepHost);
    gone.push(c.id);
  }
  return gone;
}
