// Card input (multi-select + focus-scoped keys):
//   · a multiSelect question, or a card with several questions, collects picks
//     (toggleable checkboxes, a "select one or more" hint) and sends only on
//     Submit; a lone single-select question keeps one-tap
//   · question/permission keys act only while focus is inside the card; a
//     skip or deny waits through a short Undo window
//   · Esc interrupts the agent only on a second press (and never while a menu,
//     palette or dialog is open)
// happy-dom + real react-dom/client, fetch stubbed.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, act, createRoot, w, ChatPane, OpenUICard, preloadOpenUI, ScreenshotCard, PermissionCard, QuestionCard, prefs, esc;
const h = (...a) => React.createElement(...a);
let posts = [];
let origFetch;
const roots = [];

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '', search: '' };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    posts.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, url: String(url), json: async () => ({ ok: true }), text: async () => '{"ok":true}', headers: { get: () => 'application/json' } };
  };
  const { Window } = await import(path.join(ROOT, 'web/node_modules/happy-dom/lib/index.js'));
  w = new Window();
  globalThis.document = w.document;
  globalThis.HTMLElement = w.HTMLElement;
  globalThis.HTMLIFrameElement = w.HTMLIFrameElement;
  globalThis.Node = w.Node;
  globalThis.Event = w.Event;
  globalThis.KeyboardEvent = w.KeyboardEvent;
  globalThis.CustomEvent = w.CustomEvent;
  globalThis.getComputedStyle = w.getComputedStyle.bind(w);
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.addEventListener = (...a) => w.addEventListener(...a);
  globalThis.removeEventListener = (...a) => w.removeEventListener(...a);
  globalThis.dispatchEvent = (e) => w.dispatchEvent(e);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ act } = await import(path.join(ROOT, 'web/node_modules/react/index.js')));
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  ({ createRoot } = await import(path.join(ROOT, 'web/node_modules/react-dom/client.js')));
  prefs = await import(web('lib/prefs.js'));
  prefs.setPrefs({ language: 'en' });
  ({ default: ChatPane } = await import(web('components/ChatPane.jsx')));
  ({ default: OpenUICard, preloadOpenUI } = await import(web('components/OpenUICard.jsx')));
  await preloadOpenUI();
  ({ default: ScreenshotCard } = await import(web('components/ScreenshotCard.jsx')));
  ({ default: PermissionCard } = await import(web('components/PermissionCard.jsx')));
  ({ default: QuestionCard } = await import(web('components/QuestionCard.jsx')));
  esc = await import(web('lib/esc-interrupt.js'));
});
afterAll(async () => {
  for (const root of roots) { try { await act(async () => root.unmount()); } catch {} }
  if (origFetch) globalThis.fetch = origFetch;
});

async function mount(el) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(el));
  return { host, root, flush: () => act(async () => { await new Promise((r) => setTimeout(r, 10)); }) };
}
const key = async (k) => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 15)); });
const click = async (el) => act(async () => { el.click(); await new Promise((r) => setTimeout(r, 15)); });
const answerPosts = () => posts.filter((p) => /question\/answer|\/message/.test(p.url));
const permPosts = () => posts.filter((p) => /perm/.test(p.url) || /permission/.test(p.url));
const opt = (host, label) => [...host.querySelectorAll('button')].find((b) => b.textContent.includes(label));
const qcard = (questions, extra = {}) => h(QuestionCard, { sessionId: 'sess_q', live: true, event: { kind: 'tool-use', name: 'AskUserQuestion', toolUseId: 'tu_q', input: { questions }, ...extra } });
const single = { question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] };
const sections = { question: 'Which sections?', header: 'Sections', multiSelect: true, options: [{ label: 'Summary' }, { label: 'Details' }, { label: 'Next steps' }] };
const perm = () => ({ kind: 'permission-request', requestId: 'perm_k', toolName: 'Bash', input: { command: 'git push' } });
// Something outside every card that can hold focus — a menu trigger, the rail…
function outside() {
  const b = document.createElement('button');
  b.textContent = 'elsewhere';
  document.body.appendChild(b);
  return b;
}

