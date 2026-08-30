// A1 web: the Rail renders the "צוות"/Team section BELOW the sessions and
// ABOVE archived, agent rows show emoji + status, a session born from an
// agent wears the agent's emoji, the AgentCard renders its pending form and
// its created summary, and agent-card updates fold on reload.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, Rail, AgentCard, store, fold, origFetch;

const AGENTS = [
  { slug: 'marketing-lead', name: 'Marketing Lead', emoji: '📣', color: '#E0594F', skills: ['dispatch'], homeSessionId: 'sess_home', persona: '' },
  { slug: 'ops', name: 'Ops', emoji: '🛠️', color: '#1F9C82', skills: [], homeSessionId: null, persona: '' },
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
  // The store's loadAgents() fetches /__api/agents — answer it from here
  // (restored in afterAll: bun test shares globals across files, and the
  // webhook/proxy suites need the real fetch).
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
  ({ default: Rail } = await import(web('components/Rail.jsx')));
  ({ default: AgentCard } = await import(web('components/AgentCard.jsx')));
  ({ foldSetupUpdates: fold } = await import(web('lib/chat-merge.js')));
  await store.loadAgents();
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

const sessions = [
  { id: 'sess_free', title: 'free one', status: 'In Progress', color: '#2C6BD6', metadata: {}, claude: { state: 'idle' }, createdAt: '2026-08-30T10:00:00Z' },
  { id: 'sess_home', title: 'Marketing Lead', status: 'In Progress', color: '#E0594F', metadata: { agent: 'marketing-lead', agentHome: true }, claude: { state: 'working' }, createdAt: '2026-08-30T10:00:00Z' },
  { id: 'sess_old', title: 'archived one', status: 'Completed', color: '#3C9A4E', metadata: {}, archived: true, claude: { state: 'idle' }, createdAt: '2026-08-30T09:00:00Z' },
];
const noop = () => {};
const mountRail = (extra = {}) =>
  render(React.createElement(Rail, { sessions, selectedId: null, onSelect: noop, onNew: noop, onOpenSettings: noop, onOpenSkills: noop, onOpenBrain: noop, onOpenSetup: noop, onArchive: noop, onRestore: noop, onRestart: noop, onDelete: noop, onEdit: noop, config: { defaultCwd: '/tmp/ws' }, conn: 'open', onOpenAgent: noop, ...extra }));

test('Rail (he): the צוות section sits below the sessions and above archived, lists agents with status', () => {
  prefs.setPrefs({ language: 'he' });
  const html = mountRail();
  expect(store.getState().agents.length).toBe(2);
  const team = html.indexOf('data-rail-team');
  const free = html.indexOf('free one');
  const archived = html.indexOf('ארכיון'); // the collapsed archived header
  expect(free).toBeGreaterThan(-1);
  expect(team).toBeGreaterThan(free);
  expect(archived).toBeGreaterThan(team);
  expect(html).toContain('צוות');
  expect(html).toContain('+ סוכן חדש');
  expect(html).toContain('data-rail-agent="marketing-lead"');
  expect(html).toContain('data-rail-agent="ops"');
  // marketing-lead has a working session → "עובד"; ops has none → "פנוי"
  const mk = html.slice(html.indexOf('data-rail-agent="marketing-lead"'), html.indexOf('data-rail-agent="ops"'));
  expect(mk).toContain('עובד');
  expect(mk).toContain('dispatch');
  expect(html.slice(html.indexOf('data-rail-agent="ops"'))).toContain('פנוי');
  prefs.setPrefs({ language: 'en' });
});

test('Rail (en): a session born from an agent wears the agent emoji; free sessions keep the dot', () => {
  prefs.setPrefs({ language: 'en' });
  const html = mountRail();
  expect(html).toContain('Team');
  expect(html).toContain('+ New agent');
  // the session row of the home chat carries the avatar (rendered before the team section)
  const avatar = html.indexOf('data-agent-avatar="marketing-lead"');
  expect(avatar).toBeGreaterThan(-1);
  expect(avatar).toBeLessThan(html.indexOf('data-rail-team'));
  expect(html.slice(avatar, avatar + 400)).toContain('📣');
  const freeRow = html.slice(html.indexOf('free one') - 600, html.indexOf('free one'));
  expect(freeRow).not.toContain('data-agent-avatar');
});

test('AgentCard: pending renders the editable form with the draft; created renders the summary + page link', () => {
  prefs.setPrefs({ language: 'en' });
  const pending = render(React.createElement(AgentCard, { sessionId: 'sess_x', event: { kind: 'agent-card', cardId: 'agc_1', action: 'create', state: 'pending', draft: { name: 'Ops Bot', slug: 'ops-bot', emoji: '🛠️', persona: 'Keep it up.', skills: ['dispatch'] } } }));
  expect(pending).toContain('data-agent-card="pending"');
  expect(pending).toContain('data-agent-field="name"');
  expect(pending).toContain('value="Ops Bot"');
  expect(pending).toContain('Keep it up.');
  expect(pending).toContain('data-agent-confirm');
  expect(pending).toContain('Create agent');
  expect(pending).toContain('Cancel');
  // simple by default: the tool/skill/model fields live behind the advanced fold
  expect(pending).toContain('data-agent-advanced');
  expect(pending).not.toContain('Browser / desktop');
  expect(pending).not.toContain('data-agent-field="slug"');
  const created = render(React.createElement(AgentCard, { sessionId: 'sess_x', event: { kind: 'agent-card', cardId: 'agc_1', action: 'create', state: 'created', agent: { slug: 'ops-bot', name: 'Ops Bot', emoji: '🧰', color: '#1F9C82', skills: ['dispatch'], persona: 'Keep it up.' } } }));
  expect(created).toContain('data-agent-card="created"');
  expect(created).not.toContain('data-agent-confirm');
  expect(created).toContain('Ops Bot is on the team');
  expect(created).toContain('Open agent page');
  expect(created).toContain('🧰');
});

test('foldSetupUpdates folds agent-card-update rows into their card', () => {
  const out = fold([
    { kind: 'user', text: 'hi', ts: 1 },
    { kind: 'agent-card', cardId: 'agc_1', state: 'pending', draft: { name: 'x' }, ts: 2 },
    { kind: 'agent-card-update', cardId: 'agc_1', state: 'created', agent: { slug: 'x' }, ts: 3 },
  ]);
  expect(out.length).toBe(2);
  expect(out[1].kind).toBe('agent-card');
  expect(out[1].state).toBe('created');
  expect(out[1].agent.slug).toBe('x');
});
