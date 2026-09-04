// Language metadata + resolver. Kept dependency-free (no app imports) so both
// prefs.js (for direction on boot) and i18n.js (for the dictionaries) can use it
// without a circular import.

export const LANGS = {
  en: { label: 'English', dir: 'ltr' },
  he: { label: 'עברית', dir: 'rtl' },
};

export const LANG_IDS = ['en', 'he'];

export function isLangId(id) {
  return Object.prototype.hasOwnProperty.call(LANGS, id);
}

// pref value is 'auto' | <lang id>. 'auto' picks the browser language when we
// have a dictionary for it, else English.
export function resolveLang(pref) {
  if (pref === 'auto') {
    const nav = (typeof navigator !== 'undefined' ? navigator.language || 'en' : 'en').slice(0, 2);
    return isLangId(nav) ? nav : 'en';
  }
  return isLangId(pref) ? pref : 'en';
}

export function langDir(pref) {
  return LANGS[resolveLang(pref)].dir;
}

// ---- voice (STT) languages -------------------------------------------------
// The mic listens in ONE language per clip (Whisper's `language` hint). The
// list is the UI languages plus a few common ones; the pref value is 'auto'
// (= follow the UI language) or one of these ISO-639-1 codes.
export const VOICE_LANGS = {
  en: 'English',
  he: 'עברית',
  ar: 'العربية',
  ru: 'Русский',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  uk: 'Українська',
  yi: 'ייִדיש',
};
export const VOICE_LANG_IDS = Object.keys(VOICE_LANGS);

export function isVoiceLangId(id) {
  return Object.prototype.hasOwnProperty.call(VOICE_LANGS, id);
}

// Effective STT language: an explicit pick wins; 'auto' follows the UI
// language (which itself may follow the browser). Always a concrete code —
// the request never goes out without one.
export function resolveVoiceLang(voicePref, uiPref = 'auto') {
  if (isVoiceLangId(voicePref)) return voicePref;
  return resolveLang(uiPref);
}
