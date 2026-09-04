// Voice pipeline (client side): record a clip → host STT → then ONE of two
// things, decided by WHERE the mic was pressed (VOICE1):
//   mode 'dictate' — the composer mic: the transcript lands AS-IS in the chat
//                    draft (appended with a space, never auto-sent). No router.
//   mode 'command' — the rail mic / the hotkey: the host intent router turns
//                    the utterance into app actions (the pre-VOICE1 flow).
// Capture lives here; execution + confirmation live in VoiceHUD (which drives
// the command bus). Exposes a tiny external store so the mic buttons and the
// HUD share one state.
//
// Requires a secure context (localhost or HTTPS) for getUserMedia — same
// constraint as the service worker; fine when run locally on :3099.
import { useSyncExternalStore } from 'react';
import { api } from './api.js';
import { getPrefs, voiceLangFrom } from './prefs.js';

let state = {
  status: 'idle', // idle | recording | thinking | review | error
  mode: 'command', // 'dictate' | 'command' — set when a recording starts
  transcript: '',
  plan: null, // { actions, say }
  error: '',
  level: 0, // live mic input level 0..1 while recording (for the meter)
};
const listeners = new Set();
function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const getState = () => state;
export function useVoice() {
  return useSyncExternalStore(subscribe, getState, getState);
}

let rec = null;
let chunks = [];
let stream = null;
let maxTimer = null;
const MAX_RECORD_MS = 90_000; // safety cap so a forgotten recording can't balloon

// Live input metering — lets the user SEE whether the mic is picking them up,
// and lets us reject silent clips (Whisper hallucinates "תודה רבה" on silence).
let audioCtx = null;
let levelTimer = null;
let maxLevel = 0;
function startMeter(s) {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(s).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    maxLevel = 0;
    levelTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128) / 128; if (v > peak) peak = v; }
      if (peak > maxLevel) maxLevel = peak;
      set({ level: peak });
    }, 100);
  } catch { /* metering is best-effort */ }
}
function stopMeter() {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
  try { audioCtx?.close(); } catch { /* ignore */ }
  audioCtx = null;
  set({ level: 0 });
}

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const m of cands) {
    try { if (window.MediaRecorder?.isTypeSupported?.(m)) return m; } catch { /* ignore */ }
  }
  return '';
}

function blobToBase64(blob) {
  // No FileReader (bun test) → go through the ArrayBuffer instead.
  if (typeof FileReader === 'undefined') {
    return blob.arrayBuffer().then((ab) => {
      const bytes = new Uint8Array(ab);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    });
  }
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('read failed'));
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.readAsDataURL(blob);
  });
}

// Normalize whatever a caller passed (an options object, a click event, or
// nothing) to a mode. Anything that isn't an explicit 'dictate' is a command —
// the hotkey and the rail never dictate.
export function modeOf(opts) {
  return opts && typeof opts === 'object' && opts.mode === 'dictate' ? 'dictate' : 'command';
}

export async function startRecording(opts) {
  if (state.status === 'recording' || state.status === 'thinking') return;
  const mode = modeOf(opts);
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    set({ status: 'error', error: 'Mic needs a secure context (localhost/HTTPS) and a supported browser.' });
    return;
  }
  const micId = getPrefs().voiceMicId;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: micId ? { deviceId: { exact: micId } } : true,
    });
  } catch (e) {
    // Chosen device gone/unavailable → retry with the system default.
    if (micId && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (e2) { set({ status: 'error', error: `Mic error: ${e2.message}` }); return; }
    } else {
      set({ status: 'error', error: e?.name === 'NotAllowedError' ? 'Microphone permission denied.' : `Mic error: ${e.message}` });
      return;
    }
  }
  const mimeType = pickMime();
  chunks = [];
  // Cap the bitrate: mobile browsers default to ~128kbps, bloating clips. Speech
  // → Whisper (16kHz) needs nothing close to that; 32kbps keeps files small.
  const recOpts = { audioBitsPerSecond: 32_000 };
  if (mimeType) recOpts.mimeType = mimeType;
  rec = new MediaRecorder(stream, recOpts);
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  rec.onstop = () => finalize(mimeType, mode);
  rec.start(); // no timeslice → one complete, well-formed blob on stop
  startMeter(stream);
  if (maxTimer) clearTimeout(maxTimer);
  maxTimer = setTimeout(() => { if (state.status === 'recording') stopRecording(); }, MAX_RECORD_MS);
  set({ status: 'recording', mode, transcript: '', plan: null, error: '' });
}

