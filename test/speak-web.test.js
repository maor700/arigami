// Stage 1b web (docs/VOICE.md): the sentence chunker (Hebrew + English punctuation, fenced code → one marker,
// markdown stripped), the ordered TTS queue (1–2 in flight, plays in order, stop() drops everything), the gating
// (no source → no UI; source + pref → UI), barge-in (interrupt only while the turn streams), the iOS unlock path,
// and the hands-free window inside VoiceHUD. Browser APIs are shimmed; nothing here opens a real mic or speaker.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, speak, voice, handsfree, store, VoiceHUD, ReadAloudButton, HandsFreeButton, VoiceAdvanced;
const h = (...a) => React.createElement(...a);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let configBody = {};
const posts = [];
let mediaCalls = 0;

// A player that records what it was asked to play and resolves when the test says so.
function fakePlayer() {
  const p = { played: [], unlocks: 0, stops: 0, pending: null, kind: 'audio' };
  p.unlock = () => { p.unlocks++; };
  p.play = (payload) => new Promise((resolve) => { p.played.push(payload); p.pending = resolve; });
  p.stop = () => { p.stops++; const r = p.pending; p.pending = null; r?.(); };
  p.finish = () => { const r = p.pending; p.pending = null; r?.(); };
  return p;
}
const audioResponse = (tag) => new Response(new Blob([tag], { type: 'audio/mpeg' }), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
    mediaDevices: { enumerateDevices: async () => [], getUserMedia: async () => { mediaCalls++; return { getTracks: () => [] }; } },
  };
  globalThis.MediaRecorder = class {
    constructor() { this.state = 'recording'; }
    static isTypeSupported() { return true; }
    start() {}
    stop() { this.state = 'inactive'; this.onstop?.(); }
  };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  globalThis.dispatchEvent = () => true;
  globalThis.addEventListener = () => {};
  const err = console.error;
  console.error = (...a) => { if (!/useLayoutEffect/.test(String(a[0]))) err(...a); };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u.endsWith('/__api/config')) return jsonResponse(configBody);
    return jsonResponse({});
  };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  speak = await import(web('lib/speak.js'));
  voice = await import(web('lib/voice.js'));
  handsfree = await import(web('lib/handsfree.js'));
  store = await import(web('lib/store.js'));
  ({ default: VoiceHUD } = await import(web('components/VoiceHUD.jsx')));
  ({ ReadAloudButton, HandsFreeButton } = await import(web('components/VoiceOutButtons.jsx')));
  ({ VoiceAdvanced } = await import(web('components/settings/Voice.jsx')));
  speak.installReadAloud(); // what App.jsx does at boot: the store tap + the mic hook
  prefs.setPrefs({ language: 'en' });
});
// Module state is shared with the other web tests in this process: leave the mic, the HUD and the reading idle.
afterAll(() => { handsfree.stopHandsFree('test'); speak.stopSpeaking(); voice.cancel(); prefs.setPrefs({ language: 'en', voiceReadAloud: false, voiceBrowserTts: false }); });

// ---- chunker ------------------------------------------------------------------------------

test('chunker: Hebrew + English sentence ends, split across deltas; a trailing fragment waits for flush()', () => {
  const c = new speak.SentenceChunker();
  const out = [];
  for (const d of ['שלום מאור, הנה התשו', 'בה שלך. השורה השנייה ארוכה מספיק! Is this ', 'the third sentence? And a tail']) out.push(...c.push(d));
  expect(out).toEqual(['שלום מאור, הנה התשובה שלך.', 'השורה השנייה ארוכה מספיק!', 'Is this the third sentence?']);
  expect(c.flush()).toEqual(['And a tail']);
  expect(c.flush()).toEqual([]);
});

test('chunker: decimals and short abbreviations do not split; a line break is a boundary; tiny lines merge forward', () => {
  const c = new speak.SentenceChunker();
  const out = [...c.push('The build took 3.5 seconds, e.g. '), ...c.push('on CI. Fine.\n## Title\nNext line here. See Dr. Cohen tomorrow. '), ...c.flush()];
  expect(out.join(' | ')).toBe('The build took 3.5 seconds, e.g. on CI. | Fine. Title Next line here. | See Dr. Cohen tomorrow.');
});

