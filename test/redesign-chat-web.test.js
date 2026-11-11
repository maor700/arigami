// Chat redesign: message language, tool rows, plan card, composer pill, card primitives.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
let React, render, prefs, store, ChatPane, ComposerPill, CardFrame, Btn, toolIcon, todosOf, TodoList;
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
  ({ default: ChatPane, toolIcon, todosOf, TodoList } = await import(web('components/ChatPane.jsx')));
  ({ default: ComposerPill } = await import(web('components/ComposerPill.jsx')));
  ({ CardFrame, Btn } = await import(web('openui/primitives.jsx')));
});


const ev = (o, i) => ({ id: 'e' + i, ts: Date.now() - 60000, ...o });
const events = [
  ev({ kind: 'user', text: 'hello there' }, 1),
  ev({ kind: 'assistant-text', text: 'Hi — **done**.' }, 2),
  ev({ kind: 'tool-use', name: 'Bash', toolUseId: 't1', input: { command: 'ls' } }, 3),
  ev({ kind: 'tool-use', name: 'TodoWrite', toolUseId: 't2', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'doing b' }, { content: 'c', status: 'pending' }] } }, 4),
];

test('messages: assistant prose has no bubble, user message is a neutral surface (no mint fill)', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(ChatPane, { sessionId: 's', events, mode: 'full' }));
  expect(html).toContain('data-user-msg');
  expect(html).toContain('bg-[var(--term-userbg)]');
  expect(html).not.toMatch(/bg-brand|border-ink|font-mono text-\[12px\]/);
  expect(html).toContain('class="group md my-3"');
});

test('tool rows: thin lucide glyph per tool, Radix collapsible trigger, plan card for TodoWrite', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(ChatPane, { sessionId: 's', events, mode: 'full' }));
  expect(html).toContain('data-tool-row');
  expect(html).toContain('lucide-terminal');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('data-plan-card');
  expect(html).toContain('1/3');
  expect(html).toContain('doing b'); // the in-progress item shows its active form
  expect(toolIcon('Grep')).not.toBe(toolIcon('Bash'));
  expect(todosOf({ name: 'TodoWrite', input: { todos: [{ content: 'x' }] } })).toHaveLength(1);
  expect(todosOf({ name: 'Bash', input: {} })).toBeNull();
});

test('simple mode: tool calls fold into ONE muted summary row, collapsed', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(ChatPane, { sessionId: 's', events, mode: 'simple' }));
  expect((html.match(/data-behind-scenes=/g) || []).length).toBe(1);
  expect(html).not.toContain('data-tool-row'); // the individual calls only exist once expanded
});

test('cards: neutral surface, status dot only when live, one primary Btn', () => {
  prefs.setPrefs({ language: 'en' });
  const live = render(h(CardFrame, { tone: 'accent', live: true, label: 'Needs you' }, h(Btn, { variant: 'primary' }, 'Allow'), h(Btn, { variant: 'quiet' }, 'Deny')));
  expect(live).toContain('data-card-dot');
  expect(live).toContain('pulse-yellow');
  expect(live).toContain('bg-warn');
  expect(live).not.toMatch(/bg-brand|border-ink|shadow-\[2px/);
  expect((live.match(/<button[^>]*(data-variant="primary"|bg-primary)/g) || []).length).toBe(1);
  const quiet = render(h(CardFrame, { tone: 'panel', label: 'Info' }));
  expect(quiet).not.toContain('data-card-dot');
});

test('composer pill: one trigger for model + effort + permission mode', () => {
  prefs.setPrefs({ language: 'en' });
  const session = { id: 's1', engine: 'claude', claude: { state: 'idle', permissionMode: 'plan', modelChoice: 'default', effort: 'high' } };
  const html = render(h(ComposerPill, { session }));
  expect(html).toContain('data-composer-pill');
  expect(html).toContain('High'); // chosen effort rides in the label
  expect(html).toContain('data-status="info"'); // plan mode shows its dot
  const dflt = render(h(ComposerPill, { session: { ...session, claude: { state: 'idle' } } }));
  expect(dflt).not.toContain('data-status='); // default mode: no dot
});

test('markdown / diff / card sources carry no legacy brutalist classes', async () => {
  const fs = await import('node:fs');
  for (const f of ['ChatPane', 'DiffCard', 'Composer', 'ComposerPill', 'PermissionCard', 'QuestionCard']) {
    const src = fs.readFileSync(web(`components/${f}.jsx`), 'utf8');
    expect(src).not.toMatch(/border-ink|border-\[1\.5px\]|shadow-\[\d+px_\d+px_0|bg-brand(?!\/)/);
  }
});
