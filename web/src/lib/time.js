import { t, currentLang } from './i18n.js';

// A number with its unit, e.g. '12m' — the unit and the gap before it are locale strings (B4), so other languages render their own.
const nu = (n, unitKey) => `${n}${t('time.unitGap')}${t(unitKey)}`;

// B22: absolute dates follow the UI language, not the browser's (en-US dates
// showed up inside the Hebrew cockpit).
export function dateLocale() {
  return currentLang() === 'he' ? 'he-IL' : 'en-US';
}
const toDate = (ts) => (ts instanceof Date ? ts : new Date(typeof ts === 'number' ? ts : Date.parse(ts)));
export function fmtDateTime(ts, opts) {
  const d = toDate(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(dateLocale(), opts);
}
export function fmtDate(ts, opts) {
  const d = toDate(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(dateLocale(), opts);
}
export function fmtTime(ts, opts = { hour: '2-digit', minute: '2-digit', second: '2-digit' }) {
  const d = toDate(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(dateLocale(), opts);
}

// Time remaining until a future timestamp, '3h 12m' / '2d 4h' / '<1m' style.
// Returns '' for missing/invalid input and 'now' once the moment has passed.
export function untilTime(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (Number.isNaN(ms)) return '';
  let s = Math.floor((ms - Date.now()) / 1000);
  if (s <= 0) return 'now'; // sentinel — Usage.jsx compares === 'now'; don't localize
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d) return `${nu(d, 'time.d')} ${nu(h, 'time.h')}`;
  if (h) return `${nu(h, 'time.h')} ${nu(m, 'time.m')}`;
  if (m) return `${nu(m, 'time.m')}`;
  return t('time.lt1m');
}

// '12m', '1h', '2d' style relative time.
export function relTime(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (Number.isNaN(ms)) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return t('dialogs.now');
  const m = Math.floor(s / 60);
  if (m < 60) return `${nu(m, 'time.m')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${nu(h, 'time.h')}`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${nu(d, 'time.d')}`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${nu(w, 'time.w')}`;
  return `${Math.floor(d / 30)}${t('time.mo')}`;
}

// Humanized ago-time for chat lines: 'now', '2m ago', '3h ago', 'yesterday',
// then a short date. Softer than relTime — meant to be read, not scanned.
export function agoTime(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (Number.isNaN(ms)) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return t('dialogs.now');
  const m = Math.round(s / 60);
  if (m < 60) return t('dialogs.timeAgo', { t: `${nu(m, 'time.m')}` });
  const h = Math.round(m / 60);
  if (h < 24) return t('dialogs.timeAgo', { t: `${nu(h, 'time.h')}` });
  const d = Math.floor(h / 24);
  if (d === 1) return t('dialogs.yesterday');
  if (d < 7) return t('dialogs.timeAgo', { t: `${nu(d, 'time.d')}` });
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
