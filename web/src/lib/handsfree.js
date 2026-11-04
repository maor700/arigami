// Hands-free (stage 1b, docs/VOICE.md): listen → transcribe → send to the session → the answer is read aloud →
// listen again. The mic stays open while the agent thinks/speaks so a word from the person is a barge-in.
// Only reachable when STT, a TTS source and "read aloud" all exist — otherwise VoiceHUD is unchanged.
import { useSyncExternalStore } from 'react';
import { api } from './api.js';
import { startRecording, cancel, setHandsFreeHooks, isStopWord } from './voice.js';
import { armReadAloud, stopSpeaking, bargeIn, unlockAudio } from './speak.js';

export const HANDS_FREE_IDLE_MS = 120_000; // nobody said anything for this long → exit
const MAX_ERRORS = 3;

let state = { active: false, phase: 'idle', sessionId: null, lastText: '', note: '', since: 0 };
const listeners = new Set();
function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getHandsFree = () => state;
export function useHandsFree() {
  return useSyncExternalStore(subscribe, getHandsFree, getHandsFree);
}

// The one visual state (pure): speaking wins over thinking wins over listening.
export function phaseOf({ active, waiting, speaking }) {
  if (!active) return 'idle';
  if (speaking) return 'speaking';
  if (waiting) return 'thinking';
  return 'listening';
}

let waiting = false; // a message was sent and its turn has not finished speaking
let speaking = false;
let lastActivity = 0;
let errors = 0;
let lastEnd = null;
export const lastHandsFreeEnd = () => lastEnd;
const sync = () => set({ phase: phaseOf({ active: state.active, waiting, speaking }) });

const listen = () => startRecording({ mode: 'handsfree', auto: true });

export const handsFreeHooks = {
  // the person finished a sentence: a stop word ends the mode, anything else goes to the session as-is
  async onTranscript(text) {
    if (!state.active) return;
    lastActivity = Date.now();
    errors = 0;
    if (isStopWord(text)) { stopHandsFree('stop'); return; }
    const sid = state.sessionId;
    set({ lastText: text, note: '' });
    waiting = true;
    speaking = false;
    sync();
    await bargeIn({ sessionId: sid }); // still speaking/streaming the previous answer → drop it first
    if (!state.active) return;
    armReadAloud(sid, {
      onFirstAudio: () => { speaking = true; sync(); },
      onDone: () => { waiting = false; speaking = false; sync(); },
      onProblem: (p) => set({ note: p?.error || (p?.needs_setup ? 'needs_setup' : p?.disabled ? 'disabled' : p?.budget ? 'budget' : '') }),
    });
    try {
      await api.post(`/sessions/${sid}/message`, { text });
    } catch (e) {
      waiting = false;
      set({ note: String(e?.message || e) });
      sync();
    }
    if (state.active) listen(); // mic back on at once: the next word is a barge-in or the next message
  },
  // the person started talking over the answer → stop playback now, interrupt the turn if it still streams
  onSpeechStart() {
    if (!state.active) return;
    lastActivity = Date.now();
    if (waiting || speaking) bargeIn({ sessionId: state.sessionId });
  },
  // a quiet take ended with nothing said: keep listening, or leave after a long silence
  onIdle() {
    if (!state.active) return 'exit';
    if (!waiting && !speaking && Date.now() - lastActivity >= HANDS_FREE_IDLE_MS) { stopHandsFree('silence'); return 'exit'; }
    return 'again';
  },
  onError(msg) {
    if (!state.active) return 'exit';
    set({ note: String(msg || '') });
    if (++errors >= MAX_ERRORS) { stopHandsFree('error'); return 'exit'; }
    return 'again';
  },
};

/** One line under the hands-free HUD (the call fallback uses it). */
export function setHandsFreeNote(note) { if (state.active) set({ note: String(note || '') }); }

export function startHandsFree(sessionId) {
  if (!sessionId) return;
  if (state.active) stopHandsFree('restart');
  unlockAudio();
  waiting = false;
  speaking = false;
  errors = 0;
  lastActivity = Date.now();
  setHandsFreeHooks(handsFreeHooks);
  set({ active: true, sessionId, lastText: '', note: '', since: Date.now() });
  sync();
  listen();
}

export function stopHandsFree(reason = 'stop') {
  if (!state.active) return;
  setHandsFreeHooks(null);
  cancel();
  stopSpeaking();
  waiting = false;
  speaking = false;
  lastEnd = { reason, at: Date.now() };
  set({ active: false, phase: 'idle' });
}

export function toggleHandsFree(sessionId) {
  if (state.active && (!sessionId || state.sessionId === sessionId)) stopHandsFree('stop');
  else startHandsFree(sessionId);
}

if (typeof window !== 'undefined') window.__arigamiHandsFree = { startHandsFree, stopHandsFree, toggleHandsFree, getHandsFree, hooks: handsFreeHooks };
