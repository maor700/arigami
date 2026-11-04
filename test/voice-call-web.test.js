// Stage 1c web (docs/VOICE.md): the call button exists only with a realtime provider (and never under the
// kill-switch), the WebRTC client runs the offer/answer flow against a fake RTCPeerConnection, a tool call over the
// data channel round-trips through the host, transcripts are posted, hang-up reports the duration, and a failed
// connection falls back to hands-free with one line. No real mic, speaker or network.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, call, handsfree, speak, voice, store, VoiceHUD, CallButton;
const h = (...a) => React.createElement(...a);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let configBody = {};
const posts = [];
let mintBody = null;
let toolBody = null;
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

class FakePC {
  static instances = [];
  constructor() { FakePC.instances.push(this); this.connectionState = 'new'; this.tracks = []; this.closed = false; this.local = null; this.remote = null; this.dc = null; }
  addTrack(tr) { this.tracks.push(tr); }
  createDataChannel(name) {
    this.dc = { name, readyState: 'connecting', sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() { this.readyState = 'closed'; } };
    return this.dc;
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async setLocalDescription(o) { this.local = o; }
  async setRemoteDescription(a) { this.remote = a; this.dc.readyState = 'open'; this.dc.onopen?.(); this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
  close() { this.closed = true; this.connectionState = 'closed'; }
}
const sdpPosts = [];
let sdpStatus = 200;
const fakeTrack = () => ({ enabled: true, stopped: false, stop() { this.stopped = true; } });
let lastStream = null;
class FakeWS {
  static instances = [];
  constructor(url) { FakeWS.instances.push(this); this.url = url; this.readyState = 0; this.sent = []; this.closed = false; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
  send(m) { this.sent.push(JSON.parse(m)); if (this.sent.length === 1 && FakeWS.completeSetup) setTimeout(() => this.receive({ setupComplete: {} }), 0); }
  receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  close() { this.closed = true; this.readyState = 3; }
  drop(code = 1011) { this.readyState = 3; this.onclose?.({ code }); }
}
FakeWS.completeSetup = true;
class FakeCtx {
  constructor() { this.sampleRate = 48000; this.closedCtx = false; }
  async resume() {}
  async close() { this.closedCtx = true; }
}
let lastMic = null;
let lastPlayer = null;
const fakeMic = async ({ onChunk }) => { lastMic = { muted: false, stopped: false, onChunk, mute(v) { this.muted = v; }, stop() { this.stopped = true; } }; return lastMic; };
const fakePlayer = () => { lastPlayer = { played: [], stops: 0, playing: false, play(d) { this.played.push(d); this.playing = true; }, stop() { this.stops++; this.playing = false; } }; return lastPlayer; };
const callDeps = () => ({
  WebSocket: FakeWS,
  AudioContext: FakeCtx,
  openMicPcm: fakeMic,
  pcmPlayer: fakePlayer,
  RTCPeerConnection: FakePC,
  getUserMedia: async () => { lastStream = { tracks: [fakeTrack()], getTracks() { return this.tracks; } }; return lastStream; },
  fetchImpl: async (url, init) => { sdpPosts.push({ url, headers: init.headers, body: init.body }); return new Response('v=0 answer', { status: sdpStatus }); },
  audio: () => ({ srcObject: null, play: async () => {}, pause() {} }),
});

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, getElementById: () => null, addEventListener() {}, removeEventListener() {}, activeElement: null,
  };
  globalThis.navigator = {
    language: 'en-US', userAgent: 'test', platform: 'Linux',
    mediaDevices: { enumerateDevices: async () => [], getUserMedia: async () => ({ getTracks: () => [] }) },
  };
  globalThis.MediaRecorder = class { constructor() { this.state = 'recording'; } static isTypeSupported() { return true; } start() {} stop() { this.state = 'inactive'; this.onstop?.(); } };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  globalThis.dispatchEvent = () => true;
  globalThis.addEventListener = () => {};
  const err = console.error;
  console.error = (...a) => { if (!/useLayoutEffect/.test(String(a[0]))) err(...a); };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (init?.method === 'POST') posts.push({ url: u, body });
    if (u.endsWith('/__api/config')) return jsonResponse(configBody);
    if (u.endsWith('/voice/realtime/session')) return jsonResponse(typeof mintBody === 'function' ? mintBody(body) : mintBody);
    if (u.endsWith('/voice/realtime/tool')) return jsonResponse(typeof toolBody === 'function' ? toolBody(body) : toolBody);
    return jsonResponse({ ok: true });
  };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  speak = await import(web('lib/speak.js'));
  voice = await import(web('lib/voice.js'));
  handsfree = await import(web('lib/handsfree.js'));
  call = await import(web('lib/call.js'));
  store = await import(web('lib/store.js'));
  ({ default: VoiceHUD } = await import(web('components/VoiceHUD.jsx')));
  ({ CallButton } = await import(web('components/VoiceOutButtons.jsx')));
  speak.installReadAloud();
  prefs.setPrefs({ language: 'en' });
  call.setCallDeps(callDeps());
});
afterAll(async () => { await call.hangUp('test'); handsfree.stopHandsFree('test'); speak.stopSpeaking(); voice.cancel(); call.setCallDeps(null); prefs.setPrefs({ language: 'en', voiceReadAloud: false, voiceBrowserTts: false }); });

