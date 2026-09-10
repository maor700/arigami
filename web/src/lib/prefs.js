// User preferences: localStorage-backed, useSyncExternalStore (mirrors store.js).
// Global defaults (theme, terminal font/dir/theme, rail width) plus per-session
// terminal overrides (each terminal can flip its own dir + light/dark).
import { useSyncExternalStore } from 'react';
import { logoDataUri, DEFAULT_ACCENT, DEFAULT_LOGO } from './logos.js';
import { langDir, resolveLang, isLangId, isVoiceLangId, resolveVoiceLang } from './langs.js';

const KEY = 'arigami-prefs';

export const PREF_LIMITS = { font: [10, 24], rail: [180, 420] };

// UI size: one factor on the root font-size, so everything measured in rem/em
// (the rail, chrome, settings) grows together. The chat output has its own
// px size (termFontSize) and is untouched by this.
export const UI_SCALES = { small: 0.875, medium: 1, large: 1.15 };
export const UI_SCALE_IDS = ['small', 'medium', 'large'];
export const isUiScale = (v) => UI_SCALE_IDS.includes(v);

const DEFAULTS = {
  theme: 'dark', // app chrome: 'light' | 'dark' — dark by default, like the landing page
  termTheme: 'dark', // default terminal: 'light' | 'dark'
  termFontSize: 16, // px, clamped 10–24 — the chat output text size
  termDir: 'auto', // default terminal direction: 'auto' | 'ltr' | 'rtl'
  railWidth: 248, // px, clamped 180–420
  uiScale: 'medium', // whole-UI size incl. the rail: 'small' | 'medium' | 'large' → --ui-scale on <html> (rem)
  termOverrides: {}, // { [sessionId]: { dir?, theme? } } — per-terminal overrides
  voiceAutoSend: false, // auto-send voice prompts without confirmation
  voiceMicId: '', // preferred microphone deviceId ('' = system default)
  voiceMode: 'hold', // 'hold' (push-to-talk, hold the key) | 'toggle' (press to start/stop)
  voiceLang: 'auto', // 'auto' (= the UI language) | ISO code from langs.VOICE_LANGS — the language the mic listens in
  voiceHotkey: 'Cmd+Shift+V', // keyboard shortcut to start recording
  ticketPresets: [], // [{ id, name, filters }] — saved launcher ticket filters
  ticketDefaultPresetId: '', // id of the preset applied when the launcher opens
  sessionPresets: [], // [{ id, name, engine, skill, model, effort }] — saved launcher session options
  sessionDefaultPresetId: '', // id of the preset applied when the launcher opens, any tab
  sessionDefaultPresetByMode: { ticket: '', empty: '', trigger: '' }, // per-launcher-tab override
  autonomyWarningDismissed: false, // "don't show again" for the autonomous-trigger warning
  usageExpanded: false, // rail usage panel: collapsed = one 5h-session line, expanded = full session+week charts
  accent: '', // brand accent hex (#rrggbb); '' = built-in default (jade)
  logo: DEFAULT_LOGO, // origami logo preset: 'star' (brand) | 'crane' | 'fold' | 'plane' | 'boat'
  // 'auto' (browser) | 'en' | 'he' — drives strings + text direction.
  // English, not 'auto': the product is English-first, and 'auto' meant a
  // Hebrew-locale machine opened a fresh install in Hebrew with no warning.
  // 'auto' is still selectable in Settings for anyone who wants it.
  language: 'en',
};

export const EMPTY_TICKET_FILTERS = {
  assignee: 'me', // 'me' | 'any'
  state: '', // '' | backlog | unstarted | started | completed | canceled (or a status name)
  priority: '', // '' | '0'..'4'
  labels: [], // tag names (multi-select)
  labelOp: 'or', // 'and' | 'or' — how to combine labels
  query: '', // free-text search
  orderBy: 'updatedAt', // 'updatedAt' | 'createdAt' (drives recent-first sort)
  hideOpen: false, // hide tickets that already have an open host session (client-side)
};

export function sanitizeFilters(f) {
  const o = f && typeof f === 'object' ? f : {};
  // Back-compat: a legacy single `label` string reads as a one-element OR set,
  // so old presets (and the built-in) keep working.
  const labels = Array.isArray(o.labels)
    ? o.labels.filter((x) => typeof x === 'string' && x).slice(0, 20)
    : typeof o.label === 'string' && o.label
      ? [o.label]
      : [];
  return {
    assignee: o.assignee === 'any' ? 'any' : 'me',
    state: typeof o.state === 'string' ? o.state : '',
    priority: ['0', '1', '2', '3', '4'].includes(String(o.priority)) ? String(o.priority) : '',
    labels,
    labelOp: o.labelOp === 'and' ? 'and' : 'or',
    query: typeof o.query === 'string' ? o.query : '',
    orderBy: o.orderBy === 'createdAt' ? 'createdAt' : 'updatedAt',
    hideOpen: o.hideOpen === true || o.hideOpen === 'true',
  };
}

