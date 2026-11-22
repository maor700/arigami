// First-run UX (web): Claude and Codex are two EQUAL cards, and the repo picker's pure logic.
// Same no-DOM approach as setup-web.test.js: react-dom/server against a small window stub.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
let React, render, prefs, EngineConnect, anyEngineConnected, picker;

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} } }, querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  ({ default: EngineConnect, anyEngineConnected } = await import(web('components/setup/EngineConnect.jsx')));
  picker = await import(web('lib/repo-picker.js'));
});
const h = (C, props) => React.createElement(C, props);

test('Claude, Codex and Gemini render as three equal cards with the same structure (en + he)', () => {
  const ENGINES = ['claude', 'codex', 'gemini'];
  const idle = { ok: false, data: { cli: true } };
  // each card's own markup: from its data-engine marker to the end of its <section>
  const cards = (html) => {
    const at = ENGINES.map((e) => html.indexOf(`data-engine="${e}"`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at); // rendered in this order
    return at.map((i) => html.slice(i, html.indexOf('</section>', i)));
  };
  const shape = (card) => card.replace(/>[^<]*</g, '><').replace(/data-engine="[a-z]+"/, ''); // tags + classes, no copy
  for (const lang of ['en', 'he']) {
    prefs.setPrefs({ language: lang });
    const html = render(h(EngineConnect, { engines: { claude: idle, codex: idle, gemini: idle } }));
    expect((html.match(/data-engine="/g) || []).length).toBe(3);
    const [claude, codex, gemini] = cards(html);
    for (const card of [claude, codex, gemini]) {
      expect((card.match(/<li/g) || []).length).toBe(3); // three numbered steps each
      expect((card.match(/<h3/g) || []).length).toBe(1); // one title
      expect(card).toContain('<button'); // one primary action
    }
    expect(html).not.toMatch(/setup\.engine\.[a-z.0-9]+/); // no raw i18n keys
    // equal visual weight: the three primary buttons use the same classes
    const btn = (s) => /<button[^>]*class="([^"]*)"/.exec(s)[1];
    expect(btn(codex)).toBe(btn(claude));
    expect(btn(gemini)).toBe(btn(claude));
    // same structure down to the element: only the words differ — except that Claude and Codex also take a
    // pasted token (one more secondary button); Gemini signs in with Google only
    const secondary = (s) => (s.match(/<button/g) || []).length;
    expect(shape(codex)).toBe(shape(claude));
    expect(secondary(claude)).toBe(2);
    expect(secondary(codex)).toBe(2);
    expect(secondary(gemini)).toBe(1);
    const sansToken = (s) => { const i = s.indexOf('<button', s.indexOf('<button') + 1); return i < 0 ? s : s.slice(0, i) + s.slice(s.indexOf('</button>', i) + 9); };
    expect(shape(gemini)).toBe(shape(sansToken(claude)));
  }
  prefs.setPrefs({ language: 'en' });
  const en = render(h(EngineConnect, { engines: {} }));
  expect(en).toContain('Connect Claude');
  expect(en).toContain('Connect Codex');
  expect(en).toContain('Connect Gemini');
});

test('a connected engine turns its card green and does not hide the other one', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(EngineConnect, { engines: { claude: { ok: false, data: { cli: true } }, codex: { ok: true, data: { cli: true } } } }));
  expect(html).toContain('data-engine="codex" data-connected="true"');
  expect(html).toContain('data-engine="claude" data-connected="false"');
  expect(html).toContain('Codex is connected');
  expect(html).toContain('Connect Claude'); // still offered — and not an inert "optional" label
  // the same holds for the third engine, in both directions
  const g = render(h(EngineConnect, { engines: { claude: { ok: false, data: { cli: true } }, codex: { ok: false, data: { cli: true } }, gemini: { ok: true, data: { cli: true } } } }));
  expect(g).toContain('data-engine="gemini" data-connected="true"');
  expect(g).toContain('Gemini is connected');
  expect(g).toContain('Connect Claude');
  expect(g).toContain('Connect Codex');
  expect(html).toContain('Connect Gemini');
});

test('a missing CLI shows the install line for that engine only', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(EngineConnect, { engines: { claude: { ok: false, data: { cli: false } }, codex: { ok: false, data: { cli: true } } } }));
  expect(html).toContain('npm i -g @anthropic-ai/claude-code');
  expect(html).not.toContain('npm i -g @openai/codex');
});

