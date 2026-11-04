// Call mode (stage 1c, docs/VOICE.md): a live call with the realtime voice clerk — the mic goes up, the clerk's voice comes
// down, its tool calls are run by the host and the transcript is posted back. The host's mint names the transport
// (OpenAI over WebRTC, Gemini Live over a WebSocket). Only reachable when a realtime provider is connected
// (config.voiceProviders.realtime); otherwise nothing here is ever reached from the UI.
import { useSyncExternalStore } from 'react';
import { api } from './api.js';
import { getPrefs } from './prefs.js';
import { getState as storeState } from './store.js';
import { unlockAudio, handsFreeAvailable } from './speak.js';
import { startHandsFree, setHandsFreeNote } from './handsfree.js';
import { toastError } from './toast.js';
import { t as tr } from './i18n.js';
import { connectOpenAI } from './call-openai.js';
import { connectGemini } from './call-gemini.js';

export const callAvailable = (config) => {
  const vp = config?.voiceProviders;
  return !!vp && vp.enabled !== false && Array.isArray(vp.realtime) && vp.realtime.length > 0;
};

let state = { active: false, phase: 'idle', sessionId: null, callId: null, provider: null, muted: false, lastText: '', note: '', tool: '', since: 0 };
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

// Browser pieces, replaceable for tests (a fake RTCPeerConnection / WebSocket, no real mic or speaker).
let deps = null;
const defaultDeps = () => ({
  RTCPeerConnection: typeof RTCPeerConnection === 'function' ? RTCPeerConnection : null,
  WebSocket: typeof WebSocket === 'function' ? WebSocket : null,
  AudioContext: typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext || null : null,
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  fetchImpl: (...a) => fetch(...a),
  audio: () => { const a = new Audio(); a.autoplay = true; a.setAttribute('playsinline', ''); return a; },
});
export function setCallDeps(d) { deps = d ? { ...defaultDeps(), ...d } : null; }
const D = () => deps || (deps = defaultDeps());
const TRANSPORTS = { 'openai-webrtc': connectOpenAI, 'gemini-ws': connectGemini };

const TRANSCRIPT_DEBOUNCE_MS = 400;
let live = null; // { sessionId, callId, conn, turns, timer }
let lastEnd = null;
export const lastCallEnd = () => lastEnd;

const micLang = () => {
  const p = getPrefs();
  if (p.voiceLang && p.voiceLang !== 'auto') return String(p.voiceLang).slice(0, 2);
  if (p.language === 'he' || p.language === 'en') return p.language;
  return String(typeof navigator !== 'undefined' ? navigator.language || 'en' : 'en').slice(0, 2);
};
const noteOf = (r) => (r?.needs_setup ? 'needs_setup' : r?.disabled ? 'disabled' : r?.budget ? 'budget' : r?.error || 'failed');

// What a transport reports back; `only` = change the phase only while it is that one (a tool run is never overwritten by 'listening').
const hooksFor = (l) => ({
  phase(p, only) {
    if (live !== l) return;
    if (only && state.phase !== only) return;
    if (p === 'listening' && state.phase === 'tool') return;
    set({ phase: p });
  },
  turn(t) { if (live === l) addTurn(l, t); },
  tool(ev) { if (live === l) runTool(l, ev); },
  error(msg) { if (live === l) set({ note: String(msg || 'error') }); },
  lost(connected) { if (live === l && state.active) hangUp(connected ? 'lost' : 'failed'); },
});

/** Start a call for `sessionId`; a failed connection falls back to the 1b hands-free mode with one line. */
export async function startCall(sessionId) {
  if (!sessionId) return false;
  if (state.active) await hangUp('restart');
  unlockAudio();
  set({ active: true, phase: 'connecting', sessionId, callId: null, provider: null, muted: false, lastText: '', note: '', tool: '', since: Date.now() });
  const l = { sessionId, callId: null, conn: null, turns: [], timer: null };
  live = l;
  try {
    const mint = await api.post('/voice/realtime/session', { sessionId, lang: micLang() });
    if (!mint?.ok) throw new Error(noteOf(mint));
    const connect = TRANSPORTS[mint.transport];
    if (!connect) throw new Error(`unknown transport ${mint.transport}`);
    l.callId = mint.callId;
    set({ callId: mint.callId, provider: mint.provider || null });
    l.conn = await connect({ mint, deps: D(), hooks: hooksFor(l) });
    if (live !== l) { l.conn.close(); return false; } // hung up while connecting
    if (state.phase === 'connecting') set({ phase: 'listening' });
    return true;
  } catch (e) {
    const note = String(e?.message || e);
    if (live === l) live = null;
    try { l.conn?.close(); } catch { /* ignore */ }
    if (l.callId) api.post('/voice/realtime/end', { sessionId, callId: l.callId, seconds: 0, reason: 'failed' }).catch(() => {});
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

// A turn with a known id grows in place (Gemini streams transcript pieces); the host dedupes by id too.
function addTurn(l, turn) {
  const text = String(turn.text || '').trim();
  if (!text) return;
  const id = turn.id ? String(turn.id) : '';
  const cur = id ? l.turns.find((x) => x.id === id) : null;
  if (cur) { cur.text = text; cur.sent = false; }
  else l.turns.push({ role: turn.role, text, ...(id ? { id } : {}), sent: false });
  set({ lastText: text });
  if (!l.timer) l.timer = setTimeout(() => { l.timer = null; flushTranscript(l); }, TRANSCRIPT_DEBOUNCE_MS);
}
function flushTranscript(l) {
  const pending = l.turns.filter((x) => !x.sent);
  if (!pending.length) return Promise.resolve();
  for (const x of pending) x.sent = true;
  const turns = pending.map(({ role, text, id }) => ({ role, text, ...(id ? { id } : {}) }));
  return api.post('/voice/realtime/transcript', { sessionId: l.sessionId, callId: l.callId, turns }).catch(() => { for (const x of pending) x.sent = false; });
}

// A tool call: the host runs it with the owner's authority; the result goes back through the transport.
async function runTool(l, ev) {
  const name = String(ev.name || '');
  set({ phase: 'tool', tool: name });
  let out;
  try {
    const r = await api.post('/voice/realtime/tool', { sessionId: l.sessionId, callId: l.callId, name, args: ev.args || {} });
    out = r?.ok ? r.result : { error: r?.error || 'tool failed' };
  } catch (e) {
    out = { error: String(e?.message || e) };
  }
  if (live !== l || !l.conn) return;
  l.conn.toolResult(ev, out);
  if (state.phase === 'tool') set({ phase: 'listening', tool: '' });
}

/** OpenAI data-channel events (tests and the verification hook feed them here). */
export function onEvent(ev) { live?.conn?.onEvent?.(ev); }

export function toggleMute() {
  const l = live;
  if (!l?.conn) return false;
  const muted = !state.muted;
  l.conn.mute(muted);
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
  if (l?.timer) { clearTimeout(l.timer); l.timer = null; }
  try { l?.conn?.close(); } catch { /* ignore */ }
  lastEnd = { reason, at: Date.now(), seconds };
  if (!callId) return;
  if (l) { try { await flushTranscript(l); } catch { /* best effort */ } }
  await api.post('/voice/realtime/end', { sessionId, callId, seconds, reason }).catch(() => {});
}

export function toggleCall(sessionId) {
  if (state.active && (!sessionId || state.sessionId === sessionId)) return hangUp('hangup');
  return startCall(sessionId);
}

if (typeof window !== 'undefined') window.__arigamiCall = { startCall, hangUp, toggleCall, toggleMute, getCall, onEvent, setCallDeps, callAvailable };
