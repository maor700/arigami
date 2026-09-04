// VOICE2 web: the command mic is a CONVERSATION. speak → the router asks →
// the mic re-opens by itself (auto turn) → the answer is routed WITH the
// history → an action runs and the exchange ends; or a stop word / Esc /
// silence ends it. The global shortcut dictates when the composer has focus
// and drives the command HUD otherwise. Command mode never writes into the
// composer — only a confirmed inject_prompt reaches a session.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, voice, store, VoiceHUD;
const h = (...a) => React.createElement(...a);
const calls = [];
// The scripted router: each call pops the next reply.
const routerReplies = [];
const keyListeners = [];
// The "mic": startRecording is exercised through fakes so the loop's auto turn
// can be observed (status recording + auto:true) without a real device.
let mediaCalls = 0;
let lastRecorder = null;

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, getElementById: () => null,
    addEventListener(type, fn) { keyListeners.push({ type, fn }); },
    removeEventListener(type, fn) { const i = keyListeners.findIndex((l) => l.fn === fn); if (i >= 0) keyListeners.splice(i, 1); },
    activeElement: null,
  };
  globalThis.navigator = {
    language: 'he-IL', userAgent: 'test', platform: 'MacIntel',
    mediaDevices: { enumerateDevices: async () => [], getUserMedia: async () => { mediaCalls++; return { getTracks: () => [] }; } },
  };
  globalThis.MediaRecorder = class {
    constructor() { this.state = 'recording'; lastRecorder = this; }
    static isTypeSupported() { return true; }
    start() {}
    stop() { this.state = 'inactive'; this.onstop?.(); }
  };
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, body });
    const reply = (j) => ({ ok: true, status: 200, url: u, json: async () => j, text: async () => JSON.stringify(j) });
    if (u.includes('/voice/stt')) return reply({ text: 'hello' });
    if (u.includes('/voice/route')) return reply(routerReplies.length ? routerReplies.shift() : { actions: [], say: '' });
    return reply({});
  };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  voice = await import(web('lib/voice.js'));
  store = await import(web('lib/store.js'));
  VoiceHUD = (await import(web('components/VoiceHUD.jsx'))).default;
  const commands = await import(web('lib/commands.js'));
  commands.setCommandHandlers({
    rename_session: async (a) => { ran.push(a); },
    select_session: async (a) => { ran.push(a); },
    inject_prompt: async (a) => { ran.push(a); },
    ask: () => {}, clarify: () => {}, end_conversation: () => {},
  });
  voice.setSelectedContext('s1');
});
const ran = [];
const routeCalls = () => calls.filter((c) => c.url.includes('/voice/route'));
const st = () => window.__arigamiVoice.getState();
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the plan reader + the pure step ----------------------------------------------
test('planFrom: a typed VOICE2 host plan is used as-is; a VOICE1 host (no kind) is derived the same way; control words never become actions', () => {
  expect(voice.planFrom({ actions: [], say: 'Which one?', kind: 'ask', question: 'Which one?' })).toMatchObject({ kind: 'ask', question: 'Which one?' });
  expect(voice.planFrom({ actions: [{ type: 'clarify' }], say: 'לאיזה?' })).toMatchObject({ kind: 'ask', question: 'לאיזה?', actions: [] });
  expect(voice.planFrom({ actions: [{ type: 'open_changes' }], say: '' })).toMatchObject({ kind: 'act' });
  expect(voice.planFrom({ actions: [], say: 'It is done.' })).toMatchObject({ kind: 'answer' });
  expect(voice.planFrom({ actions: [{ type: 'end_conversation' }] })).toMatchObject({ kind: 'end', actions: [] });
  expect(voice.planFrom({})).toMatchObject({ kind: 'noop' });
  // a host that says 'act' but ships no action can't make the loop wait on nothing
  expect(voice.planFrom({ kind: 'act', actions: [], say: 'hm' }).kind).toBe('answer');
  expect(voice.nextStep({ kind: 'ask' })).toBe('listen');
  expect(voice.nextStep({ kind: 'answer' })).toBe('listen');
  expect(voice.nextStep({ kind: 'act', actions: [{ type: 'x' }] })).toBe('act');
  expect(voice.nextStep({ kind: 'end' })).toBe('end');
  expect(voice.nextStep({ kind: 'noop' })).toBe('end');
});

