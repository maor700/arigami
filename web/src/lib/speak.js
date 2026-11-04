// Read-aloud (stage 1b, docs/VOICE.md): the assistant's streamed text → sentences → TTS → played in order.
// Offered only when a TTS source exists (host providers from GET /config, or the browser's speechSynthesis
// when the person opted in) AND "read answers aloud" is on. stop() drops the queue at once; barge-in also
// interrupts the turn while it still streams. With no source nothing here is ever reached.
import { useSyncExternalStore } from 'react';
import { api } from './api.js';
import { getPrefs } from './prefs.js';
import { getState as storeState, setChatTap } from './store.js';
import { setSpeakHooks } from './voice.js';
import { setAudioSource, clearAudioSource, audioLevelContext } from './audioLevel.js';

// ---- gating (pure) ----------------------------------------------------------------
export const hasSynth = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
// 'server' (a connected TTS provider) | 'browser' (opt-in speechSynthesis) | null. The kill-switch covers both.
export function ttsSource(config, prefs, synth = hasSynth()) {
  const vp = config?.voiceProviders;
  if (vp && vp.enabled === false) return null;
  if (Array.isArray(vp?.tts) && vp.tts.length) return 'server';
  if (prefs?.voiceBrowserTts === true && synth) return 'browser';
  return null;
}
export const readAloudOn = (config, prefs, synth) => !!ttsSource(config, prefs, synth) && prefs?.voiceReadAloud === true;
// Hands-free needs the mic (STT) too.
export const handsFreeAvailable = (config, prefs, synth) => !!config?.voiceEnabled && readAloudOn(config, prefs, synth);

// ---- text → sentences -----------------------------------------------------------------
export const CODE_MARKER = { he: 'קטע קוד.', en: 'Code block.' };
export const codeMarkerFor = (lang) => CODE_MARKER[String(lang || '').slice(0, 2)] || CODE_MARKER.en;

// A table row → its cells, comma-separated; a separator row → nothing.
function tableLine(line) {
  if (!/^\s*\|.*\|\s*$/.test(line)) return line;
  const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
  if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return '';
  return `${cells.join(', ')}.`;
}