const withProviders = async (realtime, extra = {}) => {
  configBody = { voiceEnabled: true, voiceProviders: { enabled: true, stt: ['groq'], tts: [], realtime, telephony: false }, ...extra };
  await store.loadConfig();
};

test('gating: no realtime provider → no call button and the HUD is untouched; a provider → the button; the kill-switch hides it', async () => {
  await withProviders([]);
  expect(render(h(CallButton, { sessionId: 's1' }))).toBe('');
  expect(render(h(VoiceHUD, {}))).toBe('');
  expect(call.callAvailable(store.getState().config)).toBe(false);
  await withProviders(['voice:openai']);
  const btn = render(h(CallButton, { sessionId: 's1' }));
  expect(btn).toContain('data-voice-call="off"');
  expect(btn).toContain('Call the voice clerk');
  expect(render(h(VoiceHUD, {}))).toBe(''); // a button is all that changes until it is pressed
  prefs.setPrefs({ language: 'he' });
  expect(render(h(CallButton, { sessionId: 's1' }))).toContain('שיחה עם הפקיד הקולי');
  prefs.setPrefs({ language: 'en' });
  configBody = { ...configBody, voiceProviders: { ...configBody.voiceProviders, enabled: false } };
  await store.loadConfig();
  expect(render(h(CallButton, { sessionId: 's1' }))).toBe('');
  expect(call.callAvailable(null)).toBe(false);
});