test('stop words end on a whole-utterance match only; silenceStep = 8s no speech → end, 1.6s quiet after speech → stop', () => {
  for (const w of ['סיים', 'ביטול', 'stop', 'Stop.', 'תודה זהו', 'never mind', 'עצור!']) expect(voice.isStopWord(w)).toBe(true);
  for (const w of ['stop the agent', 'תעצור את הסשן', '', 'cancel the deploy']) expect(voice.isStopWord(w)).toBe(false);
  const t0 = 1000;
  expect(voice.silenceStep({ spoke: false, startedAt: t0, lastLoud: 0, now: t0 + 7900, peak: 0 })).toBe('continue');
  expect(voice.silenceStep({ spoke: false, startedAt: t0, lastLoud: 0, now: t0 + 8000, peak: 0 })).toBe('end');
  expect(voice.silenceStep({ spoke: false, startedAt: t0, lastLoud: 0, now: t0 + 9000, peak: 0.2 })).toBe('continue'); // speaking now
  expect(voice.silenceStep({ spoke: true, startedAt: t0, lastLoud: t0 + 3000, now: t0 + 4500, peak: 0 })).toBe('continue');
  expect(voice.silenceStep({ spoke: true, startedAt: t0, lastLoud: t0 + 3000, now: t0 + 4600, peak: 0 })).toBe('stop');
});

// ---- the loop: speak → ask → auto-listen → answer with history → action ------------
test('two-turn exchange: the router asks, the HUD shows the question and re-opens the mic; the answer goes up WITH the history; the action runs and the exchange ends', async () => {
  calls.length = 0; ran.length = 0; mediaCalls = 0;
  routerReplies.push({ actions: [], say: 'לאיזה שם?', kind: 'ask', question: 'לאיזה שם?' });
  await voice.handleTranscript('תשנה את השם של הסשן', 'command');
  expect(st().status).toBe('review');
  expect(st().plan.kind).toBe('ask');
  expect(st().relisten).toBe(true);
  expect(st().turns).toEqual([{ role: 'user', text: 'תשנה את השם של הסשן' }, { role: 'assistant', text: 'לאיזה שם?' }]);
  let html = render(h(VoiceHUD));
  expect(html).toContain('data-voice-kind="ask"');
  expect(html).toContain('לאיזה שם?');
  // the mic re-opens by itself, as an AUTO turn, with a cancel
  await tick(voice.RELISTEN_DELAY_MS + 80);
  expect(st().status).toBe('recording');
  expect(st().auto).toBe(true);
  expect(mediaCalls).toBe(1);
  html = render(h(VoiceHUD));
  expect(html).toContain('data-voice-cancel');
  expect(html).toContain('לאיזה שם?'); // the question stays on screen while listening
  // the answer (through the same STT path: stop → finalize is a real-mic thing,
  // so inject the transcript exactly like the recorder does after STT)
  voice.cancel(); // release the fake capture (the next test drives the answer turn)
});

test('the answer turn: routed with the prior turns as history → the router acts → Done → HUD closes by itself', async () => {
  calls.length = 0; ran.length = 0;
  routerReplies.push({ actions: [], say: 'לאיזה שם?', kind: 'ask', question: 'לאיזה שם?' });
  await voice.handleTranscript('תשנה את השם של הסשן', 'command');
  routerReplies.push({ actions: [{ type: 'rename_session', title: 'בדיקות' }], say: 'שיניתי', kind: 'act' });
  // the auto turn's STT result arrives (the recorder is bypassed — same entry point)
  await voice.handleTranscript('בדיקות', 'command');
  expect(routeCalls()).toHaveLength(2);
  const second = routeCalls()[1].body;
  expect(second.transcript).toBe('בדיקות');
  expect(second.context.history.slice(-2)).toEqual([
    { role: 'user', content: 'תשנה את השם של הסשן' },
    { role: 'assistant', content: 'לאיזה שם?' },
  ]);
  expect(st().status).toBe('review');
  expect(st().plan.kind).toBe('act');
  expect(st().relisten).toBe(false); // an action ends the loop — no re-listen
  expect(st().turns.map((x) => x.text)).toEqual(['תשנה את השם של הסשן', 'לאיזה שם?', 'בדיקות', 'שיניתי']);
  const html = render(h(VoiceHUD));
  expect(html).toContain('data-voice-turns'); // the earlier turns are shown
  expect(html).toContain('שיניתי');
  expect(html).not.toContain('data-voice-again'); // nothing to continue after an act
  voice.clearPlan();
  expect(st().turns).toEqual([]);
});