// Markdown → plain speakable text (one sentence or line at a time).
export function stripMarkdown(s) {
  return String(s || '')
    .split('\n').map(tableLine).join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>\n]{1,80}>/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_](\S(?:[^*_\n]*?\S)?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const BOUNDARY = /[.!?؟]+["'”’»)\]]*(?=\s)|\n+/g;
const ABBREV = /(?:^|\s)(?:e\.g|i\.e|etc|vs|dr|mr|mrs|ms|prof|no|approx|fig|[a-z])\.$/i;
// A '.' that ends an abbreviation, or that a lowercase Latin word follows, is not a sentence end; with nothing
// after the space yet the call is deferred to the next delta (flush() emits whatever is left anyway).
function dotNotAnEnd(frag, m) {
  if (!/^\.+["'”’»)\]]*$/.test(m[0])) return false;
  const end = m.index + m[0].length;
  if (ABBREV.test(frag.slice(Math.max(0, m.index - 8), end))) return true;
  const after = frag.slice(end).replace(/^[ \t]+/, '');
  if (!after) return /[A-Za-z]$/.test(frag.slice(0, m.index)) ? 'wait' : false; // only Latin prose can continue in lowercase
  return /^[a-z]/.test(after);
}

/** Streams deltas in, complete sentences out; fenced code becomes one spoken marker. */
export class SentenceChunker {
  constructor({ codeMarker = CODE_MARKER.en, minChars = 12, maxChars = 280 } = {}) {
    this.codeMarker = codeMarker;
    this.minChars = minChars;
    this.maxChars = maxChars;
    this.buf = ''; // raw text not yet classified (may hold an open fence)
    this.frag = ''; // prose with no sentence end yet
    this.inCode = false;
  }
  push(delta) {
    const out = [];
    this.buf += String(delta ?? '');
    for (;;) {
      if (this.inCode) {
        const close = this.buf.indexOf('```');
        if (close === -1) return out;
        const nl = this.buf.indexOf('\n', close + 3);
        this.buf = nl === -1 ? '' : this.buf.slice(nl + 1);
        this.inCode = false;
        this.emitFrag(out, true);
        out.push(this.codeMarker);
        continue;
      }
      const open = this.buf.indexOf('```');
      const head = open === -1 ? this.buf : this.buf.slice(0, open);
      this.buf = open === -1 ? '' : this.buf.slice(open + 3);
      // a fence may still be arriving: keep a trailing run of backticks unclassified
      let keep = '';
      if (open === -1) {
        const m = /`{1,2}$/.exec(head);
        if (m) keep = m[0];
      }
      this.split(head.slice(0, head.length - keep.length), out);
      this.buf = keep + this.buf;
      if (open === -1) return out;
      this.inCode = true;
    }
  }
  split(text, out) {
    if (!text) return;
    this.frag += text;
    for (;;) {
      BOUNDARY.lastIndex = 0;
      let m;
      let cut = -1;
      let hard = false;
      while ((m = BOUNDARY.exec(this.frag))) {
        const skip = dotNotAnEnd(this.frag, m);
        if (skip === 'wait') break;
        if (skip) continue;
        const end = m.index + m[0].length;
        const cand = stripMarkdown(this.frag.slice(0, end));
        if (cand.length >= this.minChars || (m[0].startsWith('\n') && !cand)) { cut = end; hard = m[0].startsWith('\n') && !cand; break; }
      }
      if (cut === -1) {
        // no boundary yet but far too long for one TTS call: cut at the last pause
        if (this.frag.length > this.maxChars) {
          const at = Math.max(this.frag.lastIndexOf(', ', this.maxChars), this.frag.lastIndexOf(' ', this.maxChars));
          if (at > this.minChars) {
            const s = stripMarkdown(this.frag.slice(0, at + 1));
            this.frag = this.frag.slice(at + 1);
            if (s) out.push(s);
            continue;
          }
        }
        return;
      }
      const s = hard ? '' : stripMarkdown(this.frag.slice(0, cut));
      this.frag = this.frag.slice(cut);
      if (s) out.push(s);
    }
  }
  emitFrag(out) {
    const s = stripMarkdown(this.frag);
    this.frag = '';
    if (s) out.push(s);
  }
  flush() {
    const out = [];
    if (this.inCode) {
      this.buf = '';
      this.inCode = false;
      this.emitFrag(out);
      out.push(this.codeMarker);
    } else {
      this.frag += this.buf;
      this.buf = '';
      this.emitFrag(out);
    }
    return out;
  }
}

// ---- players ----------------------------------------------------------------------------
// 50 ms of 8-bit silence: played inside the first tap so iOS lets later programmatic play() through.
const SILENT_WAV = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

export function htmlAudioPlayer() {
  let el = null;
  let url = null;
  let pending = null;
  let unlocked = false;
  const ensure = () => {
    if (!el) {
      el = new Audio();
      el.preload = 'auto';
      el.setAttribute('playsinline', '');
    }
    return el;
  };
  const settle = () => {
    const r = pending;
    pending = null;
    if (el) el.onended = el.onerror = null;
    if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } url = null; }
    clearAudioSource('out', el);
    r?.();
  };
  return {
    kind: 'audio',
    unlock() {
      if (unlocked) return;
      unlocked = true;
      try { const a = ensure(); a.src = SILENT_WAV; a.play().catch(() => {}); } catch { /* no audio element here */ }
    },
    play(blob) {
      return new Promise((resolve) => {
        settle();
        pending = resolve;
        let a;
        try { a = ensure(); url = URL.createObjectURL(blob); } catch { settle(); return; }
        a.onended = settle;
        a.onerror = settle;
        a.src = url;
        setAudioSource('out', a); // one registration per sentence: a captured stream ends when the src changes
        a.play().catch(settle);
      });
    },
    stop() {
      try { el?.pause(); if (el) { el.removeAttribute('src'); el.load(); } } catch { /* ignore */ }
      settle();
    },
  };
}

const bcp47 = (lang) => ({ he: 'he-IL', en: 'en-US', ru: 'ru-RU', fr: 'fr-FR', es: 'es-ES', de: 'de-DE', ar: 'ar-SA' })[lang] || lang || 'en-US';
export function synthPlayer(lang) {
  let pending = null;
  const settle = () => { const r = pending; pending = null; r?.(); };
  return {
    kind: 'synth',
    unlock() {
      try { window.speechSynthesis.speak(new window.SpeechSynthesisUtterance('')); } catch { /* ignore */ }
    },
    play(text) {
      return new Promise((resolve) => {
        settle();
        pending = resolve;
        try {
          const u = new window.SpeechSynthesisUtterance(String(text));
          u.lang = bcp47(lang);
          const v = (window.speechSynthesis.getVoices?.() || []).find((x) => String(x.lang || '').toLowerCase().startsWith(String(lang || '').slice(0, 2)));
          if (v) u.voice = v;
          u.onend = settle;
          u.onerror = settle;
          window.speechSynthesis.speak(u);
        } catch { settle(); }
      });
    },
    stop() {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
      settle();
    },
  };
}

// ---- the queue --------------------------------------------------------------------------
export const MAX_INFLIGHT = 2; // matches the host's per-session guard

/** One answer being spoken: feed() deltas, end() when the turn is over, stop() to drop it all. */
export class Speaker {
  constructor({ sessionId, lang = 'en', source = 'server', fetchImpl, player, synth, allowBrowserFallback = false, onFirstAudio, onDone, onProblem } = {}) {
    this.sessionId = sessionId;
    this.lang = lang;
    this.source = source;
    this.fetchImpl = fetchImpl || ((...a) => fetch(...a));
    this.player = player || (source === 'browser' ? synthPlayer(lang) : htmlAudioPlayer());
    this.synth = synth || null; // the browser player a soft-stop may fall back to
    this.allowBrowserFallback = allowBrowserFallback;
    this.onFirstAudio = onFirstAudio;
    this.onDone = onDone;
    this.onProblem = onProblem;
    this.chunker = new SentenceChunker({ codeMarker: codeMarkerFor(lang) });
    this.queue = []; // [{text, status:'pending'|'fetching'|'ready'|'failed', payload, ctl, tries}]
    this.ended = false;
    this.stopped = false;
    this.done = false;
    this.playing = false;
    this.spoke = 0;
    this.gen = 0;
  }
  get speaking() { return this.playing; }
  get active() { return !this.done && !this.stopped && (this.playing || this.queue.length > 0 || !this.ended); }
  get order() { return this.queue.map((q) => q.text); }
  feed(delta) {
    if (this.stopped || this.ended) return;
    for (const s of this.chunker.push(delta)) this.enqueue(s);
    this.pump();
  }
  say(text) { // a whole sentence at once (tests, hands-free notices)
    if (this.stopped) return;
    this.enqueue(String(text));
    this.pump();
  }
  end() {
    if (this.stopped || this.ended) return;
    for (const s of this.chunker.flush()) this.enqueue(s);
    this.ended = true;
    this.pump();
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.gen++;
    for (const q of this.queue) { try { q.ctl?.abort(); } catch { /* ignore */ } }
    this.queue = [];
    this.playing = false;
    try { this.player.stop(); } catch { /* ignore */ }
    try { this.synth?.stop(); } catch { /* ignore */ }
    this.finish();
  }
  enqueue(text) {
    const t = String(text || '').trim();
    if (!t) return;
    this.queue.push({ text: t, status: this.source === 'browser' ? 'ready' : 'pending', payload: this.source === 'browser' ? t : null, ctl: null, tries: 0, via: this.source });
  }
  finish() {
    if (this.done) return;
    this.done = true;
    this.onDone?.();
  }
  pump() {
    if (this.stopped) return;
    // fetch ahead, at most MAX_INFLIGHT sentences
    let inflight = this.queue.filter((q) => q.status === 'fetching').length;
    for (const q of this.queue) {
      if (inflight >= MAX_INFLIGHT) break;
      if (q.status === 'pending') { this.fetchOne(q); inflight++; }
    }
    // play strictly in order
    while (!this.playing && this.queue.length && this.queue[0].status === 'failed') this.queue.shift();
    if (!this.playing && this.queue.length && this.queue[0].status === 'ready') this.playHead();
    if (!this.playing && !this.queue.length && this.ended) this.finish();
  }
  async playHead() {
    const q = this.queue[0];
    const gen = this.gen;
    this.playing = true;
    if (this.spoke++ === 0) this.onFirstAudio?.();
    const player = q.via === 'browser' && this.player.kind !== 'synth' ? (this.synth ||= synthPlayer(this.lang)) : this.player;
    try { await player.play(q.payload); } catch { /* skip it */ }
    if (gen !== this.gen) return;
    this.playing = false;
    if (this.queue[0] === q) this.queue.shift();
    this.pump();
  }
  async fetchOne(q) {
    q.status = 'fetching';
    q.ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const gen = this.gen;
    try {
      const res = await this.fetchImpl('/__api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, text: q.text, lang: this.lang }),
        signal: q.ctl?.signal,
      });
      if (gen !== this.gen) return;
      const ct = String(res.headers?.get?.('content-type') || '');
      if (ct.includes('json')) {
        const j = await res.json().catch(() => ({}));
        if (gen !== this.gen) return;
        if (res.status === 429 && q.tries++ < 2) { q.status = 'pending'; setTimeout(() => this.pump(), 500); return; }
        if (res.ok && (j?.needs_setup || j?.disabled || j?.budget)) return this.problem(j, q);
        q.status = 'failed';
        this.onProblem?.({ error: j?.error || `HTTP ${res.status}` });
      } else if (!res.ok) {
        q.status = 'failed';
      } else {
        q.payload = await res.blob();
        if (gen !== this.gen) return;
        q.status = 'ready';
      }
    } catch {
      if (gen !== this.gen) return;
      q.status = 'failed';
    }
    this.pump();
  }
  // The host has no usable provider right now (needs_setup / disabled / soft-stopped): fall back to the
  // browser voice when allowed, else stay silent — the text is on screen either way.
  problem(shape, q) {
    this.onProblem?.(shape);
    if (this.allowBrowserFallback && hasSynth()) {
      this.source = 'browser';
      for (const it of this.queue) if (it.status === 'pending' || it === q) { it.status = 'ready'; it.payload = it.text; it.via = 'browser'; }
      this.pump();
      return;
    }
    this.stop();
  }
}

// ---- the live wiring: one armed turn at a time ----------------------------------------------
let state = { active: false, speaking: false, sessionId: null, problem: null, unlocked: false };
const listeners = new Set();
function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getSpeakState = () => state;
export function useSpeak() {
  return useSyncExternalStore(subscribe, getSpeakState, getSpeakState);
}

let sharedPlayer = null;
let sharedSynth = null;
export function setPlayerFactory(fn) { sharedPlayer = fn ? fn() : null; } // tests

/** Call inside a tap/click: iOS plays nothing programmatically before one gesture-started play(). */
export function unlockAudio() {
  if (!sharedPlayer && typeof Audio === 'function') sharedPlayer = htmlAudioPlayer();
  try { sharedPlayer?.unlock(); } catch { /* ignore */ }
  if (hasSynth()) { if (!sharedSynth) sharedSynth = synthPlayer(getPrefs().language === 'he' ? 'he' : 'en'); try { sharedSynth.unlock(); } catch { /* ignore */ } }
  try {
    const ctx = audioLevelContext(); // the meters' context too (lib/audioLevel.js)
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
  } catch { /* ignore */ }
  if (!state.unlocked) set({ unlocked: true });
}

let armed = null; // { sessionId, speaker|null, sawPartial, opts }
let current = null; // the speaker still playing (may outlive `armed`)
let tickTimer = null;
function refresh() {
  const sp = current;
  set({ active: !!sp && sp.active, speaking: !!sp && sp.speaking, sessionId: sp?.sessionId || armed?.sessionId || null });
}
function speakerFor() {
  if (!armed) return null;
  if (armed.speaker) return armed.speaker;
  const prefs = getPrefs();
  const config = armed.opts.config || storeState().config || null;
  const source = armed.opts.source || ttsSource(config, prefs);
  if (!source) return null;
  const lang = armed.opts.lang || (prefs.language === 'he' ? 'he' : 'en');
  if (current && current !== armed.speaker) current.stop();
  const sp = new Speaker({
    sessionId: armed.sessionId,
    lang,
    source,
    player: source === 'browser' ? (sharedSynth ||= synthPlayer(lang)) : (sharedPlayer ||= htmlAudioPlayer()),
    synth: sharedSynth,
    allowBrowserFallback: prefs.voiceBrowserTts === true,
    onFirstAudio: () => { refresh(); armed?.opts.onFirstAudio?.(); },
    onDone: () => { if (current === sp) current = null; refresh(); if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } sp.doneCb?.(); },
    onProblem: (p) => { set({ problem: p }); armedOpts(sp)?.onProblem?.(p); },
  });
  sp.doneCb = armed.opts.onDone;
  armed.speaker = sp;
  current = sp;
  set({ problem: null });
  if (!tickTimer) tickTimer = setInterval(refresh, 250);
  refresh();
  return sp;
}
const armedOpts = (sp) => (armed?.speaker === sp ? armed.opts : null);

/** The next assistant turn in `sessionId` is spoken (call right before sending the message). */
export function armReadAloud(sessionId, opts = {}) {
  if (!sessionId) return;
  if (current) current.stop();
  armed = { sessionId, speaker: null, sawPartial: false, opts };
  refresh();
}
export const armedSession = () => armed?.sessionId || null;

/** Store tap: every appended chat event passes through here. */
export function onChatEvent(sessionId, event) {
  if (!armed || armed.sessionId !== sessionId || !event) return;
  if (event.kind === 'assistant-text' && event.partial) {
    armed.sawPartial = true;
    speakerFor()?.feed(event.text || '');
  } else if (event.kind === 'assistant-text') {
    if (!armed.sawPartial && event.text) speakerFor()?.feed(`${event.text}\n`);
    else speakerFor()?.feed('\n');
    armed.sawPartial = false;
  } else if (event.kind === 'result' || event.kind === 'error') {
    const sp = speakerFor();
    const opts = armed.opts;
    armed = null;
    if (sp) sp.end();
    else opts.onDone?.();
    refresh();
  }
}

export function stopSpeaking() {
  const sp = current;
  armed = null;
  if (sp) sp.stop();
  current = null;
  refresh();
}

/** Is the session's turn still streaming? (pure; `session` from the store) */
export const isStreaming = (session) => session?.claude?.state === 'working';

// Barge-in: drop playback now and, while the turn still streams, interrupt it too.
export async function bargeIn({ sessionId, session, interrupt = true, post = (p) => api.post(p) } = {}) {
  const sid = sessionId || state.sessionId;
  const wasActive = state.active || !!armed;
  stopSpeaking();
  if (!interrupt || !sid || !wasActive) return false;
  let s = session;
  if (s === undefined) s = storeState().sessions.find((x) => x.id === sid) || null;
  if (!isStreaming(s)) return false;
  await post(`/sessions/${sid}/interrupt`).catch(() => {});
  return true;
}

// App boot: hook the chat store and the mic, once.
let installed = false;
export function installReadAloud() {
  if (installed) return;
  installed = true;
  setChatTap(onChatEvent);
  setSpeakHooks({ onMicOpen: () => { if (state.active || armed) bargeIn(); } });
  if (typeof window !== 'undefined') window.addEventListener('host:interrupt', () => stopSpeaking());
}

if (typeof window !== 'undefined') window.__arigamiSpeak = { armReadAloud, onChatEvent, stopSpeaking, bargeIn, getSpeakState, unlockAudio, ttsSource };
