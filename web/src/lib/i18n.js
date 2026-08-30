// Minimal i18n: t(key, vars) resolves against the active language's dictionary,
// falling back to English, then to the key itself — so untranslated strings show
// English (never a blank), and coverage can grow incrementally.
import { useSyncExternalStore } from 'react';
import { getPrefs, subscribe } from './prefs.js';
import { resolveLang, LANGS, LANG_IDS } from './langs.js';
import { en as coreEn } from '../locales/en.js';
import { he as coreHe } from '../locales/he.js';
import { strings as chromeEn } from '../locales/en/chrome.js';
import { strings as chromeHe } from '../locales/he/chrome.js';
import { strings as railEn } from '../locales/en/rail.js';
import { strings as railHe } from '../locales/he/rail.js';
import { strings as launcherEn } from '../locales/en/launcher.js';
import { strings as launcherHe } from '../locales/he/launcher.js';
import { strings as chatEn } from '../locales/en/chat.js';
import { strings as chatHe } from '../locales/he/chat.js';
import { strings as dialogsEn } from '../locales/en/dialogs.js';
import { strings as dialogsHe } from '../locales/he/dialogs.js';
import { strings as brainEn } from '../locales/en/brain.js';
import { strings as brainHe } from '../locales/he/brain.js';
import { strings as hostEn } from '../locales/en/host.js';
import { strings as hostHe } from '../locales/he/host.js';
import { strings as wizardEn } from '../locales/en/wizard.js';
import { strings as wizardHe } from '../locales/he/wizard.js';

// Core (settings/common) + per-module fragments. Fragments are authored per
// area so localization work never collides on one file.
const en = { ...coreEn, ...chromeEn, ...railEn, ...launcherEn, ...chatEn, ...dialogsEn, ...brainEn, ...hostEn, ...wizardEn };
const he = { ...coreHe, ...chromeHe, ...railHe, ...launcherHe, ...chatHe, ...dialogsHe, ...brainHe, ...hostHe, ...wizardHe };

const DICTS = { en, he };

export { LANGS, LANG_IDS };

export function currentLang() {
  return resolveLang(getPrefs().language);
}

// t('some.key', { name: 'x' }) — {name} placeholders are substituted.
export function t(key, vars) {
  const lang = currentLang();
  let s = DICTS[lang]?.[key];
  if (s == null) s = en[key];
  if (s == null) s = key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

// Direction of a string by its first strong directional character. Neutral or
// empty content defaults to LTR — English, numbers, and punctuation stay
// left-aligned; only genuine RTL-script content (Hebrew, Arabic, …) flips to rtl.
// This avoids dir="auto"'s trap where a leading "/", digit, or space makes the
// field inherit the app's RTL direction and mis-aligns English text.
const RTL_STRONG = /[֐-׿؀-ۿ܀-ݏݐ-ݿ߀-߿ࡠ-ࣿיִ-ﭏﭐ-﷿ﹰ-﻿]/;
const LTR_STRONG = /[A-Za-zÀ-ʸͰ-ӿ]/;
export function dirOf(s) {
  for (const ch of s || '') {
    if (RTL_STRONG.test(ch)) return 'rtl';
    if (LTR_STRONG.test(ch)) return 'ltr';
  }
  return 'ltr';
}

// Hook form — re-renders the component when the language pref changes.
export function useT() {
  useSyncExternalStore(subscribe, () => getPrefs().language);
  return t;
}