function stopTracks() {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  stream = null;
}

export function stopRecording() {
  if (state.status !== 'recording' || !rec) return;
  try { rec.stop(); } catch { /* onstop still fires finalize in most cases */ }
}

export function cancel() {
  if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
  if (rec && rec.state !== 'inactive') { rec.onstop = null; try { rec.stop(); } catch { /* ignore */ } }
  rec = null;
  chunks = [];
  stopMeter();
  stopTracks();
  set({ status: 'idle', transcript: '', plan: null, error: '' });
}

export function toggleRecording(opts) {
  if (state.status === 'recording') stopRecording();
  else if (state.status === 'idle' || state.status === 'error' || state.status === 'review') startRecording(opts);
}

async function finalize(mimeType, mode) {
  if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
  const peak = maxLevel;
  stopMeter();
  stopTracks();
  const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
  rec = null;
  chunks = [];
  if (!blob.size) { set({ status: 'idle' }); return; }
  // Too-short clips can be an incomplete/headerless container Groq rejects
  // ("could not process file"). Ask the user to hold a beat longer.
  if (blob.size < 1600) {
    set({ status: 'error', error: 'That was too short to transcribe — hold the mic and speak a moment longer.' });
    return;
  }
  // The mic never rose above near-silence → don't ship silence to Whisper (it
  // would hallucinate, e.g. "תודה רבה"). Tell the user to check their input.
  if (peak < 0.03) {
    set({ status: 'error', error: 'No sound from the mic. Check the input device and that your browser has macOS microphone permission (System Settings → Privacy → Microphone).' });
    return;
  }
  await processClip(blob, mode);
}

// Clip → STT → (dictate | route). Exported so the two paths can be exercised
// without a MediaRecorder (tests inject a fake clip through this same code).
export async function processClip(blob, mode = state.mode) {
  set({ status: 'thinking', mode });
  try {
    const transcript = await transcribeBlob(blob);
    if (!transcript) { set({ status: 'idle' }); return; }
    await handleTranscript(transcript, mode);
  } catch (e) {
    set({ status: 'error', error: String(e.message || e) });
  }
}

// One STT request. The mic always listens in ONE concrete language — the
// user's pick, else the UI language (prefs.voiceLangFrom) — sent as `language`.
export async function transcribeBlob(blob) {
  const audioBase64 = await blobToBase64(blob);
  const language = voiceLangFrom(getPrefs());
  const stt = await api.post('/voice/stt', { audioBase64, mimeType: blob.type, language });
  if (stt?.error) throw new Error(stt.error);
  return (stt?.text || '').trim();
}

// The split: dictation goes to the composer draft and we are done; a command
// goes through the host router and lands in the review state for the HUD.
export async function handleTranscript(transcript, mode = state.mode) {
  set({ transcript, mode });
  if (mode === 'dictate') {
    await deliverDictation(transcript);
    set({ status: 'idle', transcript: '', plan: null, error: '' });
    return;
  }
  await routeTranscript(transcript);
}

// ---- dictation --------------------------------------------------------------

// Append a transcript to a draft: one space between, no leading space on an
// empty draft, no doubled whitespace when the draft already ends with some.
export function appendDictation(draft, text) {
  const t = (text || '').trim();
  const d = (draft || '').replace(/\s+$/, '');
  if (!t) return draft || '';
  return d ? `${d} ${t}` : t;
}

// The mounted composer registers itself as the sink (so the textarea updates
// and gets focus); without one (composer not mounted) the store draft of the
// selected session takes the text and shows it when the composer mounts.
let dictationSink = null;
export function setDictationSink(fn) {
  dictationSink = typeof fn === 'function' ? fn : null;
  return () => { if (dictationSink === fn) dictationSink = null; };
}
async function deliverDictation(text) {
  if (dictationSink) { dictationSink(text); return; }
  const { getDraft, setDraft } = await import('./store.js');
  if (!currentSelectedId) return;
  setDraft(currentSelectedId, { text: appendDictation(getDraft(currentSelectedId).text, text) });
}

// ---- command routing --------------------------------------------------------

