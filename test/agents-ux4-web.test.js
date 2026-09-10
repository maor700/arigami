// UX4 web: "can't delete an existing agent" — the rail's Team row menu offers a
// delete action (the only place the rail exposed before was the persona
// tab's buried, unlabeled trailing button), and the agent surface header
// carries the same delete action so it is reachable from every tab and on
// mobile, not just at the bottom of the persona tab.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, store, TeamSection, AgentView, origFetch;
const h = (...a) => React.createElement(...a);

const AGENTS = [
  { slug: 'bot', name: 'Bot', emoji: '🤖', color: '#E0594F', skills: [], homeSessionId: 'sess_home', persona: 'You post.' },
];

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200, url: String(url),
    json: async () => (String(url).includes('/agents') ? { agents: AGENTS } : {}),
    text: async () => '',
  });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  store = await import(web('lib/store.js'));
  ({ TeamSection } = await import(web('components/Rail.jsx')));
  ({ default: AgentView } = await import(web('components/AgentView.jsx')));
  await store.loadAgents();
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

const noop = () => {};

test('Rail Team row menu: opening it shows a delete action, danger-styled and separated from the other rows', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(TeamSection, { agents: AGENTS, sessions: [], triggers: [], onSelect: noop, onOpenAgent: noop, onNewAgent: noop, selectedId: null, open: true, onToggle: noop, menuFor: 'agent:bot', setMenuFor: noop }));
  expect(html).toContain('data-agent-menu-delete');
  const item = html.slice(html.indexOf('data-agent-menu-delete'), html.indexOf('data-agent-menu-delete') + 900);
  expect(item).toContain('Delete agent');
  expect(item).toContain('text-danger');
  // it comes after the existing home/runs/page items, not mixed in with them
  expect(html.indexOf('data-agent-menu-home')).toBeLessThan(html.indexOf('data-agent-menu-delete'));
  expect(html.indexOf('data-agent-menu-runs')).toBeLessThan(html.indexOf('data-agent-menu-delete'));

  prefs.setPrefs({ language: 'he' });
  const heHtml = render(h(TeamSection, { agents: AGENTS, sessions: [], triggers: [], onSelect: noop, onOpenAgent: noop, onNewAgent: noop, selectedId: null, open: true, onToggle: noop, menuFor: 'agent:bot', setMenuFor: noop }));
  expect(heHtml).toContain('מחק סוכן');
  prefs.setPrefs({ language: 'en' });
});

// AGENT-PAGE (child B): the delete is no longer a bare trash button in the
// header — it sits behind the ⋯ menu (data-agent-more) and then a typed-name
// dialog. Still reachable from every tab; still absent for a draft.
test('Agent surface header: a ⋯ menu for an existing agent (reachable regardless of tab), no bare delete button, none of it for a draft', () => {
  prefs.setPrefs({ language: 'en' });
  const existing = render(h(AgentView, { slug: 'bot', tab: 'activity', onClose: noop, onTab: noop, onOpenSession: noop }));
  expect(existing).toContain('data-agent-more');
  expect(existing).not.toContain('data-agent-delete'); // the menu (and its delete item) only renders once opened

  const draft = render(h(AgentView, { slug: '__new__', tab: 'persona', onClose: noop, onTab: noop, onOpenSession: noop, onCreated: noop }));
  expect(draft).not.toContain('data-agent-more');
  expect(draft).not.toContain('data-agent-delete');
});

test('Persona tab: no anonymous trailing delete button for an existing agent (moved to the header) — draft still gets a plain Cancel', () => {
  prefs.setPrefs({ language: 'en' });
  const existing = render(h(AgentView, { slug: 'bot', tab: 'persona', onClose: noop, onTab: noop, onOpenSession: noop }));
  expect(existing).not.toContain('data-agent-discard');

  const draft = render(h(AgentView, { slug: '__new__', tab: 'persona', onClose: noop, onTab: noop, onOpenSession: noop, onCreated: noop }));
  expect(draft).toContain('data-agent-discard');
  expect(draft).toContain('Cancel');
});