test('chunker: a fenced block becomes one spoken marker (even when the fence arrives in pieces); markdown is stripped', () => {
  const c = new speak.SentenceChunker({ codeMarker: speak.codeMarkerFor('he') });
  const out = [];
  for (const d of ['Here is **the fix** in `app.js`:\n``', '`js\nconst x = 1;\nconsole.log(x);\n``', '`\nThen run [the tests](https://x.y/z) again. See https://example.com/docs for more.']) out.push(...c.push(d));
  out.push(...c.flush());
  expect(out).toEqual(['Here is the fix in app.js:', 'קטע קוד.', 'Then run the tests again.', 'See for more.']);
});

test('stripMarkdown: headings, bullets, quotes, tables, emphasis, images, inline code, html', () => {
  expect(speak.stripMarkdown('# Heading\n- item *one*\n> quoted __bold__\n| a | b |\n|---|---|\n| 1 | 2 |\n![alt](i.png) <br> `code` ~~gone~~ snake_case_name')).toBe(
    'Heading item one quoted bold a, b. 1, 2. alt code gone snake_case_name'
  );
});

test('chunker: a very long run without punctuation is cut at a pause so one TTS call stays bounded', () => {
  const c = new speak.SentenceChunker({ maxChars: 60 });
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const out = [...c.push(words), ...c.flush()];
  expect(out.length).toBeGreaterThan(3);
  for (const s of out) expect(s.length).toBeLessThanOrEqual(61);
  expect(out.join(' ')).toBe(words);
});

// ---- queue --------------------------------------------------------------------------------

test('queue: at most two fetches in flight, playback strictly in order even when the second sentence returns first', async () => {
  const player = fakePlayer();
  const pending = [];
  const fetchImpl = (url, init) => new Promise((resolve) => pending.push({ text: JSON.parse(init.body).text, resolve, signal: init.signal }));
  const done = [];
  const sp = new speak.Speaker({ sessionId: 's1', lang: 'en', fetchImpl, player, onDone: () => done.push(1) });
  sp.feed('First sentence here. Second sentence here. Third sentence here. ');
  sp.end();
  await tick();
  expect(pending.map((p) => p.text)).toEqual(['First sentence here.', 'Second sentence here.']);
  pending[1].resolve(audioResponse('two'));
  await tick();
  expect(player.played.length).toBe(0); // the head is not ready yet
  pending[0].resolve(audioResponse('one'));
  await tick();
  expect(player.played.length).toBe(1);
  expect(await player.played[0].text()).toBe('one');
  expect(pending.length).toBe(3); // the third fetch started once a slot freed
  player.finish();
  await tick();
  expect(await player.played[1].text()).toBe('two');
  player.finish();
  await tick();
  pending[2].resolve(audioResponse('three'));
  await tick();
  expect(await player.played[2].text()).toBe('three');
  expect(done).toEqual([]);
  player.finish();
  await tick();
  expect(done).toEqual([1]);
  expect(sp.active).toBe(false);
});

test('queue: stop() aborts the fetches, empties the queue, stops the player and fires onDone once; late audio is ignored', async () => {
  const player = fakePlayer();
  const pending = [];
  const fetchImpl = (url, init) => new Promise((resolve) => pending.push({ resolve, signal: init.signal }));
  const done = [];
  const sp = new speak.Speaker({ sessionId: 's1', lang: 'en', fetchImpl, player, onDone: () => done.push(1) });
  sp.feed('Alpha sentence one. Beta sentence two. Gamma sentence three. Delta sentence four.');
  await tick();
  pending[0].resolve(audioResponse('a'));
  await tick();
  expect(player.played.length).toBe(1);
  expect(sp.speaking).toBe(true);
  expect(pending.length).toBe(3); // one played, two in flight
  sp.stop();
  expect(pending[1].signal.aborted).toBe(true);
  expect(pending[2].signal.aborted).toBe(true);
  expect(sp.order).toEqual([]);
  expect(player.stops).toBe(1);
  expect(done).toEqual([1]);
  pending[1].resolve(audioResponse('b'));
  sp.feed('More text after stop. ');
  sp.end();
  await tick();
  expect(player.played.length).toBe(1);
  expect(pending.length).toBe(3);
  expect(done).toEqual([1]);
});

