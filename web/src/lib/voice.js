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
// VOICE2 — command mode is a CONVERSATION, not one shot: the router's reply is
// shown in the HUD and, when it asked a question (plan.kind 'ask') or just
// answered one ('answer'), the mic re-opens by itself for the next turn with
// the previous turns as history. The loop ends when an action ran ('act'), on
// a stop word ("stop"/"cancel"/"done" in any UI language — STOP_WORDS below), Esc / the ✕, or 8s without speech on an
// auto-opened turn. Command mode never writes into the composer — only an
// explicit inject_prompt (confirmed in the HUD) reaches a session.
//
// Requires a secure context (localhost or HTTPS) for getUserMedia — same
// constraint as the service worker; fine when run locally on :3099.
import { useSyncExternalStore } from 'react';
import { api } from './api.js';
import { getPrefs, voiceLangFrom } from './prefs.js';
import { normalizeEngine } from './engines.js';

let state = {
  status: 'idle', // idle | recording | thinking | review | error
  mode: 'command', // 'dictate' | 'command' — set when a recording starts
  transcript: '',
  plan: null, // { actions, say, kind: 'ask'|'act'|'answer'|'end'|'noop', question }
  error: '',
  level: 0, // live mic input level 0..1 while recording (for the meter)
  turns: [], // VOICE2: the current spoken exchange [{ role: 'user'|'assistant', text }]
  auto: false, // VOICE2: this recording was opened by the loop (endpointing on)
  relisten: false, // VOICE2: the mic is about to re-open for the user's answer
};
const listeners = new Set();
function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getState = () => state;
export function useVoice() {
  return useSyncExternalStore(subscribe, getState, getState);
}

let rec = null;
let chunks = [];
let stream = null;
let maxTimer = null;
const MAX_RECORD_MS = 90_000; // safety cap so a forgotten recording can't balloon

// Live input metering — lets the user SEE whether the mic is picking them up,
// and lets us reject silent clips (Whisper hallucinates a stock "thank you" phrase on silence).
let audioCtx = null;
let levelTimer = null;
let maxLevel = 0;
// VOICE2 endpointing for auto-opened turns: the user shouldn't have to press
// Stop after answering a question. Speech = the level crossed SPEECH_LEVEL;
// once they spoke, END_SPEECH_MS of quiet ends the take; if they never spoke,
// NO_SPEECH_MS of quiet ends the whole conversation.
export const SPEECH_LEVEL = 0.06;
export const END_SPEECH_MS = 1600;
export const NO_SPEECH_MS = 8000;
// Pure step of that rule (unit-tested): 'continue' | 'stop' (send the take) |
// 'end' (nobody answered).
export function silenceStep({ spoke, startedAt, lastLoud, now, peak }) {
  if (peak >= SPEECH_LEVEL) return 'continue';
  if (!spoke) return now - startedAt >= NO_SPEECH_MS ? 'end' : 'continue';
  return now - lastLoud >= END_SPEECH_MS ? 'stop' : 'continue';
}
function startMeter(s, auto) {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(s).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    maxLevel = 0;
    const startedAt = Date.now();
    let spoke = false;
    let lastLoud = 0;
    levelTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128) / 128; if (v > peak) peak = v; }
      if (peak > maxLevel) maxLevel = peak;
      set({ level: peak });
      if (!auto) return;
      const now = Date.now();
      if (peak >= SPEECH_LEVEL) { spoke = true; lastLoud = now; }
      const step = silenceStep({ spoke, startedAt, lastLoud, now, peak });
      if (step === 'stop') stopRecording();
      else if (step === 'end') endConversation('silence');
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
  const auto = mode === 'command' && !!(opts && typeof opts === 'object' && opts.auto);
  clearRelisten();
  // A dictation take is never part of a command conversation.
  if (mode === 'dictate' && state.turns.length) set({ turns: [] });
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
  startMeter(stream, auto);
  if (maxTimer) clearTimeout(maxTimer);
  maxTimer = setTimeout(() => { if (state.status === 'recording') stopRecording(); }, MAX_RECORD_MS);
  set({ status: 'recording', mode, auto, relisten: false, transcript: '', plan: null, error: '' });
}

function stopTracks() {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  stream = null;
}

export function stopRecording() {
  if (state.status !== 'recording' || !rec) return;
  try { rec.stop(); } catch { /* onstop still fires finalize in most cases */ }
}