function sanitizePresets(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((p) => p && typeof p === 'object' && p.id && p.name)
    .slice(0, 50)
    .map((p) => ({ id: String(p.id), name: String(p.name).slice(0, 40), filters: sanitizeFilters(p.filters) }));
}

function sanitizeSessionOptions(o) {
  const p = o && typeof o === 'object' ? o : {};
  return {
    // '' = claude (the default engine) — same "unset means claude" rule the
    // server's pickEngine() uses, so a preset saved before engines existed
    // keeps launching Claude sessions.
    engine: p.engine === 'codex' ? 'codex' : '',
    skill: typeof p.skill === 'string' ? p.skill : '',
    model: typeof p.model === 'string' ? p.model : '',
    effort: typeof p.effort === 'string' ? p.effort : '',
  };
}

function sanitizeSessionPresets(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((p) => p && typeof p === 'object' && p.id && p.name)
    .slice(0, 50)
    .map((p) => ({ id: String(p.id), name: String(p.name).slice(0, 40), ...sanitizeSessionOptions(p) }));
}

const LAUNCHER_MODES = ['ticket', 'empty', 'trigger'];
function sanitizeByMode(o) {
  const p = o && typeof o === 'object' ? o : {};
  const out = {};
  for (const mode of LAUNCHER_MODES) out[mode] = typeof p[mode] === 'string' ? p[mode] : '';
  return out;
}

function sanitizeVoiceLang(v) {
  return isVoiceLangId(v) ? v : DEFAULTS.voiceLang;
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function sanitizeOverrides(o) {
  const out = {};
  if (o && typeof o === 'object') {
    for (const [id, v] of Object.entries(o)) {
      if (!v || typeof v !== 'object') continue;
      const e = {};
      if (['auto', 'ltr', 'rtl'].includes(v.dir)) e.dir = v.dir;
      if (['light', 'dark'].includes(v.theme)) e.theme = v.theme;
      if (Object.keys(e).length) out[id] = e;
    }
  }
  return out;
}

function sanitize(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    theme: p.theme === 'light' ? 'light' : 'dark',
    termTheme: p.termTheme === 'light' ? 'light' : 'dark',
    termFontSize: clamp(p.termFontSize, PREF_LIMITS.font[0], PREF_LIMITS.font[1], DEFAULTS.termFontSize),
    termDir: ['auto', 'ltr', 'rtl'].includes(p.termDir) ? p.termDir : DEFAULTS.termDir,
    railWidth: clamp(p.railWidth, PREF_LIMITS.rail[0], PREF_LIMITS.rail[1], DEFAULTS.railWidth),
    uiScale: isUiScale(p.uiScale) ? p.uiScale : DEFAULTS.uiScale,
    termOverrides: sanitizeOverrides(p.termOverrides),
    voiceAutoSend: p.voiceAutoSend === true,
    voiceMicId: typeof p.voiceMicId === 'string' ? p.voiceMicId : DEFAULTS.voiceMicId,
    voiceMode: ['hold', 'toggle'].includes(p.voiceMode) ? p.voiceMode : DEFAULTS.voiceMode,
    voiceLang: sanitizeVoiceLang(p.voiceLang ?? p.voiceLanguage), // `voiceLanguage` = pre-VOICE1 name of the same pref
    voiceHotkey: typeof p.voiceHotkey === 'string' && p.voiceHotkey ? p.voiceHotkey : DEFAULTS.voiceHotkey,
    ticketPresets: sanitizePresets(p.ticketPresets),
    ticketDefaultPresetId: typeof p.ticketDefaultPresetId === 'string' ? p.ticketDefaultPresetId : '',
    sessionPresets: sanitizeSessionPresets(p.sessionPresets),
    sessionDefaultPresetId: typeof p.sessionDefaultPresetId === 'string' ? p.sessionDefaultPresetId : '',
    sessionDefaultPresetByMode: sanitizeByMode(p.sessionDefaultPresetByMode),
    autonomyWarningDismissed: p.autonomyWarningDismissed === true,
    usageExpanded: p.usageExpanded === true,
    accent: /^#[0-9a-fA-F]{6}$/.test(p.accent) ? p.accent : '',
    // No UI exposes a logo picker (Appearance.jsx keeps it out — SETTINGS-IA
    // §1.1 #4), so a stored `logo` can only be a leftover from a browser that
    // visited before the brand default flipped to 'star' — never an explicit
    // user choice. Ignore whatever's saved and always resolve to the current
    // DEFAULT_LOGO, so changing the brand default isn't silently pinned by
    // old localStorage. Once a picker ships, go back to
    // `isLogoId(p.logo) ? p.logo : DEFAULT_LOGO` to respect a real choice.
    logo: DEFAULT_LOGO,
    language: p.language === 'auto' || isLangId(p.language) ? p.language : 'en',
  };
}

function read() {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return { ...DEFAULTS };
  }
}

let state = read();
const listeners = new Set();