test('call: mint → offer → SDP answer with the ephemeral secret → listening; phases follow the events; a tool call round-trips through the host; transcripts are posted; mute; hang-up posts the duration', async () => {
  await withProviders(['voice:openai']);
  prefs.setPrefs({ voiceLang: 'he' });
  mintBody = { ok: true, transport: 'openai-webrtc', provider: 'voice:openai', callId: 'call_abc12345', clientSecret: 'ek_secret_1', expiresAt: 1900000000, model: 'gpt-realtime-2.1', voice: 'marin', callsUrl: 'https://api.openai.com/v1/realtime/calls' };
  toolBody = (b) => (b.name === 'list_sessions' ? { ok: true, result: { sessions: [{ id: 'sess_1', title: 'Fix login', working: true }] } } : { ok: false, error: 'unknown session' });
  posts.length = 0;
  sdpPosts.length = 0;
  const ok = await call.startCall('s1');
  expect(ok).toBe(true);
  expect(posts[0]).toEqual({ url: '/__api/voice/realtime/session', body: { sessionId: 's1', lang: 'he' } });
  const pc = FakePC.instances.at(-1);
  expect(pc.local.sdp).toBe('v=0 offer');
  expect(pc.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' });
  expect(pc.tracks.length).toBe(1);
  expect(pc.dc.name).toBe('oai-events');
  expect(sdpPosts).toEqual([{ url: 'https://api.openai.com/v1/realtime/calls', headers: { Authorization: 'Bearer ek_secret_1', 'Content-Type': 'application/sdp' }, body: 'v=0 offer' }]);
  let st = call.getCall();
  expect([st.active, st.phase, st.sessionId, st.callId]).toEqual([true, 'listening', 's1', 'call_abc12345']);
  let hud = render(h(VoiceHUD, {}));
  expect(hud).toContain('data-voice-call="listening"');
  expect(hud).toContain('On the line');
  expect(hud).toContain('data-voice-call-hangup');
  expect(render(h(CallButton, { sessionId: 's1' }))).toContain('data-voice-call="on"');
  expect(render(h(CallButton, { sessionId: 's2' }))).toContain('data-voice-call="off"');

  call.onEvent({ type: 'output_audio_buffer.started' });
  expect(call.getCall().phase).toBe('speaking');
  expect(render(h(VoiceHUD, {}))).toContain('Speaking…');
  call.onEvent({ type: 'input_audio_buffer.speech_started' }); // the person talks over it: the model's VAD already cut the audio
  expect(call.getCall().phase).toBe('listening');

  call.onEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: ' מה המצב עם הלוגין? ' });
  call.onEvent({ type: 'response.output_audio_transcript.done', item_id: 'o1', transcript: 'רגע, בודק.' });
  expect(render(h(VoiceHUD, {}))).toContain('“רגע, בודק.”');
  await tick(500);
  const tr = posts.find((p) => p.url.endsWith('/voice/realtime/transcript'));
  expect(tr.body).toEqual({ sessionId: 's1', callId: 'call_abc12345', turns: [{ role: 'user', text: 'מה המצב עם הלוגין?', id: 'i1' }, { role: 'assistant', text: 'רגע, בודק.', id: 'o1' }] });

  call.onEvent({ type: 'response.function_call_arguments.done', call_id: 'fc_1', name: 'list_sessions', arguments: '{}' });
  expect(call.getCall().phase).toBe('tool');
  expect(render(h(VoiceHUD, {}))).toContain('One moment, checking… (list_sessions)');
  await tick(20);
  const toolPost = posts.find((p) => p.url.endsWith('/voice/realtime/tool'));
  expect(toolPost.body).toEqual({ sessionId: 's1', callId: 'call_abc12345', name: 'list_sessions', args: {} });
  expect(pc.dc.sent).toEqual([
    { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'fc_1', output: JSON.stringify({ sessions: [{ id: 'sess_1', title: 'Fix login', working: true }] }) } },
    { type: 'response.create' },
  ]);
  expect(call.getCall().phase).toBe('listening');
  call.onEvent({ type: 'response.function_call_arguments.done', call_id: 'fc_2', name: 'session_status', arguments: '{"id":"sess_x"}' });
  await tick(20);
  expect(pc.dc.sent[2].item.output).toBe(JSON.stringify({ error: 'unknown session' }));

  expect(call.toggleMute()).toBe(true);
  expect(lastStream.tracks[0].enabled).toBe(false);
  expect(render(h(VoiceHUD, {}))).toContain('data-voice-call-mute="on"');
  expect(call.toggleMute()).toBe(false);
  expect(lastStream.tracks[0].enabled).toBe(true);

  call.onEvent({ type: 'response.output_audio_transcript.done', item_id: 'o2', transcript: 'Fix login is still working.' });
  await call.hangUp('hangup');
  expect(pc.closed).toBe(true);
  expect(lastStream.tracks[0].stopped).toBe(true);
  expect(call.getCall().active).toBe(false);
  expect(render(h(VoiceHUD, {}))).toBe('');
  const end = posts.at(-1);
  expect(end.url).toBe('/__api/voice/realtime/end');
  expect(end.body.sessionId).toBe('s1');
  expect(end.body.callId).toBe('call_abc12345');
  expect(end.body.reason).toBe('hangup');
  expect(typeof end.body.seconds).toBe('number');
  expect(end.body.seconds).toBeLessThan(5);
  expect(posts.at(-2).url).toBe('/__api/voice/realtime/transcript'); // the tail is flushed before the end
  expect(posts.at(-2).body.turns).toEqual([{ role: 'assistant', text: 'Fix login is still working.', id: 'o2' }]);
  expect(call.lastCallEnd().reason).toBe('hangup');
  expect(JSON.stringify(posts)).not.toContain('ek_secret_1'); // the secret only ever goes to the vendor
  prefs.setPrefs({ voiceLang: 'auto' });
});