test('single-select, single question: one tap still answers at once', async () => {
  posts = [];
  const { host, root } = await mount(qcard([single]));
  expect(host.querySelector('[data-question-submit]')).toBeNull();
  expect(host.querySelector('[data-multi-hint]')).toBeNull();
  await click(opt(host, 'Blue'));
  expect(answerPosts().length).toBe(1);
  expect(answerPosts()[0].body.answers).toEqual([{ question: 'Which color?', answer: 'Blue' }]);
  await act(async () => root.unmount());
});

test('multiSelect on a two-question card: picks collect, nothing is sent before Submit, all choices arrive', async () => {
  posts = [];
  const { host, root } = await mount(qcard([single, sections]));
  expect(host.querySelector('[data-multi-hint]').textContent).toBe('Select one or more');
  const submit = host.querySelector('[data-question-submit]');
  expect(submit.disabled).toBe(true);
  await click(opt(host, 'Red'));
  expect(answerPosts().length).toBe(0); // the first question no longer auto-sends the card
  await click(opt(host, 'Summary'));
  await click(opt(host, 'Next steps'));
  expect(answerPosts().length).toBe(0);
  expect(opt(host, 'Summary').getAttribute('aria-checked')).toBe('true');
  expect(opt(host, 'Next steps').getAttribute('aria-checked')).toBe('true');
  expect(opt(host, 'Details').getAttribute('aria-checked')).toBe('false');
  expect(host.querySelectorAll('[data-checkbox="on"]').length).toBe(2);
  // a single-select pick on a Submit card can still be changed
  await click(opt(host, 'Blue'));
  expect(host.querySelector('[data-question-submit]').disabled).toBe(false);
  await click(host.querySelector('[data-question-submit]'));
  expect(answerPosts().length).toBe(1);
  expect(answerPosts()[0].body.answers).toEqual([
    { question: 'Which color?', answer: 'Blue' },
    { question: 'Which sections?', answer: 'Summary, Next steps' },
  ]);
  expect(host.querySelector('[data-question-submit]')).toBeNull(); // sent → options freeze
  expect(opt(host, 'Details').disabled).toBe(true);
  await act(async () => root.unmount());
});

test('multiSelect alone: a second tap un-checks, Submit is required, digits toggle while focus is in the card', async () => {
  posts = [];
  const { host, root } = await mount(qcard([sections]));
  expect(document.activeElement).toBe(opt(host, 'Summary'));
  await click(opt(host, 'Details'));
  await click(opt(host, 'Details'));
  expect(opt(host, 'Details').getAttribute('aria-checked')).toBe('false');
  expect(host.querySelector('[data-question-submit]').disabled).toBe(true);
  await key('1');
  await key('3');
  expect(answerPosts().length).toBe(0);
  await click(host.querySelector('[data-question-submit]'));
  expect(answerPosts()[0].body.answers).toEqual([{ question: 'Which sections?', answer: 'Summary, Next steps' }]);
  await act(async () => root.unmount());
});

test('an echoed multiSelect answer shows every chosen option checked after a reload', () => {
  const html = render(qcard([sections], { answers: { 'Which sections?': 'Summary, Next steps' } }));
  expect((html.match(/data-checkbox="on"/g) || []).length).toBe(2);
  expect(html).not.toContain('data-question-submit');
});

test('skip on a Submit card is local and undoable', async () => {
  posts = [];
  const { host, root } = await mount(qcard([single, sections]));
  await click(opt(host, 'Red'));
  const skipBtns = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'skip this question');
  await click(skipBtns[skipBtns.length - 1]);
  expect(answerPosts().length).toBe(0);
  expect(host.querySelector('[data-question-submit]').disabled).toBe(false); // skipped counts as answered
  await click(host.querySelector('[data-undo]'));
  expect(opt(host, 'Summary')).toBeTruthy();
  expect(host.querySelector('[data-question-submit]').disabled).toBe(true);
  await act(async () => root.unmount());
  expect(answerPosts().length).toBe(0);
});

test('question keys: Esc/s/digits do nothing while focus is outside the card', async () => {
  posts = [];
  const { host, root } = await mount(qcard([single]));
  const other = outside();
  other.focus();
  for (const k of ['Escape', 's', '1']) await key(k);
  expect(answerPosts().length).toBe(0);
  expect(host.querySelector('[data-undo]')).toBeNull();
  expect(opt(host, 'Red').disabled).toBe(false);
  other.remove();
  await act(async () => root.unmount());
  expect(answerPosts().length).toBe(0);
});