test('queue: a needs_setup / soft-stopped answer stops the reading (text stays on screen) unless the browser voice may take over', async () => {
  const problems = [];
  const player = fakePlayer();
  const sp = new speak.Speaker({ sessionId: 's1', lang: 'en', player, fetchImpl: async () => jsonResponse({ budget: 'soft-stopped', provider: 'voice:elevenlabs', why: 'cap' }), onProblem: (p) => problems.push(p) });
  sp.feed('Sentence number one. Sentence number two. ');
  sp.end();
  await tick();
  expect(problems[0].budget).toBe('soft-stopped');
  expect(player.played).toEqual([]);
  expect(sp.active).toBe(false);
  // with the browser voice opted in, the remaining sentences are spoken by it
  globalThis.speechSynthesis = { spoken: [], speak(u) { this.spoken.push(u.text); setTimeout(() => u.onend?.(), 0); }, cancel() {}, getVoices: () => [{ lang: 'he-IL' }] };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  const sp2 = new speak.Speaker({ sessionId: 's1', lang: 'he', player: fakePlayer(), fetchImpl: async () => jsonResponse({ needs_setup: 'voice:elevenlabs', why: 'x', hint: 'y' }), allowBrowserFallback: true });
  sp2.feed('משפט ראשון כאן. משפט שני כאן. ');
  sp2.end();
  await tick(5);
  await tick(5);
  expect(globalThis.speechSynthesis.spoken).toEqual(['משפט ראשון כאן.', 'משפט שני כאן.']);
  expect(sp2.active).toBe(false);
  delete globalThis.speechSynthesis;
  delete globalThis.SpeechSynthesisUtterance;
});

// ---- gating ------------------------------------------------------------------------------

test('gating: no source → nothing; host TTS provider → server; browser opt-in → browser; kill-switch wins; hands-free needs STT too', () => {
  const none = { voiceEnabled: true, voiceProviders: { enabled: true, stt: ['groq'], tts: [], realtime: [], telephony: false } };
  const el = { ...none, voiceProviders: { ...none.voiceProviders, tts: ['voice:elevenlabs'] } };
  const off = { ...el, voiceProviders: { ...el.voiceProviders, enabled: false } };
  const p = (x) => ({ voiceReadAloud: false, voiceBrowserTts: false, ...x });
  expect(speak.ttsSource(none, p({}), true)).toBeNull();
  expect(speak.ttsSource(none, p({ voiceBrowserTts: true }), true)).toBe('browser');
  expect(speak.ttsSource(none, p({ voiceBrowserTts: true }), false)).toBeNull();
  expect(speak.ttsSource(el, p({}), false)).toBe('server');
  expect(speak.ttsSource(off, p({ voiceBrowserTts: true }), true)).toBeNull();
  expect(speak.ttsSource(undefined, p({}), true)).toBeNull(); // an old host without voiceProviders
  expect(speak.readAloudOn(el, p({}))).toBe(false);
  expect(speak.readAloudOn(el, p({ voiceReadAloud: true }))).toBe(true);
  expect(speak.handsFreeAvailable(el, p({ voiceReadAloud: true }))).toBe(true);
  expect(speak.handsFreeAvailable({ ...el, voiceEnabled: false }, p({ voiceReadAloud: true }))).toBe(false);
});

