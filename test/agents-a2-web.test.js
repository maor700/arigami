// A2 web: the Rail's team row shows the next cron run for an idle agent with a
// scheduled job; the agent's Connections list says own / shared / none per
// ownable capability and whether the browser profile exists; the Routine
// list renders cron jobs (enabled state, next run) + listeners; the SetupCard
// raised by an agent session wears an owner chip; the Connections hub offers
// the "שייך ל" owner filter with the agents.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, store, TeamSection, nextCronFor, AgentConnections, RoutineList, untilTime, SetupCard, Connections, origFetch;
const h = (...a) => React.createElement(...a);

const AGENTS = [
  { slug: 'bot', name: 'Bot', emoji: '🤖', color: '#E0594F', skills: [], homeSessionId: null, persona: '' },
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
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => (String(url).includes('/agents') ? { agents: AGENTS } : {}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  store = await import(web('lib/store.js'));
  ({ TeamSection, nextCronFor } = await import(web('components/Rail.jsx')));
  ({ AgentConnections } = await import(web('components/settings/AgentConnections.jsx')));
  ({ RoutineList, untilTime } = await import(web('components/RoutineList.jsx')));
  ({ default: SetupCard } = await import(web('components/setup/SetupCard.jsx')));
  ({ default: Connections } = await import(web('components/settings/Connections.jsx')));
  await store.loadAgents();
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

const noop = () => {};
const soon = Date.now() + 3 * 3600 * 1000;
const TRIGGERS = [
  { id: 't1', type: 'cron', agent: 'bot', enabled: true, nextRunAt: soon + 3600 * 1000 },
  { id: 't2', type: 'cron', agent: 'bot', enabled: true, nextRunAt: soon },
  { id: 't3', type: 'cron', agent: 'bot', enabled: false, nextRunAt: Date.now() + 1000 }, // disabled → ignored
  { id: 't4', type: 'cron', agent: 'ops', enabled: true, nextRunAt: null }, // fired one-shot → ignored
  { id: 't5', type: 'linear-filter', agent: 'ops', enabled: true, nextRunAt: soon },
];

test('Rail team row: idle agent with an enabled cron shows the next run; others stay idle', () => {
  prefs.setPrefs({ language: 'he' });
  expect(nextCronFor('bot', TRIGGERS)).toBe(soon);
  expect(nextCronFor('ops', TRIGGERS)).toBeNull();
  const html = render(h(TeamSection, { agents: AGENTS, sessions: [], triggers: TRIGGERS, onSelect: noop, onOpenAgent: noop, onNewAgent: noop, selectedId: null, open: true, onToggle: noop, menuFor: null, setMenuFor: noop }));
  const bot = html.slice(html.indexOf('data-rail-agent="bot"'), html.indexOf('data-rail-agent="ops"'));
  expect(bot).toContain(`data-agent-next-cron="${soon}"`);
  expect(bot).toContain('⏰ בעוד 2');
  expect(bot).not.toContain('פנוי');
  expect(html.slice(html.indexOf('data-rail-agent="ops"'))).toContain('פנוי');
  // a working session wins over the cron line
  const busy = render(h(TeamSection, { agents: AGENTS, sessions: [{ id: 's', metadata: { agent: 'bot' }, claude: { state: 'working' } }], triggers: TRIGGERS, onSelect: noop, onOpenAgent: noop, onNewAgent: noop, selectedId: null, open: true, onToggle: noop, menuFor: null, setMenuFor: noop }));
  expect(busy).toContain('עובד');
  expect(busy).not.toContain('data-agent-next-cron');
  prefs.setPrefs({ language: 'en' });
  expect(untilTime(Date.now() + 90 * 1000, (k, v) => (k === 'time.in' ? `in ${v.t}` : 'm'))).toBe('in 1m');
});

test('AgentConnections: own / shared / none per ownable capability, host-level list, browser profile line', () => {
  prefs.setPrefs({ language: 'he' });
  const data = {
    owner: 'agent:bot',
    identity: { email: 'bot@example.com' },
    browserProfile: true,
    capabilities: [
      { id: 'identity', ok: true, ownable: true, owner: 'agent:bot', resolvedFrom: 'agent:bot', detail: 'signed in as bot@example.com', manual: { kind: 'takeover' } },
      { id: 'composio:gmail', ok: true, ownable: true, owner: 'agent:bot', resolvedFrom: 'global', detail: 'connected (shared)', manual: { kind: 'oauth' } },
      { id: 'composio:slack', ok: false, ownable: true, owner: 'agent:bot', resolvedFrom: null, detail: 'not connected', manual: { kind: 'oauth' } },
      { id: 'git', ok: true, ownable: false, owner: 'agent:bot', resolvedFrom: 'global', detail: 'git credentials present', manual: { kind: 'token' } },
      { id: 'telemetry', ok: false, ownable: false, owner: 'agent:bot', resolvedFrom: null, detail: 'off', manual: { kind: 'toggle' } },
    ],
    audit: [{ at: '2026-08-30T10:00:00Z', capability: 'identity', mode: 'manual', result: 'done', owner: 'agent:bot' }],
  };
  const html = render(h(AgentConnections, { agent: AGENTS[0], data, onConnect: noop, onDisconnect: noop }));
  expect(html).toContain('data-agent-connections="bot"');
  expect(html).toContain('data-agent-cap="identity" data-resolved="agent:bot"');
  expect(html).toContain('data-agent-cap="composio:gmail" data-resolved="global"');
  expect(html).toContain('data-agent-cap="composio:slack" data-resolved="none"');
  expect(html).not.toContain('data-agent-cap="git"'); // host-level → the shared list, not the ownable one
  expect(html).toContain('משלו');
  expect(html).toContain('משותף (מארח)');
  expect(html).toContain('לא מחובר');
  expect(html).toContain('חבר לסוכן');
  expect(html).toContain('data-agent-browser="on"');
  expect(html).toContain('ברמת המארח');
  expect(html).not.toContain('telemetry'); // host-only toggles are hidden per agent
  const off = render(h(AgentConnections, { agent: AGENTS[0], data: { ...data, browserProfile: false }, onConnect: noop, onDisconnect: noop }));
  expect(off).toContain('data-agent-browser="off"');
  prefs.setPrefs({ language: 'en' });
});

test('RoutineList: cron rows with enabled state + next run, listeners, add-via-chat', () => {
  prefs.setPrefs({ language: 'he' });
  const data = {
    cron: [
      { id: 'trig_a', name: 'daily post', enabled: true, schedule: { kind: 'cron', value: '0 9 * * *' }, nextRunAt: soon, lastRun: null },
      { id: 'trig_b', name: 'weekly digest', enabled: false, schedule: { kind: 'interval', value: '7d' }, nextRunAt: soon, lastRun: Date.now() - 3600 * 1000 },
    ],
    listeners: [
      { id: 'lsn_1', sessionId: 's1', type: 'whatsapp', label: 'Family group', status: 'watching', firedCount: 3 },
      { id: 'lsn_2', sessionId: 's1', type: 'sms', label: 'old', status: 'stopped' },
    ],
  };
  const html = render(h(RoutineList, { agent: AGENTS[0], data, onAdd: noop }));
  expect(html).toContain('data-agent-routine="bot"');
  expect(html).toContain('data-routine-cron="trig_a" data-enabled="1"');
  expect(html).toContain('data-routine-cron="trig_b" data-enabled="0"');
  expect(html).toContain('0 9 * * *');
  expect(html).toContain('ריצה הבאה: בעוד 2');
  expect(html).toContain('data-routine-listener="lsn_1"');
  expect(html).not.toContain('data-routine-listener="lsn_2"'); // stopped ones are not the routine
  expect(html).toContain('Family group');
  expect(html).toContain('data-routine-add');
  expect(html).toContain('הוסף דרך הצ׳אט');
  const empty = render(h(RoutineList, { agent: AGENTS[0], data: { cron: [], listeners: [] }, onAdd: noop }));
  expect(empty).toContain('אין עדיין משימות מתוזמנות');
  expect(empty).toContain('אין מאזינים פעילים');
  prefs.setPrefs({ language: 'en' });
});

test('SetupCard from an agent session wears the owner chip (agent name from the store); plain cards do not', () => {
  prefs.setPrefs({ language: 'he' });
  const base = { kind: 'setup', requestId: 'r1', capability: 'composio:gmail', why: 'read the inbox', autoCapable: true, identity: null, state: 'pending' };
  const owned = render(h(SetupCard, { sessionId: 's1', event: { ...base, owner: 'agent:bot' } }));
  expect(owned).toContain('data-setup-owner="agent:bot"');
  expect(owned).toContain('עבור Bot');
  expect(owned).toContain('🤖');
  const plain = render(h(SetupCard, { sessionId: 's1', event: { ...base, owner: 'global' } }));
  expect(plain).not.toContain('data-setup-owner');
  prefs.setPrefs({ language: 'en' });
});

test('Connections hub: the "שייך ל" filter lists the host + every agent', () => {
  prefs.setPrefs({ language: 'he' });
  const html = render(h(Connections, {}));
  expect(html).toContain('data-connections-owner');
  expect(html).toContain('שייך ל:');
  expect(html).toContain('כללי (מארח)</option>');
  expect(html).toContain('<option value="agent:bot">🤖 Bot</option>');
  expect(html).toContain('<option value="agent:ops">🛠️ Ops</option>');
  prefs.setPrefs({ language: 'en' });
});