// No-DOM guard: the same modules are imported by `bun test` (S2 renders the
// setup components with react-dom/server), where `document` doesn't exist.
const HAS_DOM = typeof document !== 'undefined' && !!document.documentElement;

function applyTheme() {
  if (!HAS_DOM) return;
  document.documentElement.dataset.theme = state.theme;
}

// Brand accent + origami favicon. A custom accent overrides --color-brand on the
// root; every accent tint in index.css is a color-mix off that var, so one hex
// rebrands the whole UI. The favicon can't read CSS vars, so it's baked from the
// resolved accent + logo preset.
function applyBranding() {
  if (!HAS_DOM) return;
  const root = document.documentElement;
  if (state.accent) root.style.setProperty('--color-brand', state.accent);
  else root.style.removeProperty('--color-brand');
  root.style.setProperty('--ui-scale', String(UI_SCALES[state.uiScale] || 1));
  root.setAttribute('dir', langDir(state.language));
  root.setAttribute('lang', resolveLang(state.language));
  const link = document.querySelector("link[rel='icon']");
  if (link) link.setAttribute('href', logoDataUri(state.logo, state.accent || DEFAULT_ACCENT));
  const meta = document.querySelector("meta[name='theme-color']");
  if (meta) meta.setAttribute('content', state.accent || DEFAULT_ACCENT);
}
applyTheme(); // set before first paint
applyBranding();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getPrefs = () => state;

export function setPrefs(patch) {
  state = sanitize({ ...state, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage may be unavailable */
  }
  applyTheme();
  applyBranding();
  for (const fn of listeners) fn();
}

export function usePrefs() {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}

// Effective terminal view for a session: per-session override wins over the
// global default. Pure — pass the prefs object from usePrefs() so it's reactive.
export function termViewFrom(prefs, sessionId) {
  const ov = (prefs.termOverrides && prefs.termOverrides[sessionId]) || {};
  return {
    dir: ov.dir || prefs.termDir,
    theme: ov.theme || prefs.termTheme,
  };
}

// Set a per-session terminal override ({dir} and/or {theme}).
export function setTermOverride(sessionId, patch) {
  const cur = (state.termOverrides && state.termOverrides[sessionId]) || {};
  setPrefs({ termOverrides: { ...state.termOverrides, [sessionId]: { ...cur, ...patch } } });
}

// The language the mic listens in right now (VOICE1): the explicit pick, else
// the UI language. Pure — pass the prefs object from usePrefs() to stay reactive.
export function voiceLangFrom(prefs = state) {
  return resolveVoiceLang(prefs.voiceLang, prefs.language);
}

// ---- launcher ticket-filter presets ----------------------------------------
function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

// Save a named preset (new), return its id. makeDefault marks it the default.
export function saveTicketPreset(name, filters, makeDefault = false) {
  const id = newId();
  const preset = { id, name, filters: sanitizeFilters(filters) };
  const patch = { ticketPresets: [...state.ticketPresets, preset] };
  if (makeDefault) patch.ticketDefaultPresetId = id;
  setPrefs(patch);
  return id;
}

export function deleteTicketPreset(id) {
  setPrefs({
    ticketPresets: state.ticketPresets.filter((p) => p.id !== id),
    ...(state.ticketDefaultPresetId === id ? { ticketDefaultPresetId: '' } : {}),
  });
}

export function setDefaultTicketPreset(id) {
  setPrefs({ ticketDefaultPresetId: state.ticketDefaultPresetId === id ? '' : id });
}

// ---- launcher session-options (skill/model/effort) presets -----------------
// Save a named preset (new), return its id. makeDefault marks it the default.
export function saveSessionPreset(name, options, makeDefault = false) {
  const id = newId();
  const preset = { id, name, ...sanitizeSessionOptions(options) };
  const patch = { sessionPresets: [...state.sessionPresets, preset] };
  if (makeDefault) patch.sessionDefaultPresetId = id;
  setPrefs(patch);
  return id;
}

export function deleteSessionPreset(id) {
  const byMode = { ...state.sessionDefaultPresetByMode };
  for (const mode of LAUNCHER_MODES) if (byMode[mode] === id) byMode[mode] = '';
  setPrefs({
    sessionPresets: state.sessionPresets.filter((p) => p.id !== id),
    ...(state.sessionDefaultPresetId === id ? { sessionDefaultPresetId: '' } : {}),
    sessionDefaultPresetByMode: byMode,
  });
}

export function setDefaultSessionPreset(id) {
  setPrefs({ sessionDefaultPresetId: state.sessionDefaultPresetId === id ? '' : id });
}

// Per-launcher-tab default (ticket / empty / trigger) — overrides the
// any-tab default above when set for that specific tab.
export function setModeDefaultSessionPreset(mode, id) {
  if (!LAUNCHER_MODES.includes(mode)) return;
  const cur = state.sessionDefaultPresetByMode[mode];
  setPrefs({
    sessionDefaultPresetByMode: { ...state.sessionDefaultPresetByMode, [mode]: cur === id ? '' : id },
  });
}
