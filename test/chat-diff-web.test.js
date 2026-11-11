// SSR render of the inline diff card + the Simple-mode edit summary.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
let React, render, prefs, DiffCard, ChatPane, store;
const h = (...a) => React.createElement(...a);

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.document.createElement = () => ({ style: {}, getContext: () => null, setAttribute() {}, appendChild() {}, removeChild() {}, addEventListener() {}, getBoundingClientRect: () => ({}) });
  globalThis.getComputedStyle = () => ({});
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  store = await import(web('lib/store.js'));
  ({ default: DiffCard } = await import(web('components/DiffCard.jsx')));
  ({ default: ChatPane } = await import(web('components/ChatPane.jsx')));
});

const edit = (extra = {}) => ({ kind: 'tool-use', name: 'Edit', toolUseId: 'u1', input: { file_path: '/repo/src/util.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc' }, ...extra });

test('card: header, stats, ltr code body, gutter, tinted rows', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(DiffCard, { event: edit(), sessionId: 's' }));
  expect(html).toContain('data-diff-card="/repo/src/util.ts"');
  expect(html).toContain('/repo/src/');
  expect(html).toContain('<bdi');
  expect(html).toContain('util.ts');
  expect(html).toContain('+1');
  expect(html).toContain('−1');
  expect(html).toContain('dir="ltr"');
  expect(html).toContain('data-row="del"');
  expect(html).toContain('data-row="add"');
  expect(html).toContain('data-row="ctx"');
  expect(html).toContain('Copy path');
  expect(html).not.toContain('Show ');
});

test('card: long diff previews 14 lines with a Show more toggle; a long new file starts collapsed', () => {
  prefs.setPrefs({ language: 'en' });
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const big = render(h(DiffCard, { event: edit({ input: { file_path: 'a.ts', old_string: '', new_string: body } }), sessionId: 's' }));
  expect((big.match(/data-row="add"/g) || []).length).toBe(14);
  expect(big).toContain('Show 26 more lines');
  const wr = render(h(DiffCard, { event: { kind: 'tool-use', name: 'Write', input: { file_path: 'new.txt', content: body } }, sessionId: 's' }));
  expect(wr).not.toContain('data-row=');
  expect(wr).toContain('Show all 40 lines');
  expect(wr).toContain('new file');
});

test('card: failed edit shows the muted not-applied note; Hebrew labels, code stays ltr', () => {
  prefs.setPrefs({ language: 'he' });
  const html = render(h(DiffCard, { event: edit({ input: { file_path: '/repo/דוח.md', old_string: 'x', new_string: 'y' } }), result: { kind: 'tool-result', isError: true, text: 'String not found' }, sessionId: 's' }));
  expect(html).toContain('data-not-applied="1"');
  expect(html).toContain('לא הוחל');
  expect(html).toContain('String not found');
  expect(html).toContain('דוח.md');
  prefs.setPrefs({ language: 'en' });
});

test('card: clipped event renders the loading placeholder', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(DiffCard, { event: { kind: 'tool-use', name: 'Write', seq: 3, clipped: true, input: { file_path: 'big.ts', content: 'x…' } }, sessionId: 's' }));
  expect(html).toContain('data-diff-loading');
  expect(html).toContain('big.ts');
});

const turn = (withEdit) => [
  { kind: 'user', text: 'do it', ts: 1 },
  { kind: 'tool-use', name: 'Bash', toolUseId: 'b1', input: { command: 'ls' }, ts: 2 },
  ...(withEdit ? [edit({ ts: 3 }), { kind: 'tool-result', toolUseId: 'u1', text: 'updated', ts: 4 }] : []),
  { kind: 'assistant-text', text: 'done', ts: 5 },
  { kind: 'result', ts: 6 },
];

test('ChatPane: full mode shows the card by default and hides the applied result row; simple mode adds the summary only when files changed', () => {
  prefs.setPrefs({ language: 'en' });
  const full = render(h(ChatPane, { sessionId: 's', events: turn(true), mode: 'full' }));
  expect(full).toContain('data-diff-card');
  expect(full).not.toContain('>updated<');
  const simple = render(h(ChatPane, { sessionId: 's', events: turn(true), mode: 'simple' }));
  expect(simple).toContain('data-edit-summary="1"');
  expect(simple).toContain('Edited 1 file');
  expect(simple).toContain('+1');
  expect(simple).not.toContain('data-diff-card'); // collapsed until tapped
  const none = render(h(ChatPane, { sessionId: 's', events: turn(false), mode: 'simple' }));
  expect(none).not.toContain('data-edit-summary');
  expect(none).toContain('data-behind-scenes');
});
