// OPENUI phase 3 — the bugs the verifier found once the cards lived in one place.
//   · exactly ONE blocking card owns the keyboard: the most recent question /
//     permission; Enter on a focused question option never approves a permission
//   · the screenshot lightbox owns Escape while open — it closes, nothing answers
//   · a stale permission (the transcript moved on) freezes: no Allow/Deny, no keys
//   · a closed question takes no answers (the plain-message fallback is gone)
//   · the screenshot strip wraps on a narrow RTL pane instead of clipping
//   · a Table past 200 rows says "showing 200 of N"
// happy-dom + real react-dom/client, fetch stubbed.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, act, createRoot, w, ChatPane, OpenUICard, preloadOpenUI, ScreenshotCard, PermissionCard, prefs;
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
const question = (extra = {}) => ({ id: 'q1', kind: 'tool-use', name: 'AskUserQuestion', toolUseId: 'tu_1', ts: 10, input: { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }] }, ...extra });
const perm = (extra = {}) => ({ id: 'p1', kind: 'permission-request', requestId: 'perm_1', toolName: 'Bash', input: { command: 'git push' }, ts: 11, ...extra });
const pane = (events, extra = {}) => h(ChatPane, { sessionId: 'sess_t', events, mode: 'full', awaiting: true, ...extra });
const permPosts = () => posts.filter((p) => /perm/.test(p.url) || /permission/.test(p.url));
const questionPosts = () => posts.filter((p) => /question|\/message/.test(p.url));

test('one key owner: with a live question AND a newer permission, only the permission owns Enter/Escape; the question is frozen', async () => {
  posts = [];
  const { host, root } = await mount(pane([question(), perm()]));
  expect(host.querySelectorAll('[data-live]').length).toBe(1);
  expect(host.querySelector('[data-permission-card]').getAttribute('data-live')).toBe('true');
  expect(host.querySelector('[data-question-card]').getAttribute('data-question-state')).toBe('closed');
  expect(host.querySelector('[data-question-closed]')).toBeTruthy();
  await key('Enter');
  expect(permPosts().length).toBe(1);
  expect(questionPosts().length).toBe(0);
  await act(async () => root.unmount());
});

test('one key owner: Enter while a question option is focused activates THAT option, never a permission behind it', async () => {
  posts = [];
  // question is the newer card → it owns keys; an older unanswered permission is stale
  const { host, root } = await mount(pane([perm(), question({ id: 'q2', ts: 12 })]));
  expect(host.querySelector('[data-permission-card]').getAttribute('data-permission-card')).toBe('stale');
  expect(host.querySelector('[data-permission-card] button')).toBeNull(); // no Allow/Deny on a dead card
  expect(host.querySelector('[data-question-card]').getAttribute('data-live')).toBe('true');
  const first = host.querySelector('button[data-opt]');
  expect(document.activeElement).toBe(first); // the live question focused its first option
  await key('Escape'); // skips the question — must NOT deny the permission
  expect(permPosts().length).toBe(0);
  expect(questionPosts().length).toBe(1); // '(no answer)' delivered through the question channel
  await act(async () => root.unmount());
});

test('lightbox: Escape closes the lightbox only — no request behind it is answered', async () => {
  posts = [];
  const shots = [{ id: 's1', url: '/__host/a.png', caption: 'one', ts: 1 }];
  const { host, root } = await mount(h('div', null, h(ScreenshotCard, { shots }), h(PermissionCard, { sessionId: 'sess_t', event: perm(), live: true })));
  expect(host.querySelector('[data-permission-card]').getAttribute('data-live')).toBe('true');
  await act(async () => { host.querySelector('button[title]').click(); });
  expect(document.querySelector('[data-lightbox]')).toBeTruthy();
  await key('Escape');
  expect(document.querySelector('[data-lightbox]')).toBeNull();
  expect(permPosts().length).toBe(0);
  // with the lightbox gone the permission owns Escape again
  await key('Escape');
  expect(permPosts().length).toBe(1);
  await act(async () => root.unmount());
});

test('closed question: options are disabled and a click posts nothing', async () => {
  posts = [];
  const { host, root } = await mount(pane([question({ answered: 'deny' })], { awaiting: false }));
  const red = [...host.querySelectorAll('button')].find((b) => /Red/.test(b.textContent));
  expect(red.disabled).toBe(true);
  await act(async () => { red.click(); await new Promise((r) => setTimeout(r, 15)); });
  expect(posts.length).toBe(0);
  expect(host.querySelector('[data-question-closed]')).toBeTruthy();
  expect(host.querySelector('button[data-opt]')).toBeNull();
  await act(async () => root.unmount());
});

test('stale permission: an unanswered request followed by a turn result freezes; the newest one is still live', () => {
  const html = render(pane([perm(), { id: 'r', kind: 'result', text: '', isError: false, ts: 12 }, perm({ id: 'p2', requestId: 'perm_2', ts: 13 })]));
  expect(html).toContain('data-permission-card="stale"');
  expect(html).toContain('the session moved on');
  expect(html).toContain('data-permission-card="open"');
  expect((html.match(/data-live="true"/g) || []).length).toBe(1);
});

test('screenshot strip wraps (no clipped thumbs, "more" stays) on a narrow RTL pane', () => {
  const shots = [1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, url: `/__host/${i}.png`, caption: `Step ${i}`, ts: i }));
  const html = render(h(ScreenshotCard, { shots }));
  const strip = html.match(/<button[^>]*data-screenshot-strip[^>]*>/)[0];
  expect(strip).toContain('flex-wrap');
  expect(strip).toContain('text-start'); // logical, not text-left
  expect(strip).not.toContain('items-end');
  expect(html).toContain('more ›');
});

test('Table past 200 rows shows "showing 200 of N rows"', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => `[${i + 1}, "row ${i + 1}"]`).join(', ');
  const { host, root, flush } = await mount(h(OpenUICard, { sessionId: 's1', event: { kind: 'openui', ui: `root = Stack([tbl])\ntbl = Table(["#", "item"], [${rows}])` } }));
  await flush();
  expect(host.querySelectorAll('tbody tr').length).toBe(200);
  const note = host.querySelector('[data-table-truncated]');
  expect(note.getAttribute('data-table-truncated')).toBe('250');
  expect(note.textContent).toBe('showing 200 of 250 rows');
  await act(async () => root.unmount());
});
