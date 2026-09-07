// AGENT-PAGE (child B) web: the agent surface header is ONE row (avatar · name ·
// status · tab switcher · ⋯ · ✕); the details (handle, persona line, model,
// tools, budget…) live in a drawer; delete sits behind the ⋯ menu AND a
// typed-name confirmation; the home tab carries the same TabBar a work
// session has (SessionView in `homeAgent` mode).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, store, AgentView, AgentDetailsDrawer, DeleteAgentForm, MoreMenu, SessionView, TabBar, origFetch;
const h = (...a) => React.createElement(...a);

const AGENTS = [
  { slug: 'nili', name: 'Nili', emoji: '🌿', color: '#1F9C82', model: 'sonnet', tools: ['web', 'whatsapp'], domains: ['example.com'], skills: ['dispatch'], homeSessionId: 'sess_home', persona: '# who\nYou keep the garden alive.', createdAt: '2026-08-30T10:00:00Z' },
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
  ({ default: AgentView, AgentDetailsDrawer, DeleteAgentForm, MoreMenu } = await import(web('components/AgentView.jsx')));
  ({ default: SessionView } = await import(web('components/SessionView.jsx')));
  ({ default: TabBar } = await import(web('components/TabBar.jsx')));
  await store.loadAgents();
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

const noop = () => {};

test('header is ONE row: avatar, name (the details trigger), status, the tab pills (sm+) + a switcher (<sm), ⋯ and ✕ — no persona line, no handle, no budget bar in it', () => {
  prefs.setPrefs({ language: 'he' });
  const html = render(h(AgentView, { slug: 'nili', tab: 'home', onClose: noop, onTab: noop, onOpenSession: noop }));
  const header = html.slice(html.indexOf('data-agent-header'), html.indexOf('data-agent-header') + 20000);
  expect(header).toContain('h-11'); // the same height as a session TabBar
  expect(header).toContain('data-agent-avatar="nili"');
  expect(header).toContain('data-agent-details="toggle"');
  expect(header).toContain('data-agent-status=');
  expect(header).toContain('data-agent-tabs="pills"');
  expect(header).toContain('data-agent-tabs="switcher"');
  expect(header).toContain('data-agent-more');
  for (const id of ['home', 'persona', 'memory', 'connections', 'routine', 'activity', 'runs']) expect(header).toContain(`data-agent-tab="${id}"`);
  // the mobile hamburger lives here now (App skips its own top bar over the agent page)
  expect(header).toContain('fa-bars');
  // what moved out
  expect(html).not.toContain('@nili');
  expect(html).not.toContain('You keep the garden alive.');
  expect(html).not.toContain('data-agent-budget');
  expect(html).not.toContain('data-agent-delete'); // not in the header — only inside the ⋯ menu once opened
  prefs.setPrefs({ language: 'en' });
});

test('the details drawer carries the handle, persona line, model, tools, domains, skills, budget and the one-liner', () => {
  prefs.setPrefs({ language: 'he' });
  const html = render(h(AgentDetailsDrawer, { agent: AGENTS[0], budget: { cap: 1000, usedTokens: 100 }, onClose: noop, onEditPersona: noop }));
  expect(html).toContain('data-agent-details-drawer');
  expect(html).toContain('@nili');
  expect(html).toContain('You keep the garden alive.');
  expect(html).toContain('sonnet');
  expect(html).toContain('וואטסאפ'); // tools rendered through the family labels
  expect(html).toContain('example.com');
  expect(html).toContain('dispatch');
  expect(html).toContain('data-agent-budget="ok"');
  expect(html).toContain('בית = לדבר עם הסוכן');
  expect(html).toContain('data-agent-details-edit');
  prefs.setPrefs({ language: 'en' });
});

test('⋯ menu: details first, delete last, danger-styled and separated', () => {
  prefs.setPrefs({ language: 'he' });
  const html = render(h(MoreMenu, { onClose: noop, onDetails: noop, onDelete: noop }));
  expect(html.indexOf('data-agent-menu-details')).toBeLessThan(html.indexOf('data-agent-delete'));
  const del = html.slice(html.indexOf('data-agent-delete'));
  expect(del).toContain('text-danger');
  expect(del).toContain('מחק סוכן');
  expect(html).toContain('border-t border-hair'); // the separator
  prefs.setPrefs({ language: 'en' });
});

test('delete dialog: names the agent, asks to type it, and the Delete button starts DISABLED', () => {
  prefs.setPrefs({ language: 'he' });
  const html = render(h(DeleteAgentForm, { agent: AGENTS[0], onClose: noop, onDeleted: noop }));
  expect(html).toContain('data-agent-delete-dialog');
  expect(html).toContain('data-agent-delete-name');
  expect(html).toContain('הקלד את שם הסוכן');
  expect(html).toContain('placeholder="Nili"');
  expect(html).toMatch(/data-agent-delete-confirm[^>]*disabled/);
  // the consequences text is still spelled out
  expect(html).toContain('צ׳אט הבית');
  prefs.setPrefs({ language: 'en' });
});

test('SessionView in homeAgent mode: the shared TabBar (embedded: no hamburger, no brand glyph), the session tab titled "home chat", the home chat body — no claude-code header', () => {
  prefs.setPrefs({ language: 'he' });
  const session = { id: 'sess_home', title: 'Nili', color: '#1F9C82', metadata: { agent: 'nili', agentHome: true }, claude: { state: 'idle' }, tabs: [{ id: 't1', type: 'session', title: 'Session' }, { id: 't2', type: 'url', title: 'דסקטופ', url: 'http://localhost:1' }], activeTabId: 't1' };
  const html = render(h(SessionView, { session, homeAgent: AGENTS[0], events: [], chatLoading: false, addTabOpen: false, setAddTabOpen: noop, onOpenSession: noop }));
  expect(html).toContain('data-agent-home="nili"');
  expect(html).toContain('צ׳אט הבית'); // the session tab's title in home mode
  expect(html).toContain('דסקטופ'); // the agent's own tab is visible
  expect(html).not.toContain('claude-code');
  expect(html).not.toContain('fa-bars'); // embedded: the agent header carries the hamburger
  prefs.setPrefs({ language: 'en' });
});

test('a plain TabBar still has the hamburger; embedded drops it', () => {
  const session = { id: 's1', title: 'x', tabs: [{ id: 't1', type: 'session', title: 'Session' }] };
  expect(render(h(TabBar, { session, activeTabId: 't1', addOpen: false, setAddOpen: noop }))).toContain('fa-bars');
  expect(render(h(TabBar, { session, activeTabId: 't1', addOpen: false, setAddOpen: noop, embedded: true }))).not.toContain('fa-bars');
});

test('App: the agent page counts as a main view with its own hamburger (no duplicate mobile top bar)', () => {
  const src = fs.readFileSync(web('App.jsx'), 'utf8');
  expect(src).toContain('mainHasHamburger');
  expect(src).toMatch(/const mainHasHamburger = sessionIsMain \|\| \(!!agentOpen/);
  expect(src).toContain('{!mainHasHamburger && (');
});
