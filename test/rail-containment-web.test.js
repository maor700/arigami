// RAIL1 — a folder/project must LOOK like it contains its sessions. Header +
// children now share one rounded, tinted card (the containment signal); the
// header carries a count chip + per-child state dots that survive a collapse;
// and a session rendered OUTSIDE its own group (a PM child with no folder)
// gets a small chip naming its parent. Same SSR-string harness as
// rail-waiting-web.test.js — see that file for why (no jsdom, no event
// system: this can assert on markup for a given static prop state, not on
// drag/click interactions).
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, store, prefs, Rail, insertAt, dropZone, origFetch;
const h = (...a) => React.createElement(...a);

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
  origFetch = globalThis.fetch;
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
  insertAt = RailModule.insertAt;
  dropZone = RailModule.dropZone;
});

afterAll(() => {
  globalThis.fetch = origFetch;
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

test('a folder with kids renders as one card: header and both children fall inside the same rounded container', async () => {
  FOLDERS = [{ id: 'f1', name: 'My Project', collapsed: false, sortOrder: 0, controllerSessionId: 'ctrl' }];
  const sessions = [
    { id: 'ctrl', title: 'Controller', color: '#2C6BD6', folderId: 'f1', metadata: {}, claude: { state: 'idle' } },
    { id: 's1', title: 'Child A', color: '#1F9C82', folderId: 'f1', metadata: {}, claude: { state: 'idle' } },
    { id: 's2', title: 'Child B', color: '#CE8324', folderId: 'f1', metadata: {}, claude: { state: 'idle' } },
  ];
  const out = await renderRail(sessions);
  // the card wrapper (rounded-[10px]) opens once, before the folder name,
  // and both children's titles land before its next sibling closes it.
  expect(out).toMatch(/rounded-\[10px\][\s\S]*?My Project[\s\S]*?Child A[\s\S]*?Child B/);
  // the controller has no row of its own (the card header IS it)
  expect(out).not.toContain('Controller<');
  // child count chip on the header
  expect(out).toMatch(/My Project[\s\S]*?>2</);
  // each child reads as a child: the data-rail-child row marker before its
  // title (RAILUI: the ↳ glyph became an indent on a hairline), and nothing
  // of the OTHER child's row in between (proves the markers are per-row, not
  // one shared marker for the whole list).
  expect(out).toMatch(/data-rail-child(?:(?!data-rail-child)[\s\S])*?Child A/);
  expect(out).toMatch(/Child A[\s\S]*?data-rail-child(?:(?!data-rail-child)[\s\S])*?Child B/);
});

test('a collapsed folder keeps the card, the child count and per-child state dots — the children\'s own rows disappear', async () => {
  FOLDERS = [{ id: 'f1', name: 'Dots Folder', collapsed: true, sortOrder: 0 }];
  const sessions = [
    { id: 's1', title: 'Working one', folderId: 'f1', metadata: {}, claude: { state: 'working' } },
    { id: 's2', title: 'Idle one', folderId: 'f1', metadata: {}, claude: { state: 'idle' } },
  ];
  const out = await renderRail(sessions);
  // collapsed: no child ROW renders (no child marker at all) — the names only
  // still show up folded into the header's own meta line.
  expect(out).not.toContain('data-rail-child');
  expect(out).toMatch(/Dots Folder[\s\S]*?>2</);
  // one state dot per kid
  const dots = out.match(/h-\[5px\] w-\[5px\] shrink-0 rounded-full/g) || [];
  expect(dots.length).toBe(2);
});

test('a plain folder (no controller) still gets the card treatment, just without the manager chip', async () => {
  FOLDERS = [{ id: 'f2', name: 'Plain Folder', collapsed: false, sortOrder: 0, controllerSessionId: null }];
  const sessions = [
    { id: 's1', title: 'Only child', folderId: 'f2', metadata: {}, claude: { state: 'idle' } },
  ];
  const out = await renderRail(sessions);
  expect(out).toMatch(/rounded-\[10px\][\s\S]*?Plain Folder[\s\S]*?Only child/);
  expect(out).not.toContain('Manager');
});

test('a PM child with no folder of its own gets a chip naming its master, linking to it', async () => {
  const sessions = [
    { id: 'master1', title: 'PM Session', color: '#6A4FC4', metadata: {}, claude: { state: 'idle' } },
    { id: 'child1', title: 'Free PM child', color: '#3C9A4E', metadata: { master: 'master1' }, claude: { state: 'idle' } },
  ];
  const out = await renderRail(sessions);
  // the chip's tooltip is built from the parent's name — it can only appear
  // once this specific chip renders.
  expect(out).toContain('Part of PM Session');
  expect(out).toMatch(/<button[^>]*title="Part of PM Session"[^>]*>/);
});

test('a PM child whose master session no longer exists gets no chip (no dangling reference)', async () => {
  const sessions = [
    { id: 'child1', title: 'Orphaned child', color: '#3C9A4E', metadata: { master: 'ghost' }, claude: { state: 'idle' } },
  ];
  const out = await renderRail(sessions);
  expect(out).not.toContain('Part of');
});

test('a free session with no folder and no master gets no parent chip', async () => {
  const sessions = [
    { id: 's1', title: 'Standalone', metadata: {}, claude: { state: 'idle' } },
  ];
  const out = await renderRail(sessions);
  expect(out).not.toContain('Part of');
});

test('insertAt reorders without duplicating or dropping ids, and no-ops against an unknown target', () => {
  const ids = ['a', 'b', 'c', 'd'];
  expect(insertAt(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
  expect(insertAt(ids, 'd', 'a', 'before')).toEqual(['d', 'a', 'b', 'c']);
  expect(insertAt(ids, 'a', 'zzz', 'after')).toBe(ids);
});

test('dropZone reads before/after/into from where the pointer sits over the row body', () => {
  const row = { getBoundingClientRect: () => ({ top: 100, height: 40 }) };
  const evt = (clientY) => ({ currentTarget: { querySelector: () => row }, clientY });
  // two-zone (plain reorder): split 50/50
  expect(dropZone(evt(110), false)).toBe('before'); // 25% down
  expect(dropZone(evt(130), false)).toBe('after'); // 75% down
  // three-zone (withInto): outer quarters are gaps, middle half is "into"
  expect(dropZone(evt(105), true)).toBe('before'); // 12.5%
  expect(dropZone(evt(120), true)).toBe('into'); // 50%
  expect(dropZone(evt(135), true)).toBe('after'); // 87.5%
});