test('question Esc inside the card skips with an Undo window; Undo puts the options back and sends nothing', async () => {
  posts = [];
  const { host, root } = await mount(qcard([single]));
  expect(host.contains(document.activeElement)).toBe(true);
  await key('Escape');
  expect(host.textContent).toContain('Skipping this question');
  expect(document.activeElement).toBe(host.querySelector('[data-undo]'));
  expect(answerPosts().length).toBe(0);
  await click(host.querySelector('[data-undo]'));
  expect(opt(host, 'Red').disabled).toBe(false);
  await act(async () => root.unmount());
  expect(answerPosts().length).toBe(0);
});

test('question skip is sent once the Undo window runs out', async () => {
  posts = [];
  const real = globalThis.setTimeout;
  const { host, root } = await mount(qcard([single]));
  let fire;
  globalThis.setTimeout = (fn, ms, ...a) => (ms === 5000 ? ((fire = fn), 1) : real(fn, ms, ...a));
  try {
    await key('s');
  } finally {
    globalThis.setTimeout = real;
  }
  expect(typeof fire).toBe('function');
  await act(async () => { fire(); await new Promise((r) => real(r, 15)); });
  expect(answerPosts().length).toBe(1);
  expect(answerPosts()[0].body.answers).toEqual([{ question: 'Which color?', answer: null }]);
  expect(host.textContent).toContain('skipped');
  await act(async () => root.unmount());
});

test('permission keys: Esc/n with focus outside the card never deny', async () => {
  posts = [];
  const { host, root } = await mount(h(PermissionCard, { sessionId: 'sess_p', event: perm(), live: true }));
  const other = outside();
  other.focus();
  for (const k of ['Escape', 'n', 'Enter', 'y']) await key(k);
  expect(permPosts().length).toBe(0);
  expect(host.querySelector('[data-undo]')).toBeNull();
  other.remove();
  await act(async () => root.unmount());
  expect(permPosts().length).toBe(0);
});

test('permission deny (key or click) waits for Undo; Undo restores Allow/Deny and sends nothing', async () => {
  posts = [];
  const { host, root } = await mount(h(PermissionCard, { sessionId: 'sess_p', event: perm(), live: true }));
  await key('n');
  expect(host.textContent).toContain('Denying');
  expect(permPosts().length).toBe(0);
  await click(host.querySelector('[data-undo]'));
  const deny = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Deny');
  expect(deny).toBeTruthy();
  await click(deny);
  expect(host.querySelector('[data-undo]')).toBeTruthy();
  expect(permPosts().length).toBe(0);
  await act(async () => root.unmount()); // leaving mid-countdown still sends the deny
  expect(permPosts().length).toBe(1);
  expect(JSON.stringify(permPosts()[0].body)).toContain('deny');
});

test('permission: Enter on a focused Deny button does not approve', async () => {
  posts = [];
  const { host, root } = await mount(h(PermissionCard, { sessionId: 'sess_p', event: perm(), live: true }));
  const deny = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Deny');
  deny.focus();
  await key('Enter');
  expect(permPosts().length).toBe(0);
  await act(async () => root.unmount());
});

test('Esc-to-interrupt needs a second Esc on the same session within the window', () => {
  const t0 = 1000;
  const first = esc.escInterruptStep(null, 's1', t0);
  expect(first.fire).toBe(false);
  expect(esc.escInterruptStep(first.arm, 's1', t0 + esc.ESC_INTERRUPT_MS - 1).fire).toBe(true);
  expect(esc.escInterruptStep(first.arm, 's1', t0 + esc.ESC_INTERRUPT_MS + 1).fire).toBe(false); // too slow → re-arms
  expect(esc.escInterruptStep(first.arm, 's2', t0 + 10).fire).toBe(false); // another session
});

test('an open menu or dialog owns Esc (overlayOpen)', () => {
  expect(esc.overlayOpen(document)).toBe(false);
  const m = document.createElement('div');
  m.setAttribute('role', 'menu');
  document.body.appendChild(m);
  expect(esc.overlayOpen(document)).toBe(true);
  m.remove();
});
