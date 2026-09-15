// OPENUI pilot (web): the render_ui card.
//   · the library's agent-facing prompt is what skills/render-ui/SKILL.md carries
//     (generated — a library change without a regen fails here)
//   · ChatPane routes kind:'openui' to OpenUICard; stats, charts (plain SVG),
//     tables and markdown render with the cockpit's own components
//   · Button / Form submit POST …/message like an ext-card, with the form's
//     field values as a json block
//   · bad input (unknown component, garbage, empty, oversize) → the quiet
//     fallback with the source behind a toggle; the transcript never throws
// Offline: fetch is stubbed; the DOM is happy-dom from web/node_modules.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, act, createRoot, ChatPane, OpenUICard, preloadOpenUI, openuiProblem, actionToMessage, FIXTURES, lib, gen;
const h = (...a) => React.createElement(...a);
let posts = [];
let origFetch;

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
    posts.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, url: String(url), json: async () => ({ ok: true }), text: async () => '{"ok":true}', headers: { get: () => 'application/json' } };
  };
  const { Window } = await import(path.join(ROOT, 'web/node_modules/happy-dom/lib/index.js'));
  const w = new Window();
  globalThis.document = w.document;
  globalThis.HTMLElement = w.HTMLElement;
  globalThis.Node = w.Node;
  globalThis.HTMLIFrameElement = w.HTMLIFrameElement; // react-dom's commit-time focus check
  globalThis.Event = w.Event;
  globalThis.CustomEvent = w.CustomEvent;
  globalThis.getComputedStyle = w.getComputedStyle.bind(w);
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.addEventListener = (...a) => w.addEventListener(...a);
  globalThis.removeEventListener = (...a) => w.removeEventListener(...a);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ act } = await import(path.join(ROOT, 'web/node_modules/react/index.js')));
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  ({ createRoot } = await import(path.join(ROOT, 'web/node_modules/react-dom/client.js')));
  ({ default: ChatPane } = await import(web('components/ChatPane.jsx')));
  ({ default: OpenUICard, preloadOpenUI } = await import(web('components/OpenUICard.jsx')));
  ({ openuiProblem } = await preloadOpenUI()); // the lazy chunk, resolved up front so mounts are deterministic
  ({ actionToMessage } = await import(web('openui/message.js')));
  ({ FIXTURES } = await import(web('openui/fixtures.js')));
  lib = await import(web('openui/library.jsx'));
  gen = await import(path.join(ROOT, 'web/scripts/openui-prompt.mjs'));
});

afterAll(() => {
  if (origFetch) globalThis.fetch = origFetch;
});

const fx = (name) => FIXTURES.find((f) => f.name.startsWith(name)).ui;

// Mount into happy-dom (the Renderer resolves its tree in effects — SSR gives only the shell).
async function mount(el) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return { host, root, flush: () => act(async () => { await new Promise((r) => setTimeout(r, 10)); }) };
}
const card = (ui, extra = {}) => h(OpenUICard, { sessionId: 's1', event: { kind: 'openui', ui, ...extra } });

/* ---------- prompt / skill ------------------------------------------------ */

test('the skill file is the generated prompt: signatures of every component, rules, examples', () => {
  const md = fs.readFileSync(gen.SKILL_FILE, 'utf8');
  expect(md).toBe(gen.skillText());
  const prompt = lib.openuiPrompt();
  for (const name of Object.keys(lib.library.components)) expect(prompt).toMatch(new RegExp(`^${name}\\(`, 'm'));
  expect(prompt).toContain('POSITIONAL');
  for (const ex of lib.OPENUI_EXAMPLES) expect(openuiProblem(ex)).toBeNull(); // the examples we teach must render
  // the MCP tool carries the same signature block
  const mcp = fs.readFileSync(path.join(ROOT, 'mcp/host-mcp.js'), 'utf8');
  expect(mcp).toContain("name: 'render_ui'");
  expect(mcp).toContain('OPENUI_SIGNATURES');
  expect(lib.openuiSignatures()).toContain('BarChart(labels: string[], values: number[], title?: string)');
});

/* ---------- pre-check + message shape (pure) ------------------------------ */

test('openuiProblem: good blocks pass; empty / garbage / unknown component / oversize are named', () => {
  for (const f of FIXTURES.filter((f) => !/fallback/.test(f.name))) expect(openuiProblem(f.ui)).toBeNull();
  expect(openuiProblem('')).toBe('empty');
  expect(openuiProblem(undefined)).toBe('empty');
  expect(openuiProblem('this is not openui ((( ')).toBe('no-root');
  expect(openuiProblem(fx('unknown'))).toBe('unknown-component:PieChart');
  expect(openuiProblem('root = Stack([])\n' + '#'.repeat(70 * 1024))).toBe('too-long');
});

test('actionToMessage: label alone, label + json of the fields, $bindings dropped, nothing → empty', () => {
  expect(actionToMessage({ humanFriendlyMessage: 'Yes, deploy', formState: {} })).toBe('Yes, deploy');
  const m = actionToMessage({ humanFriendlyMessage: 'Order form submitted', formState: { item: 'לחם', qty: { value: '2', componentType: 'TextInput' }, rush: true, $x: 1 } });
  expect(m.startsWith('Order form submitted\n\n```json\n')).toBe(true);
  expect(JSON.parse(m.split('```json\n')[1].split('\n```')[0])).toEqual({ item: 'לחם', qty: '2', rush: true });
  // the Renderer's real shape: nested under the form name
  const n = actionToMessage({ humanFriendlyMessage: 'x', formName: 'order', formState: { order: { qty: { value: '2', componentType: 'TextInput' } }, $x: 1 } });
  expect(JSON.parse(n.split('```json\n')[1].split('\n```')[0])).toEqual({ qty: '2' });
  expect(actionToMessage({ humanFriendlyMessage: '', formState: { a: 1 } }).startsWith('Form submitted')).toBe(true);
  expect(actionToMessage({ humanFriendlyMessage: '' })).toBe('');
  expect(actionToMessage(null)).toBe('');
});

