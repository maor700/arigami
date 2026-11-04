// Call mode (stage 1c, docs/VOICE.md): a WebRTC call with the realtime voice clerk — the mic goes up, the clerk's
// voice comes down, its tool calls are run by the host and the transcript is posted back. Only reachable when a
// realtime provider is connected (config.voiceProviders.realtime); otherwise nothing here is ever imported into the UI.
import { useSyncExternalStore } from 'react';
import { api } from './api.js';
import { getPrefs } from './prefs.js';
import { getState as storeState } from './store.js';
import { unlockAudio, handsFreeAvailable } from './speak.js';
import { startHandsFree, setHandsFreeNote } from './handsfree.js';
import { toastError } from './toast.js';
import { t as tr } from './i18n.js';

export const callAvailable = (config) => {
  const vp = config?.voiceProviders;
  return !!vp && vp.enabled !== false && Array.isArray(vp.realtime) && vp.realtime.length > 0;
};

let state = { active: false, phase: 'idle', sessionId: null, callId: null, muted: false, lastText: '', note: '', tool: '', since: 0 };
const listeners = new Set();
function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getCall = () => state;
export function useCall() {
  return useSyncExternalStore(subscribe, getCall, getCall);
}

// Browser pieces, replaceable for tests (a fake RTCPeerConnection, no real mic).
let deps = null;
const defaultDeps = () => ({
  RTCPeerConnection: typeof RTCPeerConnection === 'function' ? RTCPeerConnection : null,
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  fetchImpl: (...a) => fetch(...a),
  audio: () => { const a = new Audio(); a.autoplay = true; a.setAttribute('playsinline', ''); return a; },
});
export function setCallDeps(d) { deps = d ? { ...defaultDeps(), ...d } : null; }
const D = () => deps || (deps = defaultDeps());

const TRANSCRIPT_DEBOUNCE_MS = 400;
let live = null; // { pc, dc, stream, audio, turns, posted, timer, connected }
let lastEnd = null;
export const lastCallEnd = () => lastEnd;

const micLang = () => {
  const p = getPrefs();
  if (p.voiceLang && p.voiceLang !== 'auto') return String(p.voiceLang).slice(0, 2);
  if (p.language === 'he' || p.language === 'en') return p.language;
  return String(typeof navigator !== 'undefined' ? navigator.language || 'en' : 'en').slice(0, 2);
};

const noteOf = (r) => (r?.needs_setup ? 'needs_setup' : r?.disabled ? 'disabled' : r?.budget ? 'budget' : r?.error || 'failed');

