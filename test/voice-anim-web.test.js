// Voice animation in the floating box (docs/VOICE.md): a level meter on a shared AudioContext + AnalyserNode (fake here),
// sources registered by the mic/call/TTS code, and a bar row in the box that follows the person (mic) or the agent (out).
// No real mic, speaker or network.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
let React, render, prefs, speak, voice, handsfree, call, store, VoiceHUD, VoiceWave, wave, lvl;
const h = (...a) => React.createElement(...a);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let configBody = {};
let mintBody = null;
let reduced = false;
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A fake AnalyserNode: `fill` is what getByteTimeDomainData writes (128 = silence).
const fakeAnalyser = () => {
  const a = { fill: 128, closed: 0, read() { return lvl.rmsOf(Uint8Array.from({ length: 512 }, () => a.fill)); }, close() { a.closed++; } };
  return a;
};
// A fake AudioContext that records the graph it was asked to build.
class FakeCtx {
  constructor() { this.state = 'running'; this.sources = []; this.analysers = []; this.sampleRate = 48000; }
  async resume() { this.state = 'running'; }
  createMediaStreamSource(stream) { const n = { stream, connected: [], disconnects: 0, connect(x) { this.connected.push(x); }, disconnect() { this.disconnects++; } }; this.sources.push(n); return n; }
  createAnalyser() { const a = { fftSize: 2048, fill: 128, getByteTimeDomainData(buf) { buf.fill(this.fill); } }; this.analysers.push(a); return a; }
  createGain() { const g = { connected: [], connect(x) { this.connected.push(x); } }; return g; }
  get destination() { return 'dest'; }
}
const fakeStream = (tracks = 1) => ({ getAudioTracks: () => Array.from({ length: tracks }, () => ({})), getTracks: () => [{ stop() {} }] });
// Manual rAF: frames run when the test says so.
const frames = [];
const raf = (fn) => { frames.push(fn); return frames.length; };
const caf = (id) => { frames[id - 1] = null; };
const runFrame = (t) => { const fns = frames.splice(0); for (const fn of fns) fn?.(t); };

class FakePC {
  constructor() { this.connectionState = 'new'; this.tracks = []; }
  addTrack(tr) { this.tracks.push(tr); }
  createDataChannel(name) { this.dc = { name, readyState: 'connecting', send() {}, close() {} }; return this.dc; }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async setLocalDescription() {}
  async setRemoteDescription() { this.dc.readyState = 'open'; this.dc.onopen?.(); this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
  close() { this.connectionState = 'closed'; }
}
let lastPC = null;
const callDeps = () => ({
  RTCPeerConnection: class extends FakePC { constructor() { super(); lastPC = this; } },
  getUserMedia: async () => fakeStream(),
  fetchImpl: async () => new Response('v=0 answer', { status: 200 }),
  audio: () => ({ srcObject: null, play: async () => {}, pause() {} }),
});

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'rtl' },
    body: {}, querySelector: () => null, getElementById: () => null, addEventListener() {}, removeEventListener() {}, activeElement: null,
  };
  globalThis.navigator = {
    language: 'he-IL', userAgent: 'test', platform: 'Linux',
    mediaDevices: { enumerateDevices: async () => [], getUserMedia: async () => fakeStream() },
  };
  globalThis.MediaRecorder = class { constructor() { this.state = 'recording'; } static isTypeSupported() { return true; } start() {} stop() { this.state = 'inactive'; this.onstop?.(); } };
  globalThis.matchMedia = (q) => ({ matches: q.includes('reduced-motion') ? reduced : false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  globalThis.dispatchEvent = () => true;
  globalThis.addEventListener = () => {};
  const err = console.error;
  console.error = (...a) => { if (!/useLayoutEffect/.test(String(a[0]))) err(...a); };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/__api/config')) return jsonResponse(configBody);
    if (u.endsWith('/voice/realtime/session')) return jsonResponse(mintBody);
    if (init?.method === 'POST') return jsonResponse({ ok: true });
    return jsonResponse({});
  };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  lvl = await import(web('lib/audioLevel.js'));
  prefs = await import(web('lib/prefs.js'));
  speak = await import(web('lib/speak.js'));
  voice = await import(web('lib/voice.js'));
  handsfree = await import(web('lib/handsfree.js'));
  call = await import(web('lib/call.js'));
  store = await import(web('lib/store.js'));
  ({ default: VoiceHUD } = await import(web('components/VoiceHUD.jsx')));
  wave = await import(web('components/VoiceWave.jsx'));
  VoiceWave = wave.default;
  speak.installReadAloud();
  prefs.setPrefs({ language: 'he' });
  call.setCallDeps(callDeps());
});
afterAll(async () => {
  await call.hangUp('test'); handsfree.stopHandsFree('test'); speak.stopSpeaking(); voice.cancel(); call.setCallDeps(null);
  lvl.setAudioSource('mic', null); lvl.setAudioSource('out', null);
  prefs.setPrefs({ language: 'en', voiceReadAloud: false, voiceBrowserTts: false });
});