// Tear down a live capture (if any) and go idle. Ends the conversation too.
export function cancel() {
  clearRelisten();
  if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
  if (rec && rec.state !== 'inactive') { rec.onstop = null; try { rec.stop(); } catch { /* ignore */ } }
  rec = null;
  chunks = [];
  stopMeter();
  stopTracks();
  set({ status: 'idle', transcript: '', plan: null, error: '', turns: [], auto: false, relisten: false });
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
  // would hallucinate a stock "thank you" phrase). Tell the user to check their input.
  if (peak < 0.03) {
    if (state.auto) { endConversation('silence'); return; }
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
  clearRelisten();
  if (mode === 'dictate') {
    set({ transcript, mode, turns: [] });
    await deliverDictation(transcript);
    set({ status: 'idle', transcript: '', plan: null, error: '' });
    return;
  }
  // Command mode never touches the composer: from here on the only way text
  // reaches a session is an inject_prompt action confirmed in the HUD.
  if (isStopWord(transcript)) { endConversation('stop'); return; }
  set({ transcript, mode, status: 'thinking', turns: [...state.turns, { role: 'user', text: transcript }] });
  await routeTranscript(transcript);
}

// ---- the conversation loop (VOICE2) ----------------------------------------------

// Words that end the exchange on the spot (any language the UI ships in). A
// whole-utterance match, punctuation-insensitive, so "stop" ends but "stop the
// agent" is still routed.
const STOP_WORDS = new Set([
  'סיים', 'סיימתי', 'ביטול', 'בטל', 'תבטל', 'עצור', 'די', 'זהו', 'תודה זהו',
  'stop', 'cancel', 'done', 'finish', 'quit', 'never mind', 'nevermind', 'exit',
  'стоп', 'отмена', 'annuler', 'cancelar', 'abbrechen',
]);
export function isStopWord(text) {
  const t = String(text || '').toLowerCase().replace(/[.,!?؟،;:'"״׳]+/g, ' ').replace(/\s+/g, ' ').trim();
  return !!t && STOP_WORDS.has(t);
}

// What the loop does with a routed plan (pure, unit-tested):
//   'listen' — the router asked or answered → re-open the mic for the next turn
//   'act'    — hand the actions to the HUD; the conversation ends once they ran
//   'end'    — nothing left to say/do
export function nextStep(plan) {
  const kind = plan?.kind;
  if (kind === 'act' || (Array.isArray(plan?.actions) && plan.actions.length)) return 'act';
  if (kind === 'ask' || kind === 'answer') return 'listen';
  return 'end';
}

// Delay before the mic re-opens so the user can read the question first.
export const RELISTEN_DELAY_MS = 700;
let relistenTimer = null;
function clearRelisten() {
  if (relistenTimer) { clearTimeout(relistenTimer); relistenTimer = null; }
  if (state.relisten) set({ relisten: false });
}
function scheduleRelisten() {
  clearRelisten();
  set({ relisten: true });
  relistenTimer = setTimeout(() => {
    relistenTimer = null;
    if (state.status !== 'review' || state.mode !== 'command') { set({ relisten: false }); return; }
    startRecording({ mode: 'command', auto: true });
  }, RELISTEN_DELAY_MS);
}

// End the exchange: reason 'stop' (stop word / Esc / ✕), 'silence' (nobody
// answered an auto-opened turn), 'done' (an action ran). The short-term router
// memory (`convo`) is kept — "and now the same for X" still works right after.
export function endConversation(reason = 'stop') {
  cancel();
  lastEnd = { reason, at: Date.now() };
}
let lastEnd = null;
export const lastConversationEnd = () => lastEnd;

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
  const recentChat = renderChat(st.chats?.[currentSelectedId], normalizeEngine(cur?.engine));
  const activeTab = activeTabContent(cur);
  // Short-term voice-conversation memory so a follow-up answers the question
  // the router just asked. Expires after a quiet gap so old context doesn't linger.
  const now = Date.now();
  if (now - lastTurnAt > CONVO_TTL_MS) convo = [];
  const raw = await api.post('/voice/route', {
    transcript,
    context: { sessions, selectedId: currentSelectedId, tabs, recentChat, activeTab, history: convo },
  });
  if (raw?.error) throw new Error(raw.error);
  const plan = planFrom(raw);
  // Record this turn (user + assistant) for the next utterance's context.
  const reply = plan.say || summarizeActions(plan.actions);
  convo = [...convo, { role: 'user', content: transcript }, { role: 'assistant', content: reply }].slice(-8);
  lastTurnAt = now;
  // The user may have closed the HUD while the router was thinking.
  if (state.status !== 'thinking') return;
  const turns = plan.say ? [...state.turns, { role: 'assistant', text: plan.say }] : state.turns;
  const step = nextStep(plan);
  if (step === 'end') { endConversation('done'); return; }
  set({ status: 'review', plan, turns });
  if (step === 'listen') scheduleRelisten();
}

// The client-side plan shape. A pre-VOICE2 host answers without `kind`, so it
// is derived here the same way the server does (clarify → ask); the server's
// value wins when present.
export function planFrom(raw) {
  const actionsRaw = Array.isArray(raw?.actions) ? raw.actions.filter((a) => a && typeof a.type === 'string') : [];
  const isCtl = (a) => a.type === 'ask' || a.type === 'clarify' || a.type === 'end_conversation';
  const actions = actionsRaw.filter((a) => !isCtl(a));
  const say = typeof raw?.say === 'string' ? raw.say.trim() : '';
  let kind = ['ask', 'act', 'answer', 'end', 'noop'].includes(raw?.kind) ? raw.kind : '';
  if (!kind) {
    if (actions.length) kind = 'act';
    else if (actionsRaw.some((a) => a.type === 'ask' || a.type === 'clarify')) kind = 'ask';
    else if (actionsRaw.some((a) => a.type === 'end_conversation')) kind = 'end';
    else kind = say ? 'answer' : 'noop';
  }
  if (kind === 'act' && !actions.length) kind = say ? 'answer' : 'noop';
  const question = kind === 'ask' ? (typeof raw?.question === 'string' && raw.question.trim()) || say : '';
  return { actions, say: say || question, kind, question };
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
function renderChat(events, engine = 'claude', max = 14, perCap = 320) {
  if (!Array.isArray(events) || !events.length) return '';
  const clip = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, perCap);
  const lines = [];
  for (const e of events.slice(-max)) {
    switch (e.kind) {
      case 'user': lines.push('you: ' + clip(e.text)); break;
      case 'assistant-text':
      case 'assistant': if (e.text) lines.push(`${engine}: ` + clip(e.text)); break;
      case 'tool-use': lines.push(`${engine} → ran tool ${e.name || e.tool || e.toolName || ''}`.trim()); break;
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
  clearRelisten();
  set({ status: 'idle', plan: null, transcript: '', turns: [], auto: false });
}

// ---- the global shortcut (VOICE2) ------------------------------------------------

// Parse a "Cmd+Shift+V" hotkey string and test a keyboard event against it.
// "Cmd" means the platform's primary modifier: ⌘ on Apple hardware, Ctrl
// elsewhere — so the default shortcut works on Linux/Windows too (VOICE2; the
// HUD label shows it the same way, see VoiceHUD.hotkeyLabel).
export const isApple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export function matchesHotkey(e, hotkey, mac = isApple()) {
  if (!hotkey || typeof hotkey !== 'string') return false;
  const parts = hotkey.split('+').map((p) => p.trim());
  let wantCmd = parts.includes('Cmd');
  let wantCtrl = parts.includes('Ctrl');
  if (wantCmd && !mac) { wantCmd = false; wantCtrl = true; }
  const wantAlt = parts.includes('Alt');
  const wantShift = parts.includes('Shift');
  const wantKey = (parts.find((p) => !['Cmd', 'Ctrl', 'Alt', 'Shift'].includes(p)) || '').toLowerCase();
  if (!wantKey) return false;
  const key = (e.key === ' ' ? 'space' : e.key).toLowerCase();
  return (
    !!e.metaKey === wantCmd &&
    !!e.ctrlKey === wantCtrl &&
    !!e.altKey === wantAlt &&
    !!e.shiftKey === wantShift &&
    key === wantKey
  );
}

// One shortcut, two meanings, decided by focus (pure, unit-tested):
//   recording           → 'stop' (any mode — press again to stop)
//   thinking            → 'none' (a take is in flight)
//   composer has focus  → 'dictate' (start a dictation into the message)
//   otherwise           → 'command' (open the command HUD; while it is open
//                          and idle — review/error — this re-opens listening)
export function hotkeyAction(st, composerFocused) {
  if (st.status === 'recording') return 'stop';
  if (st.status === 'thinking') return 'none';
  return composerFocused ? 'dictate' : 'command';
}
// Is the chat composer the focused element? SessionView marks its textarea
// with data-composer; anything else (search box, HUD textarea) is "elsewhere".
export function composerFocused(el = typeof document !== 'undefined' ? document.activeElement : null) {
  return !!el && typeof el.hasAttribute === 'function' && el.hasAttribute('data-composer');
}
// Apply the shortcut. `hold` = push-to-talk keydown: only ever starts (the
// keyup stops), so a repeat/second press can't toggle the take off.
export function hotkeyPress({ hold = false, composer = composerFocused() } = {}) {
  const action = hotkeyAction(state, composer);
  if (action === 'stop') { if (!hold) stopRecording(); return action; }
  if (action === 'none') return action;
  startRecording({ mode: action });
  return action;
}

// Verification hook (VOICE1): a real mic can't be driven headlessly, so a live
// check injects a fake STT result through the same path the recorder uses
// (`handleTranscript(text, mode)`), or a fake clip through `processClip`.
if (typeof window !== 'undefined') window.__arigamiVoice = { handleTranscript, processClip, startRecording, stopRecording, cancel, endConversation, hotkeyPress, setSelectedContext, getState };
