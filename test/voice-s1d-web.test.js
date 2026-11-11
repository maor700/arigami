// Stage 1d web (docs/VOICE.md): the rail's global phone (gating, home anchor + open session as context), the busy line with
// a takeover, the resume when the page comes back (Gemini handle / OpenAI re-mint once / else end with one line), and the
// screen wake lock following the voice state — all against fakes, no real mic, speaker, network or screen.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, call, handsfree, speak, voice, store, VoiceHUD, CallButton, RailCallButton, wake, toastLib;
let mintStatus = 200;
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
    if (u.endsWith('/voice/realtime/session')) return jsonResponse(typeof mintBody === 'function' ? mintBody(body) : mintBody, mintStatus);
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
  ({ CallButton, RailCallButton } = await import(web('components/VoiceOutButtons.jsx')));
  wake = await import(web('lib/wakeLock.js'));
  toastLib = await import(web('lib/toast.js'));
  speak.installReadAloud();
  prefs.setPrefs({ language: 'en' });
  call.setCallDeps(callDeps());
});
afterAll(async () => { await call.hangUp('test'); handsfree.stopHandsFree('test'); speak.stopSpeaking(); voice.cancel(); call.setCallDeps(null); prefs.setPrefs({ language: 'en', voiceReadAloud: false, voiceBrowserTts: false }); });

const withProviders = async (realtime, extra = {}) => {
  configBody = { voiceEnabled: true, voiceProviders: { enabled: true, stt: ['groq'], tts: [], realtime, telephony: false }, ...extra };
  await store.loadConfig();
};
const toasts = () => { let out = []; render(h(() => { out = toastLib.useToasts(); return null; })); return out; };
const openaiMint = (id, extra = {}) => ({ ok: true, transport: 'openai-webrtc', provider: 'voice:openai', callId: id, sessionId: 'sess_home', clientSecret: `ek_${id}`, callsUrl: 'https://api.openai.com/v1/realtime/calls', ...extra });

test('rail phone: nothing without a realtime provider; with one, a global call anchored in the home session with the open session as context; on while any call is live; the kill-switch hides it', async () => {
  await withProviders([]);
  expect(render(h(RailCallButton, { contextSessionId: 'sess_open' }))).toBe('');
  expect(render(h(VoiceHUD, {}))).toBe('');
  await withProviders(['voice:openai']);
  expect(render(h(RailCallButton, { contextSessionId: 'sess_open' }))).toContain('data-rail-call="off"');
  mintBody = openaiMint('call_home0001');
  mintStatus = 200;
  posts.length = 0;
  expect(await call.toggleGlobalCall('sess_open')).toBe(true);
  expect(posts[0]).toEqual({ url: '/__api/voice/realtime/session', body: { home: true, contextSessionId: 'sess_open', lang: 'en' } });
  const st = call.getCall();
  expect([st.active, st.global, st.sessionId, st.contextSessionId, st.callId]).toEqual([true, true, 'sess_home', 'sess_open', 'call_home0001']);
  expect(render(h(RailCallButton, { contextSessionId: 'sess_other' }))).toContain('data-rail-call="on"');
  expect(render(h(CallButton, { sessionId: 'sess_open' }))).toContain('data-voice-call="off"'); // the composer phone is per session
  await call.toggleGlobalCall('sess_other'); // the same button hangs up
  expect(call.getCall().active).toBe(false);
  expect(posts.at(-1).url).toBe('/__api/voice/realtime/end');
  expect(posts.at(-1).body.sessionId).toBe('sess_home');
  configBody = { ...configBody, voiceProviders: { ...configBody.voiceProviders, enabled: false } };
  await store.loadConfig();
  expect(render(h(RailCallButton, { contextSessionId: 'sess_open' }))).toBe('');
});

test('one call at a time: a busy line (409) is one toast with a takeover, no hands-free fallback; the takeover re-mints with takeover:true', async () => {
  await withProviders(['voice:openai']);
  mintStatus = 409;
  mintBody = { error: 'another voice call is live', busy: true };
  posts.length = 0;
  expect(await call.startCall(null, { home: true, contextSessionId: 'sess_open' })).toBe(false);
  expect(call.getCall().active).toBe(false);
  expect(handsfree.getHandsFree().active).toBe(false);
  const t = toasts().at(-1);
  expect(t.message).toBe('Another voice call is live (maybe on another device).');
  expect(t.action.label).toBe('End it and call');
  mintStatus = 200;
  mintBody = openaiMint('call_take0001');
  await t.action.onClick();
  await tick();
  expect(posts.find((p) => p.body?.takeover).body).toEqual({ home: true, contextSessionId: 'sess_open', takeover: true, lang: 'en' });
  expect(call.getCall().callId).toBe('call_take0001');
  await call.hangUp('hangup');
});