test('gating in the UI: no source → the composer buttons and the settings toggle render nothing; source + pref → they appear', async () => {
  for (const lang of ['en', 'he']) {
    prefs.setPrefs({ language: lang, voiceReadAloud: false, voiceBrowserTts: false });
    configBody = { voiceEnabled: true, voiceProviders: { enabled: true, stt: ['groq'], tts: [], realtime: [], telephony: false } };
    await store.loadConfig();
    expect(render(h(ReadAloudButton, { sessionId: 's1' }))).toBe('');
    expect(render(h(HandsFreeButton, { sessionId: 's1' }))).toBe('');
    expect(render(h(VoiceAdvanced, {}))).not.toContain('data-voice-read-aloud');
    expect(render(h(VoiceHUD, {}))).toBe('');
    configBody = { ...configBody, voiceProviders: { ...configBody.voiceProviders, tts: ['voice:elevenlabs'] } };
    await store.loadConfig();
    const offBtn = render(h(ReadAloudButton, { sessionId: 's1' }));
    expect(offBtn).toContain('data-read-aloud="off"');
    expect(offBtn).toContain(lang === 'he' ? 'הקראת תשובות: כבוי' : 'Read answers aloud: off');
    expect(render(h(HandsFreeButton, { sessionId: 's1' }))).toBe(''); // pref still off
    expect(render(h(VoiceAdvanced, {}))).toContain('data-voice-read-aloud="0"');
    prefs.setPrefs({ voiceReadAloud: true });
    expect(render(h(ReadAloudButton, { sessionId: 's1' }))).toContain('data-read-aloud="on"');
    const hfBtn = render(h(HandsFreeButton, { sessionId: 's1' }));
    expect(hfBtn).toContain('data-hands-free="off"');
    expect(hfBtn).toContain(lang === 'he' ? 'שיחה ללא ידיים' : 'Hands-free conversation');
    // STT gone → hands-free gone, read-aloud stays
    configBody = { ...configBody, voiceEnabled: false };
    await store.loadConfig();
    expect(render(h(HandsFreeButton, { sessionId: 's1' }))).toBe('');
    expect(render(h(ReadAloudButton, { sessionId: 's1' }))).toContain('data-read-aloud="on"');
  }
  prefs.setPrefs({ language: 'en', voiceReadAloud: false });
});

// ---- the live wiring: arm → chat events → spoken; barge-in ----------------------------------

test('armed turn: partial deltas are spoken in order, the persisted message is not spoken twice, result ends it; a full message without deltas is spoken', async () => {
  const player = fakePlayer();
  speak.setPlayerFactory(() => player);
  const played = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/__api/voice/tts')) { played.push(JSON.parse(init.body)); return audioResponse('x'); }
    return origFetch(url, init);
  };
  const cfg = { voiceEnabled: true, voiceProviders: { enabled: true, stt: ['groq'], tts: ['voice:elevenlabs'], realtime: [], telephony: false } };
  const dones = [];
  speak.armReadAloud('s1', { config: cfg, lang: 'he', onDone: () => dones.push(1) });
  speak.onChatEvent('s2', { kind: 'assistant-text', partial: true, text: 'Other session. ' }); // not ours
  speak.onChatEvent('s1', { kind: 'assistant-text', partial: true, text: 'מתחיל לבדוק את הקוד. ' });
  speak.onChatEvent('s1', { kind: 'assistant-text', partial: true, text: 'הנה מה שמצאתי' });
  speak.onChatEvent('s1', { kind: 'assistant-text', text: 'מתחיל לבדוק את הקוד. הנה מה שמצאתי' }); // persisted copy of the same
  speak.onChatEvent('s1', { kind: 'tool-use', name: 'Read' });
  speak.onChatEvent('s1', { kind: 'assistant-text', text: 'תשובה שלמה בלי דלתאות.' }); // no deltas preceded it
  speak.onChatEvent('s1', { kind: 'result', text: '' });
  await tick();
  expect(played.map((p) => [p.sessionId, p.lang, p.text])).toEqual([
    ['s1', 'he', 'מתחיל לבדוק את הקוד.'],
    ['s1', 'he', 'הנה מה שמצאתי'],
    ['s1', 'he', 'תשובה שלמה בלי דלתאות.'],
  ]);
  expect(speak.getSpeakState().active).toBe(true);
  expect(speak.getSpeakState().sessionId).toBe('s1');
  for (let i = 0; i < 3; i++) { await tick(); player.finish(); }
  await tick();
  expect(player.played.length).toBe(3);
  expect(dones).toEqual([1]);
  expect(speak.getSpeakState().active).toBe(false);
  globalThis.fetch = origFetch;
});