test('rms + smoothing: silence is 0, a loud signal is high, the level rises fast and falls slowly, never past 1', () => {
  expect(lvl.rmsOf(new Uint8Array(512).fill(128))).toBe(0);
  expect(lvl.rmsOf(Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 255 : 1)))).toBeGreaterThan(0.98);
  expect(lvl.rmsOf(null)).toBe(0);
  const up = lvl.smoothLevel(0, 0.3);
  expect(up).toBeGreaterThan(0.4); // one frame of speech already shows
  expect(lvl.smoothLevel(up, 0.3)).toBeGreaterThan(up);
  const down = lvl.smoothLevel(0.8, 0);
  expect(down).toBeGreaterThan(0.6); // still visible a frame after the sound stopped
  expect(down).toBeLessThan(0.8);
  expect(lvl.smoothLevel(0, 5)).toBeLessThanOrEqual(1);
  expect(lvl.smoothLevel(0.004, 0)).toBe(0);
});

test('meter: ~30 fps via rAF, silence → 0 (no churn), loud → high, decays after, stop releases the analyser and the frame', () => {
  const an = fakeAnalyser();
  const seen = [];
  let t = 0;
  const m = lvl.createMeter(null, { analyser: an, raf, caf, now: () => t, fps: 30 });
  expect(m.start((l) => seen.push(l))).toBe(true);
  runFrame(); t += 40; runFrame(); t += 40; runFrame();
  expect(seen).toEqual([]); // silence never re-renders
  expect(m.level).toBe(0);
  an.fill = 200; // loud
  t += 40; runFrame();
  expect(seen.length).toBe(1);
  expect(seen[0]).toBeGreaterThan(0.5);
  t += 10; runFrame(); // too soon for 30 fps: skipped
  expect(seen.length).toBe(1);
  t += 40; runFrame();
  expect(seen.length).toBe(2);
  expect(seen[1]).toBeGreaterThan(seen[0]);
  an.fill = 128;
  t += 40; runFrame();
  expect(seen[2]).toBeLessThan(seen[1]);
  expect(seen[2]).toBeGreaterThan(0); // smoothed, not a cliff
  expect(frames.filter(Boolean).length).toBe(1);
  m.stop();
  expect(an.closed).toBe(1);
  expect(frames.filter(Boolean).length).toBe(0);
  expect(m.level).toBe(0);
  frames.length = 0;
});