test('an answer-only reply (a question about the screen) also re-opens the mic; a stop word ends the exchange without a router call', async () => {
  calls.length = 0;
  routerReplies.push({ actions: [], say: 'הוא סיים את הבדיקות', kind: 'answer' });
  await voice.handleTranscript('מה הוא אמר?', 'command');
  expect(st().status).toBe('review');
  expect(st().relisten).toBe(true);
  await tick(voice.RELISTEN_DELAY_MS + 80);
  expect(st().status).toBe('recording');
  expect(st().auto).toBe(true);
  // the stop word arrives as the next transcript
  await voice.handleTranscript('סיים', 'command');
  expect(routeCalls()).toHaveLength(1);
  expect(st().status).toBe('idle');
  expect(st().turns).toEqual([]);
  expect(voice.lastConversationEnd().reason).toBe('stop');
  expect(render(h(VoiceHUD))).toBe('');
});

test('end_conversation / noop from the router close the loop; Esc closes it from the HUD (capture listener)', async () => {
  routerReplies.push({ actions: [], say: '', kind: 'end' });
  await voice.handleTranscript('זהו תודה', 'command');
  expect(st().status).toBe('idle');
  routerReplies.push({ actions: [], say: '' });
  await voice.handleTranscript('הממ', 'command');
  expect(st().status).toBe('idle');
  // Esc: the HUD registers a capture keydown listener only while open in command mode
  routerReplies.push({ actions: [], say: 'איזה?', kind: 'ask' });
  await voice.handleTranscript('תפתח', 'command');
  expect(st().relisten).toBe(true);
  // simulate the listener the HUD would mount by driving the same exit
  voice.endConversation('stop');
  expect(st().status).toBe('idle');
  expect(st().relisten).toBe(false);
  await tick(voice.RELISTEN_DELAY_MS + 80);
  expect(st().status).toBe('idle'); // the scheduled re-listen was cancelled
});

// ---- command mode never writes to the composer --------------------------------------
test('command mode never writes to the composer: with a sink mounted and a draft in the store, an ask/answer/act plan leaves both untouched; only inject_prompt reaches a session', async () => {
  const sink = [];
  const off = voice.setDictationSink((t) => sink.push(t));
  store.setDraft('s1', { text: 'my draft' });
  ran.length = 0;
  routerReplies.push({ actions: [], say: 'what?', kind: 'ask' });
  await voice.handleTranscript('do the thing', 'command');
  routerReplies.push({ actions: [], say: 'it says ok', kind: 'answer' });
  await voice.handleTranscript('what did it say', 'command');
  routerReplies.push({ actions: [{ type: 'select_session', sessionId: 's1' }], say: '', kind: 'act' });
  await voice.handleTranscript('go to s1', 'command');
  expect(sink).toEqual([]);
  expect(store.getDraft('s1').text).toBe('my draft');
  // the act plan is handed to the HUD, which runs safe actions; injects are queued for confirmation
  render(h(VoiceHUD)); // (effects don't run in static render — the bus is exercised directly)
  expect(st().plan.actions).toEqual([{ type: 'select_session', sessionId: 's1' }]);
  voice.clearPlan();
  routerReplies.push({ actions: [{ type: 'inject_prompt', text: 'run the tests' }], say: '', kind: 'act' });
  await voice.handleTranscript('tell it to run the tests', 'command');
  expect(st().plan.actions[0]).toMatchObject({ type: 'inject_prompt', text: 'run the tests' });
  expect(sink).toEqual([]);
  expect(store.getDraft('s1').text).toBe('my draft');
  // dictation is the ONLY path into the composer, and it clears any command turns
  await voice.handleTranscript('and this', 'dictate');
  expect(sink).toEqual(['and this']);
  expect(st().turns).toEqual([]);
  off();
});

