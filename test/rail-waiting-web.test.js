// RES1 §4, toned down (2026-08-30, then further per direct feedback): the
// rail no longer surfaces "waiting for you" as a full-width pulsing bar, and it no
// longer has a separate aggregated section at all. A waiting item is only a
// small, static badge on the row it belongs to — the agent's row when the
// blocked session was born from one, otherwise the session's own row — rolled
// up (hollow, count-only) onto a collapsed folder's count chip or the
// collapsed Team header so nothing silently disappears behind a fold.
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, store, prefs, Rail, TeamSection;
const h = (...a) => React.createElement(...a);

// What GET /health, /agents and /folders answer in this test.
let HEALTH = { sessions: [], waiting: [] };
let AGENTS = { agents: [] };
let FOLDERS = [];

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
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/health') ? HEALTH : u.includes('/agents') ? AGENTS : u.includes('/folders') ? FOLDERS : {};
    return { ok: true, status: 200, url: u, json: async () => body, text: async () => JSON.stringify(body) };
  };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  store = await import(web('lib/store.js'));
  prefs = await import(web('lib/prefs.js'));
  prefs.setPrefs({ language: 'en' });
  const RailModule = await import(web('components/Rail.jsx'));
  Rail = RailModule.default;
  TeamSection = RailModule.TeamSection;
});

beforeEach(() => {
  HEALTH = { sessions: [], waiting: [] };
  AGENTS = { agents: [] };
  FOLDERS = [];
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
  await store.loadFolders();
  return render(h(Rail, { ...baseProps(), sessions }));
}

test('no pulse-yellow anywhere, and no aggregated top section, when something is waiting', async () => {
  HEALTH = {
    sessions: [],
    waiting: [{ sessionId: 's1', title: 'plain session', kind: 'setup', unblock: 'connect', since: new Date().toISOString(), agent: null }],
  };
  const sessions = [{ id: 's1', title: 'plain session', metadata: {}, claude: { state: 'idle' } }];
  const out = await renderRail(sessions);
  expect(out).not.toContain('pulse-yellow');
  // no separate "waiting for you" section header/sentence anywhere — the row
  // badge (checked below) is the only signal.
  expect(out).not.toContain('Waiting for you');
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

test('a waiting session hidden inside a collapsed folder rolls up onto the folder chip', async () => {
  HEALTH = {
    sessions: [],
    waiting: [{ sessionId: 's1', title: 'in a folder', kind: 'merge', unblock: 'merge', since: new Date().toISOString(), agent: null }],
  };
  FOLDERS = [{ id: 'f1', name: 'My Folder', collapsed: true, sortOrder: 0 }];
  const sessions = [
    { id: 's1', title: 'in a folder', folderId: 'f1', metadata: {}, claude: { state: 'idle' } },
    { id: 's2', title: 'also in the folder', folderId: 'f1', metadata: {}, claude: { state: 'idle' } },
  ];
  const out = await renderRail(sessions);
  // collapsed folder: the two rows never render, so the badge would
  // otherwise be invisible — it must show up on the count chip instead.
  expect(out).not.toContain('in a folder<');
  expect(out).toMatch(/My Folder[\s\S]*?>2 · !<\/button>/);
  expect(out).not.toContain('pulse-yellow');
});

test('a collapsed Team section rolls up hidden per-agent waiting onto its header', async () => {
  const waitingByAgent = new Map([
    ['scout', [{ sessionId: 's1', kind: 'review', unblock: 'approve' }]],
  ]);
  const out = render(
    h(TeamSection, {
      agents: [{ slug: 'scout', name: 'Scout', color: '#2C6BD6', emoji: '🔭', skills: [] }],
      sessions: [{ id: 's1', metadata: { agent: 'scout' }, archived: false }],
      triggers: [],
      onOpenAgent: () => {},
      onNewAgent: () => {},
      agentOpen: null,
      open: false,
      onToggle: () => {},
      menuFor: null,
      setMenuFor: () => {},
      waitingByAgent,
    })
  );
  // collapsed: no per-agent rows render, so the header count carries it.
  expect(out).not.toContain('Scout');
  expect(out).toMatch(/>1 · !<\/span>/);
  expect(out).not.toContain('pulse-yellow');
});

test('an open Team section shows the badge on the agent row, not a header rollup', async () => {
  const waitingByAgent = new Map([
    ['scout', [{ sessionId: 's1', kind: 'review', unblock: 'approve' }]],
  ]);
  const out = render(
    h(TeamSection, {
      agents: [{ slug: 'scout', name: 'Scout', color: '#2C6BD6', emoji: '🔭', skills: [] }],
      sessions: [{ id: 's1', metadata: { agent: 'scout' }, archived: false }],
      triggers: [],
      onOpenAgent: () => {},
      onNewAgent: () => {},
      agentOpen: null,
      open: true,
      onToggle: () => {},
      menuFor: null,
      setMenuFor: () => {},
      waitingByAgent,
    })
  );
  expect(out).toMatch(/Scout[\s\S]*?>\s*!\s*</);
  expect(out).not.toMatch(/>1 · !<\/span>/);
});

test('no waiting items renders no badges and no rollups', async () => {
  const sessions = [{ id: 's1', title: 'quiet session', metadata: {}, claude: { state: 'idle' } }];
  const out = await renderRail(sessions);
  expect(out).not.toContain('pulse-yellow');
  expect(out).not.toContain('Waiting for you');
});
