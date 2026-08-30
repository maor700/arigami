// RES1 §4, toned down (2026-08-30): the rail no longer surfaces "ממתין לך"
// with a full-width pulsing bar. A waiting item now attaches a small, static
// badge to the row it belongs to — the agent's row when the blocked session
// was born from one, otherwise the session's own row — and the aggregated
// list survives only as a muted count next to the sessions header.
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, store, prefs, Rail, origFetch;
const h = (...a) => React.createElement(...a);

// What GET /health and GET /agents answer in this test.
let HEALTH = { sessions: [], waiting: [] };
let AGENTS = { agents: [] };

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
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/health') ? HEALTH : u.includes('/agents') ? AGENTS : {};
    return { ok: true, status: 200, url: u, json: async () => body, text: async () => JSON.stringify(body) };
  };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  store = await import(web('lib/store.js'));
  prefs = await import(web('lib/prefs.js'));
  prefs.setPrefs({ language: 'en' });
  Rail = (await import(web('components/Rail.jsx'))).default;
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

beforeEach(() => {
  HEALTH = { sessions: [], waiting: [] };
  AGENTS = { agents: [] };
});

const baseProps = () => ({
  selectedId: null,
  agentOpen: null,
  onSelect: () => {},
  onNew: () => {},
  onOpenSettings: () => {},
  onOpenSkills: () => {},
  onOpenBrain: () => {},
  onOpenSetup: () => {},
  searchRef: { current: null },
  onArchive: () => {},
  onRestore: () => {},
  onRestart: () => {},
  onDelete: () => {},
  onEdit: () => {},
  config: null,
  conn: 'open',
  isDesktop: true,
  mobileOpen: false,
  onClose: () => {},
  onPreviewTicket: () => {},
  onOpenTriggers: () => {},
  onOpenShortcuts: () => {},
  onOpenAgent: () => {},
});

async function renderRail(sessions) {
  await store.loadHealth();
  await store.loadAgents();
  return render(h(Rail, { ...baseProps(), sessions }));
}

test('no full-width pulsing pill — and no pulse-yellow anywhere — when something is waiting', async () => {
  HEALTH = {
    sessions: [],
    waiting: [{ sessionId: 's1', title: 'plain session', kind: 'setup', unblock: 'connect', since: new Date().toISOString(), agent: null }],
  };
  const sessions = [{ id: 's1', title: 'plain session', metadata: {}, claude: { state: 'idle' } }];
  const out = await renderRail(sessions);
  expect(out).not.toContain('pulse-yellow');
  // the old full-width bar rendered its label as visible text; now that
  // sentence only lives in an aria-label, and the visible text is "1".
  expect(out).not.toContain('>Waiting for you (1)<');
  expect(out).toContain('aria-label="Waiting for you (1)"');
});

test('a session with no agent gets the badge on its own row', async () => {
  HEALTH = {
    sessions: [],
    waiting: [{ sessionId: 's1', title: 'plain session', kind: 'setup', unblock: 'connect', since: new Date().toISOString(), agent: null }],
  };
  const sessions = [
    { id: 's1', title: 'plain session', metadata: {}, claude: { state: 'idle' } },
    { id: 's2', title: 'other session', metadata: {}, claude: { state: 'idle' } },
  ];
  const out = await renderRail(sessions);
  expect(out).toContain('plain session');
  // single waiting item on the row → the glyph, not a count
  expect(out).toMatch(/plain session[\s\S]*?>\s*!\s*</);
});

test('a session born from an agent gets the badge on the agent row, not the session row', async () => {
  HEALTH = {
    sessions: [],
    waiting: [{ sessionId: 's1', title: 'agent-born session', kind: 'review', unblock: 'approve', since: new Date().toISOString(), agent: 'scout' }],
  };
  AGENTS = { agents: [{ slug: 'scout', name: 'Scout', color: '#2C6BD6', emoji: '🔭', skills: [] }] };
  const sessions = [{ id: 's1', title: 'agent-born session', metadata: { agent: 'scout' }, claude: { state: 'idle' } }];
  const out = await renderRail(sessions);
  expect(out).toContain('Scout');
  // the badge sits between the agent name and the working/idle status, not
  // on the (absent, since it's the only session and reads as "1 session") row.
  expect(out).toMatch(/Scout[\s\S]*?>\s*!\s*</);
});

test('more than one waiting item on the same row shows the count, not the glyph', async () => {
  HEALTH = {
    sessions: [],
    waiting: [
      { sessionId: 's1', title: 'busy agent session', kind: 'review', unblock: 'approve', since: new Date().toISOString(), agent: 'scout' },
      { sessionId: 's1', title: 'busy agent session', kind: 'merge', unblock: 'merge', since: new Date().toISOString(), agent: 'scout' },
    ],
  };
  AGENTS = { agents: [{ slug: 'scout', name: 'Scout', color: '#2C6BD6', emoji: '🔭', skills: [] }] };
  const sessions = [{ id: 's1', title: 'busy agent session', metadata: { agent: 'scout' }, claude: { state: 'idle' } }];
  const out = await renderRail(sessions);
  expect(out).toMatch(/Scout[\s\S]*?>\s*2\s*</);
});

test('the aggregated count sits quietly next to the sessions header and is clickable to expand', async () => {
  HEALTH = {
    sessions: [],
    waiting: [
      { sessionId: 's1', title: 'one', kind: 'setup', unblock: 'connect', since: new Date().toISOString(), agent: null },
      { sessionId: 's2', title: 'two', kind: 'budget', unblock: 'raise-cap', since: new Date().toISOString(), agent: null },
    ],
  };
  const sessions = [
    { id: 's1', title: 'one', metadata: {}, claude: { state: 'idle' } },
    { id: 's2', title: 'two', metadata: {}, claude: { state: 'idle' } },
  ];
  const out = await renderRail(sessions);
  // the muted counter itself: a plain clickable "2", with the full sentence
  // only in the accessible name — never rendered as a full-width labelled bar.
  expect(out).toContain('aria-label="Waiting for you (2)"');
  expect(out).toMatch(/text-fgdim hover:text-fg">2<\/button>/);
  expect(out).not.toContain('Waiting for you (2)</');
});

test('no waiting items renders no badges and no counter', async () => {
  const sessions = [{ id: 's1', title: 'quiet session', metadata: {}, claude: { state: 'idle' } }];
  const out = await renderRail(sessions);
  expect(out).not.toContain('pulse-yellow');
  expect(out).not.toContain('waiting.pill');
});
