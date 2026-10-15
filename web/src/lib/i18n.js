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
import { strings as telemetryEn } from '../locales/en/telemetry.js';
import { strings as telemetryHe } from '../locales/he/telemetry.js';
import { strings as wizardHe } from '../locales/he/wizard.js';
import { strings as setupEn } from '../locales/en/setup.js';
import { strings as setupHe } from '../locales/he/setup.js';
import { strings as agentsEn } from '../locales/en/agents.js';
import { strings as agentsHe } from '../locales/he/agents.js';
import { strings as memoryEn } from '../locales/en/memory.js';
import { strings as memoryHe } from '../locales/he/memory.js';
import { strings as extEn } from '../locales/en/ext.js';
import { strings as extHe } from '../locales/he/ext.js';

// Core (settings/common) + per-module fragments. Fragments are authored per
// area so localization work never collides on one file.
const en = { ...coreEn, ...chromeEn, ...railEn, ...launcherEn, ...chatEn, ...dialogsEn, ...brainEn, ...hostEn, ...wizardEn, ...telemetryEn, ...setupEn, ...agentsEn, ...memoryEn, ...extEn };
const he = { ...coreHe, ...chromeHe, ...railHe, ...launcherHe, ...chatHe, ...dialogsHe, ...brainHe, ...hostHe, ...wizardHe, ...telemetryHe, ...setupHe, ...agentsHe, ...memoryHe, ...extHe };

const DICTS = { en, he };

export { LANGS, LANG_IDS };

export function currentLang() {
  return resolveLang(getPrefs().language);
}

// Latin runs (names, commands, URLs, paths) inside Hebrew text: wrap each in a
// first-strong isolate (U+2068 … U+2069) so the surrounding punctuation and the
// neighbouring Hebrew words keep their order ("ב-Docker", "(HTTPS)", "$ARIGAMI_DIR/x").
// Pure strings stay strings, so placeholders and titles are covered too.
const HEBREW = /[\u0590-\u05FF]/;
const LATIN_TOKEN = '[A-Za-z0-9$~/@#][\\w.:/\\-@$#%+=~?&*]*';
const LATIN_RUN = new RegExp(`${LATIN_TOKEN}(?: ${LATIN_TOKEN})*`, 'g');
export function isolateLatin(s) {
  if (!HEBREW.test(s)) return s;
  return s.replace(LATIN_RUN, (run) => {
    if (!/[A-Za-z]/.test(run)) return run;
    const m = run.match(/[.:?&\-,;*=+]+$/); // sentence punctuation belongs to the Hebrew sentence
    const tail = m ? m[0] : '';
    const body = tail ? run.slice(0, -tail.length) : run;
    return body ? `\u2068${body}\u2069${tail}` : run;
  });
}

// t('some.key', { name: 'x' }) — {name} placeholders are substituted.
export function t(key, vars) {
  const lang = currentLang();
  let s = DICTS[lang]?.[key];
  if (s == null) s = en[key];
  if (s == null) s = key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return lang === 'he' && !globalThis.__ARIGAMI_PLAIN_T ? isolateLatin(s) : s; // flag: test seam (test/_preload.ts) — tests compare exact literals
}

// Direction of a string by its first strong directional character. Neutral or
// empty content defaults to LTR — English, numbers, and punctuation stay
// left-aligned; only genuine RTL-script content (Hebrew, Arabic, …) flips to rtl.
// This avoids dir="auto"'s trap where a leading "/", digit, or space makes the
// field inherit the app's RTL direction and mis-aligns English text.
const RTL_STRONG = /[֐-׿؀-ۿ܀-ݏݐ-ݿ߀-߿ࡠ-ࣿיִ-ﭏﭐ-﷿ﹰ-﻿]/;
const LTR_STRONG = /[A-Za-zÀ-ʸͰ-ӿ]/;
// strongDirOf is the same scan but says null for neutral-only text, so a caller
// stitching several text runs together (markdown blocks) can keep looking.
export function strongDirOf(s) {
  for (const ch of s || '') {
    if (RTL_STRONG.test(ch)) return 'rtl';
    if (LTR_STRONG.test(ch)) return 'ltr';
  }
  return null;
}
export function dirOf(s) {
  return strongDirOf(s) || 'ltr';
}
// Direction attribute for a text field: its content's first strong direction, or
// undefined (= follow the app language) while it is empty / neutral ("/", "123").
// Native dir="auto" would fall back to LTR there, leaving a Hebrew UI's empty
// field with a left caret and a left-aligned Hebrew placeholder.
export function fieldDir(value) {
  return strongDirOf(value == null ? '' : String(value)) || undefined;
}

// Hook form — re-renders the component when the language pref changes.
export function useT() {
  const lang = () => getPrefs().language;
  useSyncExternalStore(subscribe, lang, lang);
  return t;
}