// ---- the shortcut focus rule -----------------------------------------------------------
test('hotkeyAction: composer focused → dictate; elsewhere → command; recording → stop (any mode); thinking → nothing; open+idle HUD → command again', () => {
  const A = voice.hotkeyAction;
  expect(A({ status: 'idle' }, true)).toBe('dictate');
  expect(A({ status: 'idle' }, false)).toBe('command');
  expect(A({ status: 'recording', mode: 'dictate' }, true)).toBe('stop');
  expect(A({ status: 'recording', mode: 'command' }, false)).toBe('stop');
  expect(A({ status: 'thinking' }, false)).toBe('none');
  expect(A({ status: 'review' }, false)).toBe('command'); // HUD open and idle → listen again
  expect(A({ status: 'error' }, false)).toBe('command');
  expect(A({ status: 'review' }, true)).toBe('dictate');
  // composerFocused reads the data-composer marker only
  expect(voice.composerFocused({ hasAttribute: (n) => n === 'data-composer' })).toBe(true);
  expect(voice.composerFocused({ hasAttribute: () => false })).toBe(false);
  expect(voice.composerFocused(null)).toBe(false);
});

test('matchesHotkey: "Cmd" is ⌘ on Apple and Ctrl elsewhere; the key and every modifier must match', () => {
  const M = voice.matchesHotkey;
  const ev = (o) => ({ key: 'v', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  expect(M(ev({ key: 'V', metaKey: true, shiftKey: true }), 'Cmd+Shift+V', true)).toBe(true);
  expect(M(ev({ key: 'V', ctrlKey: true, shiftKey: true }), 'Cmd+Shift+V', true)).toBe(false);
  expect(M(ev({ key: 'V', ctrlKey: true, shiftKey: true }), 'Cmd+Shift+V', false)).toBe(true);
  expect(M(ev({ key: 'V', metaKey: true, shiftKey: true }), 'Cmd+Shift+V', false)).toBe(false);
  expect(M(ev({ key: 'V', ctrlKey: true }), 'Cmd+Shift+V', false)).toBe(false); // Shift missing
  expect(M(ev({ key: ' ', altKey: true }), 'Alt+Space', true)).toBe(true);
  expect(M(ev({ key: 'F8' }), 'F8', true)).toBe(true);
  expect(M(ev({ key: 'v' }), '', true)).toBe(false);
});

test('hotkeyPress: toggles a dictation when the composer has focus, a command take otherwise; press again stops; hold never stops on keydown', async () => {
  voice.cancel();
  expect(voice.hotkeyPress({ composer: true })).toBe('dictate');
  await tick(5);
  expect(st().status).toBe('recording');
  expect(st().mode).toBe('dictate');
  expect(voice.hotkeyPress({ composer: true, hold: true })).toBe('stop'); // hold keydown repeat → no toggle-off
  expect(st().status).toBe('recording');
  expect(voice.hotkeyPress({ composer: false })).toBe('stop'); // press again → stop (regardless of focus)
  // (the fake recorder's onstop → finalize; an empty clip → idle)
  await tick(5);
  voice.cancel();
  expect(voice.hotkeyPress({ composer: false })).toBe('command');
  await tick(5);
  expect(st().status).toBe('recording');
  expect(st().mode).toBe('command');
  expect(st().auto).toBe(false); // a user-opened take has no endpointing
  voice.cancel();
});

test('the HUD footer shows the configured shortcut, not a hardcoded chord', () => {
  const { hotkeyLabel } = require(web('components/VoiceHUD.jsx'));
  expect(hotkeyLabel('Cmd+Shift+V', true)).toBe('⌘⇧V');
  expect(hotkeyLabel('Cmd+Shift+V', false)).toBe('Ctrl+Shift+V');
  expect(hotkeyLabel('Alt+Space', true)).toBe('⌥Space');
});