async function routeTranscript(transcript) {
  // Build a compact session context for the router.
  const { getState: storeState } = await import('./store.js');
  const st = storeState();
  const sessions = st.sessions.map((s) => ({
    id: s.id,
    label: s.metadata?.ticket || s.title || s.id,
    selected: s.id === currentSelectedId,
    working: s.claude?.state === 'working',
    archived: !!s.archived,
  }));
  // Current session's tabs (so "go to the X tab" can resolve a tabId), its
  // recent chat (so the router can answer "what did it say?" / "is it done?"),
  // and the active tab's readable content.
  const cur = st.sessions.find((s) => s.id === currentSelectedId);
  const tabs = tabsOf(cur);
  const recentChat = renderChat(st.chats?.[currentSelectedId]);
  const activeTab = activeTabContent(cur);
  // Short-term voice-conversation memory so a follow-up answers the question
  // the router just asked. Expires after a quiet gap so old context doesn't linger.
  const now = Date.now();
  if (now - lastTurnAt > CONVO_TTL_MS) convo = [];
  const plan = await api.post('/voice/route', {
    transcript,
    context: { sessions, selectedId: currentSelectedId, tabs, recentChat, activeTab, history: convo },
  });
  if (plan?.error) throw new Error(plan.error);
  // Record this turn (user + assistant) for the next utterance's context.
  const reply = (plan.say && plan.say.trim()) || summarizeActions(plan.actions);
  convo = [...convo, { role: 'user', content: transcript }, { role: 'assistant', content: reply }].slice(-8);
  lastTurnAt = now;
  set({ status: 'review', plan: { actions: plan.actions || [], say: plan.say || '' } });
}

// App keeps us told which session is selected (for router context + inject
// targeting) without us importing the store's React state.
let currentSelectedId = null;
export function setSelectedContext(id) { currentSelectedId = id; }

// Rolling voice-conversation memory (last few turns) + idle reset.
let convo = [];
let lastTurnAt = 0;
const CONVO_TTL_MS = 4 * 60 * 1000;
const summarizeActions = (actions) =>
  Array.isArray(actions) && actions.length ? `(did: ${actions.map((a) => a.type).join(', ')})` : '(ok)';

// The session's open tabs as {id,title,type}, including the built-in Changes tab
// — mirrors resolveTabs() in SessionView (kept inline to avoid importing a
// component module into this lib).
function tabsOf(s) {
  if (!s) return [];
  const base = s.tabs?.length ? s.tabs : [{ id: '__session', type: 'session', title: 'Session' }];
  const hasChanges = base.some((t) => t.type === 'changes' || t.id === '__changes');
  const tabs = hasChanges ? base : [...base, { id: '__changes', type: 'changes', title: 'Changes' }];
  return tabs.map((t) => ({ id: t.id, title: t.title || t.type, type: t.type }));
}

// Compact, token-bounded render of a session's recent chat — the "terminal
// content" Haiku reads to answer questions or decide. Noisy/huge kinds (thinking,
// raw tool results) are summarized or skipped.
function renderChat(events, max = 14, perCap = 320) {
  if (!Array.isArray(events) || !events.length) return '';
  const clip = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, perCap);
  const lines = [];
  for (const e of events.slice(-max)) {
    switch (e.kind) {
      case 'user': lines.push('you: ' + clip(e.text)); break;
      case 'assistant-text':
      case 'assistant': if (e.text) lines.push('claude: ' + clip(e.text)); break;
      case 'tool-use': lines.push(`claude → ran tool ${e.name || e.tool || e.toolName || ''}`.trim()); break;
      case 'result': lines.push('[turn complete]'); break;
      case 'error': lines.push('error: ' + clip(e.text)); break;
      case 'permission-request': lines.push(`[awaiting your permission: ${e.toolName || e.tool_name || ''}]`); break;
      default: break; // skip thinking, tool-result, etc.
    }
  }
  return lines.join('\n').slice(0, 3500);
}

// The active tab's readable content, if any. Website (url) tabs are cross-origin
// iframes — their live content can't be read, so we say so.
function activeTabContent(s) {
  if (!s) return null;
  const id = s.activeTabId;
  if (!id || id === '__changes') return id === '__changes' ? { title: 'Changes', type: 'changes', text: '(the local code-changes / diff view)' } : null;
  const tab = (s.tabs || []).find((t) => t.id === id);
  if (!tab) return null;
  if (tab.type === 'content' && tab.body) return { title: tab.title, type: 'content', text: String(tab.body).slice(0, 2500) };
  if (tab.type === 'url') return { title: tab.title, type: 'url', text: '(a live website tab — its content cannot be read)' };
  return { title: tab.title || tab.type, type: tab.type };
}

export function clearPlan() {
  set({ status: 'idle', plan: null, transcript: '' });
}
