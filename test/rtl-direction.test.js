// RTL / bidi: text blocks take their own direction from their first strong
// character while the chrome follows the app language. Pure helpers, SSR
// renders asserting `dir` attributes, and a source guard against physical
// left/right utilities creeping back in.
import { test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
const h = (...a) => globalThis.__React.createElement(...a);

let React, render, prefs, i18n, Md, nodeDir, Truncate, Input, Textarea, TodoList, ChatPane;

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'rtl' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'he-IL', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  globalThis.__React = React;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  i18n = await import(web('lib/i18n.js'));
  ({ default: Md, nodeDir } = await import(web('components/Md.jsx')));
  ({ Truncate } = await import(web('components/Truncate.jsx')));
  ({ Input, Textarea } = await import(web('components/ui/input.jsx')));
  ({ TodoList, default: ChatPane } = await import(web('components/ChatPane.jsx')));
  prefs.setPrefs({ language: 'he' });
});

test('strongDirOf / dirOf / fieldDir: first strong character wins, neutral falls back', () => {
  const { strongDirOf, dirOf, fieldDir } = i18n;
  expect(strongDirOf('שלום world')).toBe('rtl');
  expect(strongDirOf('world שלום')).toBe('ltr');
  expect(strongDirOf('12:30 - פגישה')).toBe('rtl'); // digits and punctuation are neutral
  expect(strongDirOf('مرحبا')).toBe('rtl');
  expect(strongDirOf('')).toBeNull();
  expect(strongDirOf('123 / -')).toBeNull();
  expect(dirOf('123')).toBe('ltr'); // neutral → ltr (kept: message bubbles)
  expect(fieldDir('')).toBeUndefined(); // empty / neutral field follows the app language
  expect(fieldDir('/')).toBeUndefined();
  expect(fieldDir('שלום')).toBe('rtl');
  expect(fieldDir('hello')).toBe('ltr');
});

test('nodeDir: inline code is ignored, nested text is found, nothing strong → ltr', () => {
  const text = (value) => ({ type: 'text', value });
  const el = (tagName, ...children) => ({ type: 'element', tagName, children });
  expect(nodeDir(el('p', el('code', text('Rail.jsx')), text(' מכיל באג')))).toBe('rtl');
  expect(nodeDir(el('li', el('p', text('hello שלום'))))).toBe('ltr');
  expect(nodeDir(el('ul', el('li', text('1. ')), el('li', text('פריט'))))).toBe('rtl');
  expect(nodeDir(el('p', text('123')))).toBe('ltr');
});

const dirsOf = (html, tag) => [...html.matchAll(new RegExp(`<${tag}[ >][^>]*`, 'g'))].map((m) => (m[0].match(/dir="(\w+)"/) || [])[1]);

test('Md: every block carries its own dir; Hebrew list in an English doc and vice versa; code stays ltr', () => {
  const he = '- פריט ראשון\n- פריט שני\n\n1. אחד\n2. שניים\n\n> ציטוט בעברית\n\n| קובץ | שורות |\n|---|---|\n| Rail.jsx | 12 |\n\n## כותרת\n\nפסקה עם `code` באמצע';
  const html = render(h(Md, null, he));
  expect(dirsOf(html, 'ul')).toEqual(['rtl']);
  expect(dirsOf(html, 'ol')).toEqual(['rtl']);
  expect(dirsOf(html, 'li')).toEqual([undefined, undefined, undefined, undefined]); // items inherit their list's side
  expect(dirsOf(html, 'blockquote')).toEqual(['rtl']);
  expect(dirsOf(html, 'table')).toEqual(['rtl']);
  expect(dirsOf(html, 'h2')).toEqual(['rtl']);
  expect(dirsOf(html, 'p').every((d) => d === 'rtl')).toBe(true);
  const en = render(h(Md, null, '- first\n- second with עברית\n\n> a quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = "שלום";\n```'));
  expect(dirsOf(en, 'ul')).toEqual(['ltr']);
  expect(dirsOf(en, 'blockquote')).toEqual(['ltr']);
  expect(dirsOf(en, 'table')).toEqual(['ltr']);
  expect(dirsOf(en, 'pre')).toEqual(['ltr']);
  // a Hebrew paragraph that starts with inline code is still Hebrew
  expect(dirsOf(render(h(Md, null, '`Rail.jsx` מכיל באג')), 'p')).toEqual(['rtl']);
});

