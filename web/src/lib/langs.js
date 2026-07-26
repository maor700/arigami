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