test('attach: a stream, an element (srcObject / captureStream), a node in its own context; nothing measurable → null', () => {
  const ctx = new FakeCtx();
  const s = fakeStream();
  const a = lvl.attachAnalyser(s, ctx);
  expect(ctx.sources[0].stream).toBe(s);
  expect(ctx.analysers[0].fftSize).toBe(512);
  expect(ctx.sources[0].connected).toEqual([ctx.analysers[0]]);
  ctx.analysers[0].fill = 160;
  expect(a.read()).toBeCloseTo(0.25, 2);
  a.close();
  expect(ctx.sources[0].disconnects).toBeGreaterThan(0);
  expect(lvl.attachAnalyser({ srcObject: fakeStream() }, ctx).read()).toBe(0);
  const cap = fakeStream();
  lvl.attachAnalyser({ captureStream: () => cap }, ctx);
  expect(ctx.sources.at(-1).stream).toBe(cap);
  const own = new FakeCtx();
  const node = { connected: [], connect(x) { this.connected.push(x); }, disconnect() {} };
  lvl.attachAnalyser({ node, ctx: own }, ctx);
  expect(own.analysers.length).toBe(1);
  expect(node.connected).toEqual([own.analysers[0]]);
  expect(lvl.attachAnalyser(null, ctx)).toBe(null);
  expect(lvl.attachAnalyser({ src: 'x' }, ctx)).toBe(null);
  expect(lvl.attachAnalyser(fakeStream(0), ctx)).toBe(null); // no audio track
  expect(lvl.attachAnalyser(fakeStream(), null)).toBe(null); // no Web Audio
  const m = lvl.createMeter(null, { raf, caf });
  expect(m.start()).toBe(false); // safe without a source
  expect(m.level).toBe(0);
});

test('sources: set/clear by identity, subscribers told once per change', () => {
  const events = [];
  const off = lvl.subscribeAudioSources(() => events.push([lvl.getAudioSource('mic'), lvl.getAudioSource('out')]));
  const a = fakeStream();
  const b = fakeStream();
  lvl.setAudioSource('mic', a);
  lvl.setAudioSource('mic', a); // same → no event
  lvl.setAudioSource('mic', b);
  lvl.clearAudioSource('mic', a); // not ours any more → kept
  expect(lvl.getAudioSource('mic')).toBe(b);
  lvl.clearAudioSource('mic', b);
  lvl.setAudioSource('nope', a); // unknown kind: ignored
  expect(events).toEqual([[a, null], [b, null], [null, null]]);
  off();
});

test('wave: mic/out tint + state, idle resting, synth pulse when playback cannot be tapped, reduced motion = static steps', () => {
  let html = render(h(VoiceWave, { who: 'mic' }));
  expect(html).toContain('data-voice-wave="mic"');
  expect(html).toContain('data-voice-wave-motion="live"');
  expect(html).toContain('--color-brand');
  expect(html).toContain('transition-[height]');
  expect(html).toContain('height:3px'); // level 0 before the first frame
  html = render(h(VoiceWave, { who: null }));
  expect(html).toContain('data-voice-wave="idle"');
  expect(html).toContain('opacity:0.35');
  expect(html).not.toContain('voice-wave-synth');
  html = render(h(VoiceWave, { who: 'out' })); // nothing registered for playback (speechSynthesis) → the pulse
  expect(html).toContain('data-voice-wave="out"');
  expect(html).toContain('data-voice-wave-motion="synth"');
  expect(html).toContain('voice-wave-synth');
  expect(html).toContain('--color-info');
  lvl.setAudioSource('out', fakeStream());
  html = render(h(VoiceWave, { who: 'out' }));
  expect(html).toContain('data-voice-wave-motion="live"');
  expect(html).not.toContain('voice-wave-synth');
  lvl.setAudioSource('out', null);
  reduced = true;
  html = render(h(VoiceWave, { who: 'out' }));
  expect(html).toContain('data-voice-wave-motion="reduced"');
  expect(html).not.toContain('voice-wave-synth');
  expect(html).not.toContain('transition-');
  reduced = false;
  // reduced motion quantises the level; live keeps it continuous; the row never changes height
  const { barHeights, WEIGHTS } = wave;
  expect(barHeights(0)).toEqual(WEIGHTS.map(() => 3));
  expect(barHeights(1)).toEqual([11, 15, 18, 20, 18, 15, 11]);
  expect(barHeights(0.6, { reduced: true })).toEqual(barHeights(0.5));
  expect(barHeights(0.6)).not.toEqual(barHeights(0.5));
});