test('Truncate: user text gets its own dir (ellipsis at its end) and aligns to the UI start edge; neutral text stays untouched', () => {
  const withDir = render(h(Truncate, { text: 'Fix bug', dir: 'ltr', className: 'min-w-0' }));
  expect(withDir).toContain('dir="ltr"');
  expect(withDir).toContain('ui-start');
  // no dir given: it is read off the text, so the ellipsis lands on the right end
  expect(render(h(Truncate, { text: 'שלום עולם' }))).toContain('dir="rtl"');
  expect(render(h(Truncate, { text: 'Hello' }))).toContain('dir="ltr"');
  const neutral = render(h(Truncate, { text: '2024' }));
  expect(neutral).not.toContain('dir=');
  expect(neutral).not.toContain('ui-start');
});

test('Input / Textarea: dir="auto" on a controlled field resolves from the value, empty follows the UI', () => {
  const noop = () => {};
  expect(render(h(Textarea, { dir: 'auto', value: '', onChange: noop }))).not.toContain('dir=');
  expect(render(h(Textarea, { dir: 'auto', value: '/', onChange: noop }))).not.toContain('dir=');
  expect(render(h(Textarea, { dir: 'auto', value: 'שלום', onChange: noop }))).toContain('dir="rtl"');
  expect(render(h(Input, { dir: 'auto', value: 'hello', onChange: noop }))).toContain('dir="ltr"');
  expect(render(h(Input, { dir: 'ltr', value: 'שלום', onChange: noop }))).toContain('dir="ltr"'); // explicit wins
});

test('TodoList: each row takes the direction of its own label (icon on the text side)', () => {
  const html = render(h(TodoList, { todos: [{ content: 'לתקן את הסרגל', status: 'pending' }, { content: 'Write tests', status: 'pending' }] }));
  expect(dirsOf(html, 'li')).toEqual(['rtl', 'ltr']);
});

test('ChatPane: each message block takes its own direction, whatever the app language is', () => {
  const events = [
    { id: 'u1', seq: 1, kind: 'user', text: 'תקן את הבאג בסרגל', ts: 1 },
    { id: 'u2', seq: 2, kind: 'user', text: 'Please run the tests', ts: 2 },
    { id: 'u3', seq: 3, kind: 'user', text: '12:30 - פגישה עם הצוות', ts: 3 },
    { id: 'a1', seq: 4, kind: 'assistant-text', text: '- פריט ראשון\n- פריט שני\n\nפסקה בעברית', ts: 4 },
    { id: 'a2', seq: 5, kind: 'assistant-text', text: '- first item\n- second item', ts: 5 },
  ];
  for (const lang of ['he', 'en']) {
    prefs.setPrefs({ language: lang });
    const html = render(h(ChatPane, { session: { id: 'sess_t', metadata: { chatMode: 'full' }, claude: { state: 'idle' } }, events, chatLoaded: true }));
    const bubbles = [...html.matchAll(/<div dir="(\w+)" data-user-msg/g)].map((m) => m[1]);
    expect(bubbles).toEqual(['rtl', 'ltr', 'rtl']);
    const uls = [...html.matchAll(/<ul dir="(\w+)"/g)].map((m) => m[1]);
    expect(uls).toEqual(['rtl', 'ltr']);
  }
  prefs.setPrefs({ language: 'he' });
});

test('source guard: no physical left/right utilities in the app (use logical ms-/me-/ps-/pe-/start-/end-/text-start)', () => {
  const ALLOW = new Set(['components/StyleGuide.jsx', 'components/DiffCard.jsx', 'components/VoiceHUD.jsx', 'components/DiffView.jsx', 'components/ui/toast.jsx', 'components/ui/_menu.jsx']);
  const bad = /(^|[\s"'`:[])(-?(ml|mr|pl|pr)-[0-9[]|text-(left|right)(?=[\s"'`]|$)|float-(left|right)|border-(l|r)(?=[\s"'`]|-[0-9a-z[]))/;
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.jsx') && !ALLOW.has(path.relative(web(''), p))) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (bad.test(line.replace(/\b(rtl|ltr):\S+/g, ''))) hits.push(`${path.relative(web(''), p)}:${i + 1}`); });
      }
    }
  };
  walk(web(''));
  expect(hits).toEqual([]);
});

test('CSS: .md blocks no longer rely on unicode-bidi: plaintext; ui-start exists', () => {
  const css = fs.readFileSync(web('index.css'), 'utf8');
  expect(css).toContain('.ui-start');
  expect(css).toMatch(/html\[dir='rtl'\] \.ui-start\[dir='ltr'\]/);
  expect(css).not.toMatch(/\.md li,[\s\S]{0,120}unicode-bidi:\s*plaintext/);
});