test('either engine alone satisfies the first-run gate', () => {
  expect(anyEngineConnected({ claude: { ok: false }, codex: { ok: true } })).toBe(true);
  expect(anyEngineConnected({ claude: { ok: true }, codex: null })).toBe(true);
  expect(anyEngineConnected({ claude: { ok: false }, codex: { ok: false } })).toBe(false);
  expect(anyEngineConnected({ claude: { ok: false }, codex: { ok: false }, gemini: { ok: true } })).toBe(true);
  expect(anyEngineConnected({ claude: { ok: false }, codex: { ok: false }, gemini: { ok: false } })).toBe(false);
  expect(anyEngineConnected(null)).toBe(false);
});

test('repo picker logic: request path, paging merge, keyboard, entry', () => {
  expect(picker.reposPath('')).toBe('/onboarding/github/repos');
  expect(picker.reposPath('  api ', 2)).toBe('/onboarding/github/repos?q=api&page=2');
  const a = { fullName: 'o/a' }, b = { fullName: 'o/b' };
  expect(picker.mergePage([a], [b], 1)).toEqual([b]);
  expect(picker.mergePage([a], [a, b], 2)).toEqual([a, b]);
  expect(picker.moveActive(-1, 'ArrowDown', 3)).toBe(0);
  expect(picker.moveActive(2, 'ArrowDown', 3)).toBe(0);
  expect(picker.moveActive(0, 'ArrowUp', 3)).toBe(2);
  expect(picker.moveActive(1, 'ArrowDown', 0)).toBe(-1);
  expect(picker.entryFromRepo({ name: 'site', fullName: 'me/site' })).toEqual({ name: 'site', source: 'me/site' });
});

// ---- Hebrew / RTL / server strings -------------------------------------------------------------
test('a fresh profile follows the browser language (auto), an explicit pick still wins', async () => {
  prefs.setPrefs({ language: 'not-a-language' }); // the sanitiser's fallback is the default
  expect(prefs.getPrefs().language).toBe('auto');
  const langs = await import(web('lib/langs.js'));
  globalThis.navigator = { language: 'he-IL', userAgent: 'test' };
  expect(langs.resolveLang('auto')).toBe('he');
  expect(langs.resolveLang('en')).toBe('en');
  globalThis.navigator = { language: 'fr-FR', userAgent: 'test' };
  expect(langs.resolveLang('auto')).toBe('en');
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
});

test('Latin runs inside Hebrew are bidi-isolated; sentence punctuation stays outside; English is untouched', async () => {
  const { isolateLatin } = await import(web('lib/i18n.js'));
  const FSI = '⁨', PDI = '⁩';
  expect(isolateLatin('חבר את Claude Code.')).toBe(`חבר את ${FSI}Claude Code${PDI}.`);
  expect(isolateLatin('שמור ב-Docker (HTTPS)')).toBe(`שמור ב-${FSI}Docker${PDI} (${FSI}HTTPS${PDI})`);
  expect(isolateLatin('הרץ `bin/host pair` כאן')).toBe(`הרץ \`${FSI}bin/host pair${PDI}\` כאן`);
  expect(isolateLatin('שלב 2 מתוך 9')).toBe('שלב 2 מתוך 9'); // digits alone need no isolate
  expect(isolateLatin('Connect Claude.')).toBe('Connect Claude.'); // no Hebrew: untouched
});

test('Hebrew strings point arrows the reading way: no "→" in prose (only the literal key-name hints)', async () => {
  const fs = await import('node:fs');
  const dir = path.join(ROOT, 'web/src/locales/he');
  for (const f of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const m = /^\s*'([^']+)':/.exec(line);
      if (!m || !line.includes('→')) continue;
      expect(['rail.dirLtr', 'rail.dirRtl', 'chat.navViewedFiles', 'chat.forward']).toContain(m[1]);
    }
  }
});

test('host-written strings a first-run person meets are shown in the UI language', async () => {
  const { serverText } = await import(web('lib/server-text.js'));
  prefs.setPrefs({ language: 'he' });
  expect(serverText('claude exited 1: Not logged in · Please run /login')).toContain('מחברים');
  expect(serverText('display :109 not reachable')).toContain('שולחן העבודה');
  expect(serverText('state mismatch — the pasted code is from a different login attempt; start over')).toContain('נסה שוב');
  expect(serverText('something unknown')).toBe('something unknown');
  prefs.setPrefs({ language: 'en' });
  expect(serverText('Not logged in · Please run /login')).toBe('Not signed in yet — connect Claude, Codex or Gemini first.');
});

test('the first-run chat card for Claude offers Codex as an equal card (one component for chat, Setup and wizard)', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(EngineConnect, { engines: { claude: { ok: false, data: { cli: true } }, codex: { ok: false, data: { cli: true } } }, sessionId: 's1' }));
  expect(html.indexOf('data-engine="claude"')).toBeGreaterThan(-1);
  expect(html.indexOf('data-engine="codex"')).toBeGreaterThan(html.indexOf('data-engine="claude"'));
});