test('resume (OpenAI): a drop while hidden waits; back to visible → the old call is ended and ONE re-mint reconnects; a second failure ends with one line', async () => {
  await withProviders(['voice:openai']);
  const doc = globalThis.document;
  mintBody = openaiMint('call_res00001', { sessionId: 'sess_open' });
  expect(await call.startCall('sess_open')).toBe(true);
  expect(await call.resumeCall()).toBe('alive');
  doc.visibilityState = 'hidden';
  const pc = FakePC.instances.at(-1);
  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();
  expect(call.getCall().active).toBe(true); // not ended while the screen is away
  expect(call.getCall().phase).toBe('connecting');
  doc.visibilityState = 'visible';
  posts.length = 0;
  mintBody = openaiMint('call_res00002', { sessionId: 'sess_open' });
  expect(await call.resumeCall()).toBe('reconnected');
  expect(posts.map((p) => p.url)).toEqual(['/__api/voice/realtime/end', '/__api/voice/realtime/session']);
  expect(posts[0].body).toMatchObject({ sessionId: 'sess_open', callId: 'call_res00001', reason: 'resume' });
  expect(posts[1].body).toEqual({ sessionId: 'sess_open', lang: 'en' });
  expect([call.getCall().active, call.getCall().callId, call.getCall().phase]).toEqual([true, 'call_res00002', 'listening']);
  expect(pc.closed).toBe(true);
  // again: this time the re-mint fails → the call ends with one line
  doc.visibilityState = 'hidden';
  const pc2 = FakePC.instances.at(-1);
  pc2.connectionState = 'failed';
  pc2.onconnectionstatechange();
  doc.visibilityState = 'visible';
  mintStatus = 500;
  mintBody = { error: 'down' };
  expect(await call.resumeCall()).toBe('ended');
  mintStatus = 200;
  expect(call.getCall().active).toBe(false);
  expect(toasts().at(-1).message).toBe('The call dropped while the screen was away, so it ended.');
  delete doc.visibilityState;
});

test('resume (Gemini): a socket that dropped while hidden is reopened with the session handle on return', async () => {
  await withProviders(['voice:gemini']);
  const doc = globalThis.document;
  mintBody = { ok: true, transport: 'gemini-ws', provider: 'voice:gemini', callId: 'call_gemres01', sessionId: 'sess_open', token: 'auth_tokens/t', wsUrl: 'wss://x', setup: { model: 'm' } };
  FakeWS.completeSetup = true;
  FakeWS.instances.length = 0;
  expect(await call.startCall('sess_open')).toBe(true);
  const ws = FakeWS.instances[0];
  ws.receive({ sessionResumptionUpdate: { newHandle: 'h9', resumable: true } });
  doc.visibilityState = 'hidden';
  FakeWS.completeSetup = false; // the background tab cannot reconnect
  ws.drop();
  await tick(20);
  expect(call.getCall().active).toBe(true);
  doc.visibilityState = 'visible';
  FakeWS.completeSetup = true;
  const n = FakeWS.instances.length;
  expect(await call.resumeCall()).toBe('resumed');
  const back = FakeWS.instances.at(-1);
  expect(FakeWS.instances.length).toBe(n + 1);
  expect(back.sent[0]).toEqual({ setup: { model: 'm', sessionResumption: { handle: 'h9' } } });
  expect(call.getCall().phase).toBe('listening');
  await call.hangUp('hangup');
  delete doc.visibilityState;
});

test('wake lock: taken while a call is live, released when it ends, re-taken on return to visible; no API → nothing happens', async () => {
  const requests = [];
  const sentinels = [];
  const listeners = {};
  const fakeDoc = { visibilityState: 'visible', addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener: (k) => { delete listeners[k]; } };
  const fakeNav = { wakeLock: { request: async (type) => { requests.push(type); const s = { released: false, on: {}, release: async () => { s.released = true; s.on.release?.(); }, addEventListener: (k, fn) => { s.on[k] = fn; } }; sentinels.push(s); return s; } } };
  wake.setWakeLockEnv({ nav: fakeNav, doc: fakeDoc });
  const off = wake.installVoiceKeepAlive();
  expect(requests).toEqual([]);
  await withProviders(['voice:openai']);
  mintBody = openaiMint('call_wake0001', { sessionId: 'sess_open' });
  expect(await call.startCall('sess_open')).toBe(true);
  await tick();
  expect(requests).toEqual(['screen']);
  expect(wake.wakeLockHeld()).toBe(true);
  // the page hides: the browser drops the lock; back to visible: it is asked for again
  fakeDoc.visibilityState = 'hidden';
  sentinels[0].on.release();
  expect(wake.wakeLockHeld()).toBe(false);
  fakeDoc.visibilityState = 'visible';
  listeners.visibilitychange();
  await tick();
  expect(requests.length).toBe(2);
  expect(wake.wakeLockHeld()).toBe(true);
  await call.hangUp('hangup');
  expect(sentinels[1].released).toBe(true);
  expect(wake.wakeLockHeld()).toBe(false);
  off();
  expect(listeners.visibilitychange).toBe(undefined);
  wake.setWakeLockEnv({ nav: {}, doc: fakeDoc }); // a browser without the API
  const off2 = wake.installVoiceKeepAlive();
  expect(await wake.holdWakeLock()).toBe(false);
  off2();
  wake.setWakeLockEnv(null);
});