/** Start a call for `sessionId`; a failed connection falls back to the 1b hands-free mode with one line. */
export async function startCall(sessionId) {
  if (!sessionId) return false;
  if (state.active) await hangUp('restart');
  unlockAudio();
  set({ active: true, phase: 'connecting', sessionId, callId: null, muted: false, lastText: '', note: '', tool: '', since: Date.now() });
  const d = D();
  let mint = null;
  try {
    mint = await api.post('/voice/realtime/session', { sessionId, lang: micLang() });
    if (!mint?.ok) throw new Error(noteOf(mint));
    if (!d.RTCPeerConnection) throw new Error('no WebRTC in this browser');
    const pc = new d.RTCPeerConnection();
    const audio = d.audio();
    const l = { pc, dc: null, stream: null, audio, turns: [], posted: 0, timer: null, connected: false, sessionId, callId: mint.callId };
    live = l;
    set({ callId: mint.callId });
    pc.ontrack = (e) => { try { audio.srcObject = e.streams?.[0] || null; audio.play?.()?.catch?.(() => {}); } catch { /* ignore */ } };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') { l.connected = true; return; }
      if (s === 'failed' || s === 'closed' || s === 'disconnected') { if (live === l && state.active) hangUp(l.connected ? 'lost' : 'failed'); }
    };
    l.stream = await d.getUserMedia({ audio: true });
    for (const tr of l.stream.getTracks?.() || []) pc.addTrack(tr, l.stream);
    const dc = pc.createDataChannel('oai-events');
    l.dc = dc;
    dc.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* not JSON */ } };
    dc.onopen = () => { if (live === l) set({ phase: 'listening' }); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await d.fetchImpl(mint.callsUrl, { method: 'POST', body: offer.sdp, headers: { Authorization: `Bearer ${mint.clientSecret}`, 'Content-Type': 'application/sdp' } });
    if (!res.ok) throw new Error(`SDP answer ${res.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    return true;
  } catch (e) {
    const note = String(e?.message || e);
    const l = live;
    live = null;
    teardown(l);
    if (l?.callId) api.post('/voice/realtime/end', { sessionId, callId: l.callId, seconds: 0, reason: 'failed' }).catch(() => {});
    set({ active: false, phase: 'idle', callId: null, note });
    lastEnd = { reason: 'failed', note, at: Date.now(), seconds: 0 };
    fallback(sessionId, note);
    return false;
  }
}

// The one line the person gets when the call never connected: hands-free (1b) if it exists, else a toast.
function fallback(sessionId, note) {
  const line = NOTE_TEXT[note] ? tr(NOTE_TEXT[note]) : tr('dialogs.call.failed', { why: note });
  if (handsFreeAvailable(storeState().config, getPrefs())) {
    startHandsFree(sessionId);
    setHandsFreeNote(`${line} ${tr('dialogs.call.fallback')}`);
  } else toastError(line);
}
const NOTE_TEXT = { needs_setup: 'dialogs.readAloudNeedsSetup', disabled: 'dialogs.readAloudDisabled', budget: 'dialogs.readAloudBudget' };

function teardown(l) {
  if (!l) return;
  if (l.timer) { clearTimeout(l.timer); l.timer = null; }
  try { l.dc?.close?.(); } catch { /* ignore */ }
  try { for (const tr of l.stream?.getTracks?.() || []) tr.stop?.(); } catch { /* ignore */ }
  try { l.pc?.close?.(); } catch { /* ignore */ }
  try { if (l.audio) { l.audio.srcObject = null; l.audio.pause?.(); } } catch { /* ignore */ }
}

const send = (msg) => { const dc = live?.dc; if (dc && (dc.readyState === 'open' || dc.readyState === undefined)) dc.send(JSON.stringify(msg)); };

// Server events over the data channel (the model's own VAD handles barge-in: a word from the person cuts its audio).
export function onEvent(ev) {
  const l = live;
  if (!l || !ev || typeof ev.type !== 'string') return;
  switch (ev.type) {
    case 'input_audio_buffer.speech_started':
      if (state.phase !== 'tool') set({ phase: 'listening' });
      return;
    case 'output_audio_buffer.started':
      set({ phase: 'speaking' });
      return;
    case 'output_audio_buffer.stopped':
    case 'output_audio_buffer.cleared':
      if (state.phase === 'speaking') set({ phase: 'listening' });
      return;
    case 'conversation.item.input_audio_transcription.completed':
      addTurn(l, { role: 'user', text: ev.transcript, id: ev.item_id });
      return;
    case 'response.output_audio_transcript.done':
      addTurn(l, { role: 'assistant', text: ev.transcript, id: ev.item_id });
      return;
    case 'response.function_call_arguments.done':
      runTool(l, ev);
      return;
    case 'error':
      set({ note: String(ev.error?.message || 'error') });
      return;
    default:
  }
}

function addTurn(l, turn) {
  const text = String(turn.text || '').trim();
  if (!text) return;
  l.turns.push({ role: turn.role, text, ...(turn.id ? { id: String(turn.id) } : {}) });
  set({ lastText: text });
  if (!l.timer) l.timer = setTimeout(() => { l.timer = null; flushTranscript(l); }, TRANSCRIPT_DEBOUNCE_MS);
}
function flushTranscript(l) {
  const turns = l.turns.slice(l.posted);
  if (!turns.length) return Promise.resolve();
  l.posted = l.turns.length;
  return api.post('/voice/realtime/transcript', { sessionId: l.sessionId, callId: l.callId, turns }).catch(() => { l.posted -= turns.length; });
}

// A tool call: the host runs it with the owner's authority; the result goes back as the function output.
async function runTool(l, ev) {
  const name = String(ev.name || '');
  let args = {};
  try { args = ev.arguments ? JSON.parse(ev.arguments) : {}; } catch { args = {}; }
  set({ phase: 'tool', tool: name });
  let out;
  try {
    const r = await api.post('/voice/realtime/tool', { sessionId: l.sessionId, callId: l.callId, name, args });
    out = r?.ok ? r.result : { error: r?.error || 'tool failed' };
  } catch (e) {
    out = { error: String(e?.message || e) };
  }
  if (live !== l) return;
  send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(out) } });
  send({ type: 'response.create' });
  if (state.phase === 'tool') set({ phase: 'listening', tool: '' });
}

export function toggleMute() {
  const l = live;
  if (!l) return false;
  const muted = !state.muted;
  for (const tr of l.stream?.getTracks?.() || []) tr.enabled = !muted;
  set({ muted });
  return muted;
}

/** End the call: close everything, post the transcript's tail and the duration (the host clamps it). */
export async function hangUp(reason = 'hangup') {
  const l = live;
  if (!l && !state.active) return;
  live = null;
  const seconds = Math.max(0, Math.round((Date.now() - state.since) / 1000));
  const { sessionId, callId } = state;
  set({ active: false, phase: 'idle', tool: '', muted: false });
  teardown(l);
  lastEnd = { reason, at: Date.now(), seconds };
  if (!callId) return;
  try { await flushTranscript(l); } catch { /* best effort */ }
  await api.post('/voice/realtime/end', { sessionId, callId, seconds, reason }).catch(() => {});
}

export function toggleCall(sessionId) {
  if (state.active && (!sessionId || state.sessionId === sessionId)) return hangUp('hangup');
  return startCall(sessionId);
}

if (typeof window !== 'undefined') window.__arigamiCall = { startCall, hangUp, toggleCall, toggleMute, getCall, onEvent, setCallDeps, callAvailable };