test('hands-free box: the wave follows the mic while listening, rests while muted/thinking, follows playback while speaking', async () => {
  configBody = { voiceEnabled: true, voiceProviders: { enabled: true, stt: ['groq'], tts: ['voice:elevenlabs'], realtime: [], telephony: false } };
  await store.loadConfig();
  handsfree.startHandsFree('s1');
  await tick();
  expect(voice.getState().status).toBe('recording');
  expect(lvl.getAudioSource('mic')).toBeTruthy(); // the recorder's own stream, not a second mic
  let html = render(h(VoiceHUD, {}));
  expect(html).toContain('data-hands-free="listening"');
  expect(html).toContain('data-voice-wave="mic"');
  expect(html).toContain('data-voice-wave-motion="live"');
  handsfree.toggleHandsFreeMute();
  expect(lvl.getAudioSource('mic')).toBe(null); // mic closed → released
  html = render(h(VoiceHUD, {}));
  expect(html).toContain('data-voice-wave="idle"');
  handsfree.toggleHandsFreeMute();
  await tick();
  await voice.handleTranscript('מה השתנה', 'handsfree');
  await tick();
  expect(handsfree.getHandsFree().phase).toBe('thinking');
  expect(render(h(VoiceHUD, {}))).toContain('data-voice-wave="idle"');
  // the answer plays through the shared <audio>: speaking → the wave follows the playback element
  const el = { srcObject: null, play: async () => {}, pause() {}, load() {}, removeAttribute() {}, setAttribute() {} };
  globalThis.Audio = function () { return el; };
  globalThis.URL.createObjectURL ||= () => 'blob:x';
  globalThis.URL.revokeObjectURL ||= () => {};
  speak.setPlayerFactory(() => speak.htmlAudioPlayer());
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).endsWith('/__api/voice/tts') ? new Response(new Blob(['x'], { type: 'audio/mpeg' }), { status: 200, headers: { 'content-type': 'audio/mpeg' } }) : origFetch(url, init));
  speak.onChatEvent('s1', { kind: 'assistant-text', partial: true, text: 'השינוי הוא בקובץ הזה. ' });
  await tick(); await tick(); await tick();
  expect(handsfree.getHandsFree().phase).toBe('speaking');
  expect(lvl.getAudioSource('out')).toBe(el);
  html = render(h(VoiceHUD, {}));
  expect(html).toContain('data-voice-wave="out"');
  el.onended?.();
  expect(lvl.getAudioSource('out')).toBe(null);
  globalThis.fetch = origFetch;
  handsfree.stopHandsFree('test');
  speak.setPlayerFactory(null);
  expect(lvl.getAudioSource('mic')).toBe(null);
  expect(render(h(VoiceHUD, {}))).toBe('');
});

test('call box: the mic track and the remote stream feed the wave; hang-up releases both', async () => {
  configBody = { voiceEnabled: true, voiceProviders: { enabled: true, stt: ['groq'], tts: [], realtime: ['voice:openai'], telephony: false } };
  await store.loadConfig();
  mintBody = { ok: true, transport: 'openai-webrtc', provider: 'voice:openai', callId: 'call_1', clientSecret: 'ek_1', expiresAt: 1900000000, callsUrl: 'https://api.openai.com/v1/realtime/calls' };
  expect(await call.startCall('s1')).toBe(true);
  expect(lvl.getAudioSource('mic')).toBeTruthy();
  let html = render(h(VoiceHUD, {}));
  expect(html).toContain('data-voice-call="listening"');
  expect(html).toContain('data-voice-wave="mic"');
  const remote = fakeStream();
  lastPC.ontrack({ streams: [remote] });
  expect(lvl.getAudioSource('out')).toBe(remote);
  call.onEvent({ type: 'output_audio_buffer.started' });
  html = render(h(VoiceHUD, {}));
  expect(html).toContain('data-voice-wave="out"');
  expect(html).toContain('data-voice-wave-motion="live"');
  call.toggleMute();
  call.onEvent({ type: 'output_audio_buffer.stopped' });
  expect(render(h(VoiceHUD, {}))).toContain('data-voice-wave="idle"'); // muted mic: nothing to follow
  await call.hangUp('test');
  expect(lvl.getAudioSource('mic')).toBe(null);
  expect(lvl.getAudioSource('out')).toBe(null);
});
