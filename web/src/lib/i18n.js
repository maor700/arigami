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

// Direction of a block of user/agent text. Not first-strong: a Hebrew sentence
// that opens with a product or file name ("Vite מפעיל…", "`Rail.jsx` מכיל באג")
// is still Hebrew, and laying it out LTR scrambles it. So the block is RTL once
// RTL letters make up a small share of its prose letters; identifiers, paths,
// URLs and hex/hashtag tokens are left out of the count (they are LTR islands,
// not the sentence's language). No letters at all → null, so callers choose the
// fallback: dirOf says LTR (English, numbers and punctuation stay left-aligned),
// fieldDir follows the app language. dir="auto" is avoided for the same reason
// as first-strong: a leading "/", digit or Latin word decides the whole block.
const RTL_LETTER = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u07C0-\u07FF\u0860-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const LTR_LETTER = /[A-Za-z\u00C0-\u02B8\u0370-\u04FF]/g;
// Below this share of RTL letters a block stays LTR ("Opened a PR for <name>").
export const RTL_SHARE = 0.2;
// LTR islands inside prose: URLs, e-mails, paths, dotted identifiers (".a.b",
// "Rail.jsx"), snake/env names, "#1E40AF" / "#123". Shared by the counter above
// and by bidiParts below, which wraps each one in an LTR isolate.
const ISLAND = new RegExp([
  '[a-z][a-z0-9+.-]*://[^\\s<>"\'`]*[^\\s<>"\'`.,;:!?)\\]]', // URL (trailing punctuation belongs to the sentence)
  '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+', // e-mail
  '(?:~|\\.{1,2})?/[\\w.@%+~-]+(?:/[\\w.@%+~-]+)*/?', // absolute / home / relative path
  '[\\w@.-]+(?:/[\\w.@%+~-]+)+/?', // a/b/c
  '\\$\\{?[A-Za-z_]\\w*\\}?', // $ENV
  '#[0-9A-Fa-f]{3,8}\\b|#\\d+\\b', // colours, issue numbers
  '\\.?[A-Za-z_][\\w-]*(?:\\.[A-Za-z_\\d][\\w-]*)+(?:\\(\\))?', // dotted identifiers / file names
  '[A-Za-z]\\w*_\\w+', // snake_case
].join('|'), 'g');

const count = (s, re) => (s.match(re) || []).length;
export function strongDirOf(s) {
  const text = String(s ?? '');
  const prose = text.replace(ISLAND, ' ');
  const rtl = count(prose, RTL_LETTER);
  const ltr = count(prose, LTR_LETTER);
  // only islands (a bare path or URL) → LTR; only neutrals ("123 / -") → undecided
  if (!rtl && !ltr) return count(text, LTR_LETTER) ? 'ltr' : null;
  return rtl >= RTL_SHARE * (rtl + ltr) ? 'rtl' : 'ltr';
}
// Split text into prose and LTR islands ({ ltr: '…' }) — only in RTL text (an
// English line needs no isolates): `rtl` says so for a fragment of a larger
// block (a link's text inside a Hebrew paragraph); left out, the text decides. Render each island as
// <bdi dir="ltr"> so its own neutrals ("#", "/", ".", "()") keep their places.
export function bidiParts(s, rtl = undefined) {
  const text = String(s ?? '');
  if (!(rtl ?? count(text, RTL_LETTER) > 0)) return [text];
  const out = [];
  let last = 0;
  for (const m of text.matchAll(ISLAND)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ ltr: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
// Direction of a short piece inside a larger block (an option of a question
// card): text in ONE script keeps its own direction, mixed text follows the
// block's — a 3-word label is too short for the share to mean much.
export function dirIn(s, context) {
  const prose = String(s ?? '').replace(ISLAND, ' ');
  if (context && count(prose, RTL_LETTER) && count(prose, LTR_LETTER)) return context;
  return dirOf(s);
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
