// User preferences: localStorage-backed, useSyncExternalStore (mirrors store.js).
// Global defaults (theme, terminal font/dir/theme, rail width) plus per-session
// terminal overrides (each terminal can flip its own dir + light/dark).
import { useSyncExternalStore } from 'react';
import { logoDataUri, isLogoId, DEFAULT_ACCENT } from './logos.js';

const KEY = 'arigami-prefs';

const DEFAULTS = {
  theme: 'light', // app chrome: 'light' | 'dark'
  termTheme: 'dark', // default terminal: 'light' | 'dark'
  termFontSize: 12, // px, clamped 10–20
  termDir: 'auto', // default terminal direction: 'auto' | 'ltr' | 'rtl'
  railWidth: 248, // px, clamped 180–420
  termOverrides: {}, // { [sessionId]: { dir?, theme? } } — per-terminal overrides
  voiceAutoSend: false, // auto-send voice prompts without confirmation
  voiceMicId: '', // preferred microphone deviceId ('' = system default)
  voiceMode: 'hold', // 'hold' (push-to-talk, hold the key) | 'toggle' (press to start/stop)
  voiceLanguage: 'auto', // 'auto' | 'en' | 'he' — STT recognition language hint
  voiceHotkey: 'Cmd+Shift+V', // keyboard shortcut to start recording
  ticketPresets: [], // [{ id, name, filters }] — saved launcher ticket filters
  ticketDefaultPresetId: '', // id of the preset applied when the launcher opens
  autoCompact: false, // run /compact automatically once a session's context fills
  autoCompactPct: 80, // context % that triggers auto-compact (clamped 50–95)
  autonomyWarningDismissed: false, // "don't show again" for the autonomous-trigger warning
  accent: '', // brand accent hex (#rrggbb); '' = built-in default (jade)
  logo: 'crane', // origami logo preset: 'crane' | 'fold' | 'plane' | 'boat'
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
    theme: p.theme === 'dark' ? 'dark' : 'light',
    termTheme: p.termTheme === 'light' ? 'light' : 'dark',
    termFontSize: clamp(p.termFontSize, 10, 20, DEFAULTS.termFontSize),
    termDir: ['auto', 'ltr', 'rtl'].includes(p.termDir) ? p.termDir : DEFAULTS.termDir,
    railWidth: clamp(p.railWidth, 180, 420, DEFAULTS.railWidth),
    termOverrides: sanitizeOverrides(p.termOverrides),
    voiceAutoSend: p.voiceAutoSend === true,
    voiceMicId: typeof p.voiceMicId === 'string' ? p.voiceMicId : DEFAULTS.voiceMicId,
    voiceMode: ['hold', 'toggle'].includes(p.voiceMode) ? p.voiceMode : DEFAULTS.voiceMode,
    voiceLanguage: ['auto', 'en', 'he'].includes(p.voiceLanguage) ? p.voiceLanguage : DEFAULTS.voiceLanguage,
    voiceHotkey: typeof p.voiceHotkey === 'string' && p.voiceHotkey ? p.voiceHotkey : DEFAULTS.voiceHotkey,
    ticketPresets: sanitizePresets(p.ticketPresets),
    ticketDefaultPresetId: typeof p.ticketDefaultPresetId === 'string' ? p.ticketDefaultPresetId : '',
    autoCompact: p.autoCompact === true,
    autoCompactPct: clamp(p.autoCompactPct, 50, 95, DEFAULTS.autoCompactPct),
    autonomyWarningDismissed: p.autonomyWarningDismissed === true,
    accent: /^#[0-9a-fA-F]{6}$/.test(p.accent) ? p.accent : '',
    logo: isLogoId(p.logo) ? p.logo : 'crane',
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

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
}

// Brand accent + origami favicon. A custom accent overrides --color-brand on the
// root; every accent tint in index.css is a color-mix off that var, so one hex
// rebrands the whole UI. The favicon can't read CSS vars, so it's baked from the
// resolved accent + logo preset.
function applyBranding() {
  const root = document.documentElement;
  if (state.accent) root.style.setProperty('--color-brand', state.accent);
  else root.style.removeProperty('--color-brand');
  const link = document.querySelector("link[rel='icon']");
  if (link) link.setAttribute('href', logoDataUri(state.logo, state.accent || DEFAULT_ACCENT));
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
  return useSyncExternalStore(subscribe, getPrefs);
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

export const PREF_LIMITS = { font: [10, 20], rail: [180, 420] };

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