test('barge-in: stops the reading at once and calls /interrupt only while the turn still streams', async () => {
  const calls = [];
  const post = async (p) => { calls.push(p); return {}; };
  // nothing armed → nothing to do
  expect(await speak.bargeIn({ sessionId: 's1', session: { claude: { state: 'working' } }, post })).toBe(false);
  speak.armReadAloud('s1', {});
  expect(await speak.bargeIn({ sessionId: 's1', session: { claude: { state: 'idle' } }, post })).toBe(false);
  expect(calls).toEqual([]);
  expect(speak.armedSession()).toBeNull();
  speak.armReadAloud('s1', {});
  expect(await speak.bargeIn({ sessionId: 's1', session: { claude: { state: 'working' } }, post })).toBe(true);
  expect(calls).toEqual(['/sessions/s1/interrupt']);
  expect(speak.getSpeakState().active).toBe(false);
  speak.armReadAloud('s1', {});
  expect(await speak.bargeIn({ sessionId: 's1', session: { claude: { state: 'working' } }, interrupt: false, post })).toBe(false);
  expect(calls.length).toBe(1);
});

test('iOS unlock: the first tap unlocks the player once; later taps are no-ops', () => {
  const player = fakePlayer();
  speak.setPlayerFactory(() => player);
  speak.unlockAudio();
  speak.unlockAudio();
  expect(player.unlocks).toBe(2); // the fake counts raw calls; the real player makes the second a no-op
  expect(speak.getSpeakState().unlocked).toBe(true);
});

// ---- hands-free ------------------------------------------------------------------------------

test('phaseOf: one visual state — speaking beats thinking beats listening', () => {
  expect(handsfree.phaseOf({ active: false })).toBe('idle');
  expect(handsfree.phaseOf({ active: true })).toBe('listening');
  expect(handsfree.phaseOf({ active: true, waiting: true })).toBe('thinking');
  expect(handsfree.phaseOf({ active: true, waiting: true, speaking: true })).toBe('speaking');
});