test('Gemini Live: setup first, mic PCM up after setupComplete, audio parts play + speaking, interrupted stops playback, transcript pieces grow one turn, a tool call round-trips as toolResponse, goAway/drop resumes with the handle, hang-up closes everything', async () => {
  await withProviders(['voice:gemini']);
  const setup = { model: 'models/gemini-3.8-live', tools: [{ functionDeclarations: [{ name: 'list_sessions' }] }], sessionResumption: {} };
  mintBody = { ok: true, transport: 'gemini-ws', provider: 'voice:gemini', callId: 'call_gem12345', token: 'auth_tokens/tok1', wsUrl: 'wss://generativelanguage.googleapis.com/ws/x.BidiGenerateContentConstrained', setup };
  toolBody = { ok: true, result: { sessions: [] } };
  posts.length = 0;
  FakeWS.instances.length = 0;
  expect(await call.startCall('s1')).toBe(true);
  const ws = FakeWS.instances[0];
  expect(ws.url).toBe('wss://generativelanguage.googleapis.com/ws/x.BidiGenerateContentConstrained?access_token=auth_tokens%2Ftok1');
  expect(ws.sent[0]).toEqual({ setup });
  expect(call.getCall().phase).toBe('listening');
  expect(call.getCall().provider).toBe('voice:gemini');
  expect(lastMic).toBeTruthy();
  lastMic.onChunk('AAAA');
  expect(ws.sent[1]).toEqual({ realtimeInput: { audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' } } });
  ws.receive({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  ws.receive({ serverContent: { inputTranscription: { text: 'מה ' } } });
  ws.receive({ serverContent: { inputTranscription: { text: 'המצב?' } } });
  ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QUJD' } }] }, outputTranscription: { text: 'רגע, ' } } });
  expect(call.getCall().phase).toBe('speaking');
  expect(lastPlayer.played).toEqual(['QUJD']);
  ws.receive({ serverContent: { outputTranscription: { text: 'בודק.' } } });
  expect(render(h(VoiceHUD, {}))).toContain('“רגע, בודק.”');
  await tick(500);
  const tr = posts.filter((p) => p.url.endsWith('/voice/realtime/transcript'));
  expect(tr.at(-1).body.turns).toEqual([{ role: 'user', text: 'מה המצב?', id: 'u1' }, { role: 'assistant', text: 'רגע, בודק.', id: 'a2' }]);
  ws.receive({ serverContent: { interrupted: true } });
  expect(lastPlayer.stops).toBe(1);
  expect(call.getCall().phase).toBe('listening');
  ws.receive({ toolCall: { functionCalls: [{ id: 'fc-1', name: 'list_sessions', args: {} }] } });
  expect(call.getCall().phase).toBe('tool');
  await tick(20);
  expect(posts.find((p) => p.url.endsWith('/voice/realtime/tool')).body).toEqual({ sessionId: 's1', callId: 'call_gem12345', name: 'list_sessions', args: {} });
  expect(ws.sent.at(-1)).toEqual({ toolResponse: { functionResponses: [{ id: 'fc-1', name: 'list_sessions', response: { result: { sessions: [] } } }] } });
  expect(call.getCall().phase).toBe('listening');
  ws.receive({ serverContent: { outputTranscription: { text: 'אין סשנים.' } } });
  ws.receive({ serverContent: { turnComplete: true } });
  // the ~10-minute connection ends: goAway, then the socket drops → a new socket with the handle, same token
  ws.receive({ goAway: { timeLeft: '5s' } });
  ws.drop();
  await tick(10);
  const ws2 = FakeWS.instances[1];
  expect(ws2.sent[0]).toEqual({ setup: { ...setup, sessionResumption: { handle: 'h1' } } });
  expect(call.getCall().active).toBe(true);
  expect(call.getCall().phase).toBe('listening');
  lastMic.onChunk('BBBB');
  expect(ws2.sent.at(-1).realtimeInput.audio.data).toBe('BBBB');
  expect(call.toggleMute()).toBe(true);
  expect(lastMic.muted).toBe(true);
  await call.hangUp('hangup');
  expect(ws2.closed).toBe(true);
  expect(lastMic.stopped).toBe(true);
  expect(lastStream.tracks[0].stopped).toBe(true);
  expect(posts.at(-1).url).toBe('/__api/voice/realtime/end');
  expect(posts.at(-1).body.callId).toBe('call_gem12345');
  expect(posts.at(-2).body.turns).toEqual([{ role: 'assistant', text: 'אין סשנים.', id: 'a3' }]);
  expect(JSON.stringify(posts)).not.toContain('tok1'); // the token only ever goes to the vendor socket
});

test('Gemini Live: a socket that never completes setup fails the call → hands-free fallback with one line', async () => {
  await withProviders(['voice:gemini'], {});
  configBody = { ...configBody, voiceProviders: { ...configBody.voiceProviders, tts: ['voice:elevenlabs'] } };
  await store.loadConfig();
  prefs.setPrefs({ voiceReadAloud: true });
  mintBody = { ok: true, transport: 'gemini-ws', provider: 'voice:gemini', callId: 'call_gem22222', token: 'auth_tokens/tok2', wsUrl: 'wss://x', setup: {} };
  FakeWS.completeSetup = false;
  FakeWS.instances.length = 0;
  posts.length = 0;
  const p = call.startCall('s1');
  await tick(5);
  FakeWS.instances[0].drop(1008);
  expect(await p).toBe(false);
  FakeWS.completeSetup = true;
  expect(posts.find((x) => x.url.endsWith('/voice/realtime/end')).body).toEqual({ sessionId: 's1', callId: 'call_gem22222', seconds: 0, reason: 'failed' });
  expect(handsfree.getHandsFree().note).toBe('The call could not connect (Live socket closed (1008)). Continuing hands-free instead.');
  handsfree.stopHandsFree('test');
  prefs.setPrefs({ voiceReadAloud: false });
});

test('fallback: a gate answer or a failed SDP exchange ends the attempt, tells the host, and hands over to hands-free with one line when 1b is available', async () => {
  await withProviders(['voice:openai']);
  configBody = { ...configBody, voiceProviders: { ...configBody.voiceProviders, tts: ['voice:elevenlabs'] } };
  await store.loadConfig();
  prefs.setPrefs({ voiceReadAloud: true });
  mintBody = { needs_setup: 'voice:openai', why: 'hold a live voice conversation', hint: '' };
  posts.length = 0;
  expect(await call.startCall('s1')).toBe(false);
  expect(call.getCall().active).toBe(false);
  expect(call.lastCallEnd().reason).toBe('failed');
  let hf = handsfree.getHandsFree();
  expect([hf.active, hf.sessionId]).toEqual([true, 's1']);
  expect(hf.note).toBe('No voice provider is connected — the answer stays in text. Continuing hands-free instead.');
  const hud = render(h(VoiceHUD, {}));
  expect(hud).toContain('data-hands-free=');
  expect(hud).toContain('Continuing hands-free instead.');
  expect(posts.some((p) => p.url.endsWith('/voice/realtime/end'))).toBe(false); // nothing was minted
  handsfree.stopHandsFree('test');

  mintBody = { ok: true, transport: 'openai-webrtc', callId: 'call_def12345', clientSecret: 'ek_secret_2', callsUrl: 'https://api.openai.com/v1/realtime/calls' };
  sdpStatus = 500;
  posts.length = 0;
  expect(await call.startCall('s1')).toBe(false);
  sdpStatus = 200;
  expect(FakePC.instances.at(-1).closed).toBe(true);
  const end = posts.find((p) => p.url.endsWith('/voice/realtime/end'));
  expect(end.body).toEqual({ sessionId: 's1', callId: 'call_def12345', seconds: 0, reason: 'failed' });
  hf = handsfree.getHandsFree();
  expect(hf.active).toBe(true);
  expect(hf.note).toBe('The call could not connect (SDP answer 500). Continuing hands-free instead.');
  handsfree.stopHandsFree('test');

  // no hands-free (read-aloud off) → the line is a toast and nothing stays open
  prefs.setPrefs({ voiceReadAloud: false });
  mintBody = { disabled: true, why: 'off' };
  expect(await call.startCall('s1')).toBe(false);
  expect(handsfree.getHandsFree().active).toBe(false);
  expect(call.getCall().active).toBe(false);
  expect(render(h(VoiceHUD, {}))).toBe('');
});

test('pcm helpers: float ↔ int16 base64 round-trips, 48 kHz → 16 kHz keeps a third of the samples, the player schedules back to back and stop() drops the queue', async () => {
  const pcm = await import(web('lib/pcm.js'));
  const src = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
  const b64 = pcm.floatToPcm16Base64(src, 16000, 16000);
  const back = pcm.pcm16Base64ToFloat(b64);
  expect(back.length).toBe(6);
  for (let i = 0; i < 6; i++) expect(Math.abs(back[i] - src[i])).toBeLessThan(0.001);
  expect(pcm.pcm16Base64ToFloat(pcm.floatToPcm16Base64(new Float32Array(4800).fill(0.1), 48000, 16000)).length).toBe(1600);
  const started = [];
  const ctx = {
    currentTime: 1,
    destination: {},
    createBuffer: (ch, n, rate) => ({ duration: n / rate, data: new Float32Array(n), copyToChannel(a) { this.data.set(a); } }),
    createBufferSource: () => { const s = { connect() {}, start(at) { started.push(at); }, stop() { s.stopped = true; } }; return s; },
  };
  const player = pcm.pcmPlayer(ctx, 24000);
  player.play(pcm.floatToPcm16Base64(new Float32Array(2400), 24000, 24000)); // 100 ms
  player.play(pcm.floatToPcm16Base64(new Float32Array(2400), 24000, 24000));
  expect(started[0]).toBeCloseTo(1.02, 5);
  expect(started[1]).toBeCloseTo(1.12, 5);
  expect(player.playing).toBe(true);
  player.stop();
  expect(player.playing).toBe(false);
});