/* ---------- rendering ----------------------------------------------------- */

test('ChatPane routes kind:openui to the card shell (SSR: header + title, body pending)', () => {
  const html = render(h(ChatPane, { sessionId: 's1', events: [{ kind: 'openui', ts: 1, ui: fx('kpis'), title: 'Weekly' }], mode: 'full' }));
  expect(html).toContain('data-openui-card');
  expect(html).toContain('Weekly');
  expect(html).not.toContain('data-openui-fallback');
});

test('empty / root-less events mount into the fallback, not an error', async () => {
  const { host, flush } = await mount(h('div', null, card('nope'), card(undefined)));
  await flush();
  const fbs = [...host.querySelectorAll('[data-openui-fallback]')].map((e) => e.getAttribute('data-openui-fallback'));
  expect(fbs).toEqual(['no-root', 'empty']);
});

test('stats, bar chart, line chart, table and markdown render with our components (plain SVG, RTL dirs)', async () => {
  const a = await mount(card(fx('kpis'), { title: 'Weekly' }));
  await a.flush();
  expect(a.host.textContent).toContain('12,480');
  expect(a.host.textContent).toContain('+8%');
  expect(a.host.querySelector('[dir="rtl"]').textContent).toContain('המרה');
  const rects = a.host.querySelectorAll('svg rect');
  expect(rects.length).toBe(7);
  expect(a.host.querySelector('svg title').textContent).toBe('Mon: 120');
  expect(a.host.querySelectorAll('svg text').length).toBeGreaterThan(7); // axis ticks + x labels + one direct label
  expect(a.host.innerHTML).not.toContain('recharts');

  const b = await mount(card(fx('line')));
  await b.flush();
  expect(b.host.querySelector('svg path[stroke-width="2"]')).toBeTruthy();
  expect(b.host.querySelectorAll('svg circle').length).toBe(6);
  const table = b.host.querySelector('table');
  expect(table.getAttribute('dir')).toBe('rtl');
  expect(table.querySelectorAll('th').length).toBe(3);
  expect(table.querySelectorAll('tbody tr').length).toBe(3);
  expect(b.host.querySelector('.md strong').textContent).toBe('מסקנה:');
  expect(b.host.querySelector('.md a').getAttribute('href')).toBe('https://example.com');
});

test('a Button posts its message into the session and the card shows it as sent', async () => {
  posts = [];
  const { host, flush } = await mount(card(fx('buttons')));
  await flush();
  const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Deploy');
  expect(btn).toBeTruthy();
  await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 20)); });
  expect(posts.length).toBe(1);
  expect(posts[0].url).toContain('/sessions/s1/message');
  expect(posts[0].body).toEqual({ text: 'Yes, deploy v0.2.1 to production' });
  expect(host.querySelector('[data-openui-sent]').textContent).toContain('Yes, deploy v0.2.1 to production');
});

test('a Form submit posts the message plus a json block of every field (defaults, edits, checkbox)', async () => {
  posts = [];
  const { host, flush } = await mount(card(fx('form')));
  await flush();
  const form = host.querySelector('form[data-openui-form="order"]');
  expect(form).toBeTruthy();
  const qty = form.querySelector('input[name="qty"]');
  expect(qty.value).toBe('2');
  // edit the text field, flip the checkbox off, pick another option
  // React's controlled-input tracker only notices a change made through the
  // native setter. Focus + keyup as well as input: react-dom decides ONCE per
  // process whether `input` events are supported (`'oninput' in <div>`), and
  // whichever test file loaded it first under a stub document turns that off —
  // its fallback then polls the focused element on keyup. Cover both paths.
  const setNative = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(qty), 'value').set;
  await act(async () => {
    qty.focus();
    setNative.call(qty, '5');
    qty.dispatchEvent(new Event('input', { bubbles: true }));
    qty.dispatchEvent(new Event('keyup', { bubbles: true }));
  });
  await act(async () => { form.querySelector('input[name="rush"]').click(); });
  const sel = form.querySelector('select[name="item"]');
  await act(async () => { sel.value = 'ביצים'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { form.querySelector('button[type="submit"]').click(); await new Promise((r) => setTimeout(r, 20)); });
  expect(posts.length).toBe(1);
  const text = posts[0].body.text;
  expect(text.startsWith('Order form submitted\n\n```json\n')).toBe(true);
  const fields = JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
  expect(fields).toEqual({ item: 'ביצים', qty: '5', rush: false });
});

test('bad blocks degrade: unknown component and garbage show the fallback with the source behind a toggle', async () => {
  const { host, flush } = await mount(card(fx('unknown')));
  await flush();
  const fb = host.querySelector('[data-openui-fallback]');
  expect(fb.getAttribute('data-openui-fallback')).toBe('unknown-component:PieChart');
  expect(host.querySelector('pre')).toBeNull();
  await act(async () => { fb.querySelector('button').click(); });
  expect(host.querySelector('pre').textContent).toContain('PieChart');
  const g = await mount(card(fx('garbage')));
  await g.flush();
  expect(g.host.querySelector('[data-openui-fallback]').getAttribute('data-openui-fallback')).toBe('no-root');
  expect(g.host.querySelector('svg')).toBeNull();
});