test('hands-free: opens the mic in handsfree mode, shows one state in VoiceHUD, a sentence is sent to the session, a stop word ends it', async () => {
  prefs.setPrefs({ language: 'he' });
  const before = mediaCalls;
  handsfree.startHandsFree('s1');
  await tick();
  expect(mediaCalls).toBe(before + 1);
  expect(voice.getState().status).toBe('recording');
  expect(voice.getState().mode).toBe('handsfree');
  expect(voice.getState().auto).toBe(true);
  let html = render(h(VoiceHUD, {}));
  expect(html).toContain('data-hands-free="listening"');
  expect(html).toContain('מאזין…');
  expect(html).toContain('data-hands-free-stop');
  expect(html).toContain('data-voice-dock="default"'); // stage 1d: the floating box, not the centred window
  expect(html).toContain('data-hands-free-mute="off"');
  // stage 1d: mute closes the mic and keeps the conversation; unmute opens it again
  expect(handsfree.toggleHandsFreeMute()).toBe(true);
  expect(voice.getState().status).toBe('idle');
  expect(handsfree.getHandsFree().active).toBe(true);
  html = render(h(VoiceHUD, {}));
  expect(html).toContain('data-hands-free-mute="on"');
  expect(html).toContain('מושתק');
  expect(handsfree.handsFreeHooks.onIdle()).toBe('exit'); // a muted take never re-opens the mic by itself
  const mutedAt = mediaCalls;
  expect(handsfree.toggleHandsFreeMute()).toBe(false);
  await tick();
  expect(mediaCalls).toBe(mutedAt + 1);
  expect(voice.getState().status).toBe('recording');
  // the transcript path (no router, no composer): the words go to the session as-is
  posts.length = 0;
  await voice.handleTranscript('תסביר לי מה השתנה', 'handsfree');
  await tick();
  expect(posts.map((p) => [p.url, p.body])).toEqual([['/__api/sessions/s1/message', { text: 'תסביר לי מה השתנה' }]]);
  expect(handsfree.getHandsFree().phase).toBe('thinking');
  expect(handsfree.getHandsFree().lastText).toBe('תסביר לי מה השתנה');
  expect(voice.getState().status).toBe('recording'); // the mic re-opened for a barge-in
  html = render(h(VoiceHUD, {}));
  expect(html).toContain('data-hands-free="thinking"');
  expect(html).toContain('חושב…');
  // the answer streams and is spoken → 'speaking'; its end → back to listening
  const player = fakePlayer();
  speak.setPlayerFactory(() => player);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).endsWith('/__api/voice/tts') ? audioResponse('x') : origFetch(url, init));
  prefs.setPrefs({ voiceBrowserTts: false });
  configBody = { voiceEnabled: true, voiceProviders: { enabled: true, stt: ['groq'], tts: ['voice:elevenlabs'], realtime: [], telephony: false } };
  await store.loadConfig();
  // arming happened inside onTranscript; the store tap shape feeds the speaker
  speak.onChatEvent('s1', { kind: 'assistant-text', partial: true, text: 'השינוי העיקרי הוא בקובץ הזה. ' });
  await tick();
  await tick();
  expect(handsfree.getHandsFree().phase).toBe('speaking');
  expect(render(h(VoiceHUD, {}))).toContain('מדבר…');
  speak.onChatEvent('s1', { kind: 'result', text: '' });
  player.finish();
  await tick();
  expect(handsfree.getHandsFree().phase).toBe('listening');
  // talking over the next answer: onSpeechStart while waiting → the reading stops
  await voice.handleTranscript('ועוד שאלה', 'handsfree');
  await tick();
  expect(handsfree.getHandsFree().phase).toBe('thinking');
  speak.onChatEvent('s1', { kind: 'assistant-text', partial: true, text: 'תשובה ארוכה שתיקטע באמצע. ' });
  await tick();
  await tick();
  expect(speak.getSpeakState().active).toBe(true);
  handsfree.handsFreeHooks.onSpeechStart();
  await tick();
  expect(speak.getSpeakState().active).toBe(false);
  expect(handsfree.getHandsFree().phase).toBe('listening');
  // a stop word ends the mode; the HUD is gone and the mic is closed
  await voice.handleTranscript('עצור', 'handsfree');
  expect(handsfree.getHandsFree().active).toBe(false);
  expect(voice.getState().status).toBe('idle');
  expect(render(h(VoiceHUD, {}))).toBe('');
  expect(handsfree.lastHandsFreeEnd().reason).toBe('stop');
  globalThis.fetch = origFetch;
  prefs.setPrefs({ language: 'en' });
});

test('hands-free: a quiet take re-opens the mic; the idle hook says exit once nobody spoke for the idle window; the button toggles', async () => {
  handsfree.startHandsFree('s1');
  await tick();
  expect(handsfree.handsFreeHooks.onIdle()).toBe('again');
  expect(render(h(HandsFreeButton, { sessionId: 's1' })) || '').not.toContain('data-hands-free="on"'); // pref off → no button at all
  prefs.setPrefs({ voiceReadAloud: true });
  configBody = { voiceEnabled: true, voiceProviders: { enabled: true, stt: ['groq'], tts: ['voice:elevenlabs'], realtime: [], telephony: false } };
  await store.loadConfig();
  expect(render(h(HandsFreeButton, { sessionId: 's1' }))).toContain('data-hands-free="on"');
  handsfree.toggleHandsFree('s1');
  expect(handsfree.getHandsFree().active).toBe(false);
  expect(render(h(HandsFreeButton, { sessionId: 's1' }))).toContain('data-hands-free="off"');
  prefs.setPrefs({ voiceReadAloud: false });
});
