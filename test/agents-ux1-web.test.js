// UX1 web: "בית" (a place) vs "סשן עבודה" (a job).
//   · the agent SURFACE — accent header, big avatar, persona line, live status,
//     budget bar, and the tabs בית / … / ריצות
//   · the ריצות tab lists the work sessions with their cost, never the home chat
//   · a work session says whose job it is (BornFromChip) — the home chat doesn't
//   · the composer's "turn the last message into a work session" acts on the last
//     HUMAN line (lastHumanText)
//   · /team counts work sessions, not the home chat
// (the rail side — no home row, the "· <agent>" chip — lives in agents-web.test.js;
//  the receipt wording in agents-a4-web.test.js.)
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, store, AgentView, RunsList, SurfaceStatus, BudgetBar, personaLine, BornFromChip, lastHumanText, teamRows, origFetch;
const h = (...a) => React.createElement(...a);

const AGENTS = [
  { slug: 'nili', name: 'Nili', emoji: '🌿', color: '#1F9C82', skills: ['dispatch'], homeSessionId: 'sess_home', persona: '# who\nYou keep the garden alive.\nNever water at noon.' },
  { slug: 'scout', name: 'Scout', emoji: '🧭', color: '#6A4FC4', skills: [], homeSessionId: null, persona: '' },
];
const SESSIONS = [
  { id: 'sess_home', title: 'Nili', metadata: { agent: 'nili', agentHome: true }, claude: { state: 'working' }, updatedAt: '2026-08-30T10:00:00Z' },
  { id: 'sess_work', title: 'water the beds', metadata: { agent: 'nili' }, claude: { state: 'idle' }, updatedAt: '2026-08-30T11:00:00Z' },
  { id: 'sess_free', title: 'free one', metadata: {}, claude: { state: 'idle' }, updatedAt: '2026-08-30T11:00:00Z' },
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
  // The agent surface embeds the home chat (ChatPane → the VNC client), whose
  // module scope constructs a MutationObserver — SSR never uses it.
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
  ({ default: AgentView, RunsList, SurfaceStatus, BudgetBar, personaLine } = await import(web('components/AgentView.jsx')));
  ({ BornFromChip } = await import(web('components/SessionView.jsx')));
  ({ lastHumanText } = await import(web('lib/composer.js')));
  ({ teamRows } = await import(web('components/SlashCommands.jsx')));
  await store.loadAgents();
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

const noop = () => {};

test('the agent surface is a place: accent header, big avatar, persona line, status + budget, and the בית/ריצות tabs', () => {
  prefs.setPrefs({ language: 'he' });
  const html = render(h(AgentView, { slug: 'nili', tab: 'home', onClose: noop, onTab: noop, onOpenSession: noop }));
  expect(html).toContain('data-agent-surface="nili"');
  // identity block: the avatar is the big one, the handle and the persona's first real line
  expect(html).toContain('data-agent-avatar="nili"');
  expect(html).toContain('width:40px');
  expect(html).toContain('@nili');
  expect(html).toContain('You keep the garden alive.');
  // the accent wash keys off the agent color — this is what stops it reading as a session
  expect(html).toContain('#1F9C8226');
  // the one-liner that names the two surfaces
  expect(html).toContain('בית = לדבר עם הסוכן');
  // tabs, home first and runs present
  for (const id of ['home', 'persona', 'memory', 'connections', 'routine', 'activity', 'runs']) {
    expect(html).toContain(`data-agent-tab="${id}"`);
  }
  expect(html.indexOf('data-agent-tab="home"')).toBeLessThan(html.indexOf('data-agent-tab="persona"'));
  expect(html).toContain('בית');
  expect(html).toContain('ריצות');
  // no session chrome: no tab bar, no "claude-code" header
  expect(html).not.toContain('claude-code');
  prefs.setPrefs({ language: 'en' });
});

test('SurfaceStatus: working while any of its sessions is mid-turn (home counts), else the next run, else idle', () => {
  prefs.setPrefs({ language: 'en' });
  const working = render(h(SurfaceStatus, { agent: AGENTS[0], sessions: SESSIONS, triggers: [] }));
  expect(working).toContain('data-agent-status="working"');
  const idle = render(h(SurfaceStatus, { agent: AGENTS[1], sessions: SESSIONS, triggers: [] }));
  expect(idle).toContain('data-agent-status="idle"');
  expect(idle).toContain('idle');
  const soon = Date.now() + 3 * 3600 * 1000;
  const next = render(h(SurfaceStatus, { agent: AGENTS[1], sessions: SESSIONS, triggers: [{ type: 'cron', agent: 'scout', enabled: true, nextRunAt: soon }] }));
  expect(next).toContain('data-agent-status="next-run"');
  // the home chat is not a "session it is running" — only the work session counts
  const counted = render(h(SurfaceStatus, { agent: AGENTS[0], sessions: SESSIONS.map((s) => ({ ...s, claude: { state: 'idle' } })), triggers: [] }));
  expect(counted).toContain('1 session');
});

test('BudgetBar: a cap renders a bar with used/cap, an exhausted cap says so, no cap says so', () => {
  prefs.setPrefs({ language: 'en' });
  const ok = render(h(BudgetBar, { budget: { cap: 20000, usedTokens: 5000, exceeded: false } }));
  expect(ok).toContain('data-agent-budget="ok"');
  expect(ok).toContain('width:25%');
  expect(ok).toContain('5.0k / 20.0k tokens today');
  expect(render(h(BudgetBar, { budget: { cap: 20000, usedTokens: 21000, exceeded: true } }))).toContain('data-agent-budget="exceeded"');
  expect(render(h(BudgetBar, { budget: null }))).toContain('data-agent-budget="none"');
});

test('personaLine: the first real line, markdown noise stripped, capped', () => {
  expect(personaLine('# who\nYou keep the garden alive.\nmore')).toBe('You keep the garden alive.');
  expect(personaLine('')).toBe('');
  expect(personaLine('  \n- first bullet')).toBe('first bullet');
  expect(personaLine('x'.repeat(200)).length).toBe(120);
});

test('the ריצות tab lists work sessions with state + cost and never the home chat', () => {
  prefs.setPrefs({ language: 'he' });
  const sessions = [
    { id: 'sess_home', title: 'Nili', home: true, claudeState: 'working', status: 'In Progress', updatedAt: '2026-08-30T10:00:00Z', tokens: 300, costUsd: 0.005, turns: 1 },
    { id: 'sess_work', title: 'water the beds', home: false, claudeState: 'working', status: 'In Review', updatedAt: '2026-08-30T11:00:00Z', tokens: 2000, costUsd: 0.03, turns: 2 },
    { id: 'sess_gone', title: 'old run', home: false, archived: true, claudeState: 'idle', status: 'Completed', updatedAt: '2026-08-29T11:00:00Z', tokens: 0, costUsd: 0, turns: 0 },
  ];
  const html = render(h(RunsList, { sessions, onOpenSession: noop }));
  expect(html).toContain('בית = לדבר עם הסוכן'); // the one-liner rides the tab
  expect(html).toContain('data-agent-run="sess_work"');
  expect(html).toContain('water the beds');
  expect(html).toContain('2.0k'); // tokens
  expect(html).toContain('$0.03'); // cost
  expect(html).toContain('data-agent-run="sess_gone"');
  expect(html).toContain('בארכיון');
  // the home chat is NOT a run — it is the tab next door
  expect(html).not.toContain('data-agent-run="sess_home"');
  // empty state carries the one-liner too
  const empty = render(h(RunsList, { sessions: [{ id: 'sess_home', title: 'Nili', home: true }], onOpenSession: noop }));
  expect(empty).toContain('עוד אין סשני עבודה');
  prefs.setPrefs({ language: 'en' });
});

test('lastHumanText: the last thing the HUMAN said, ignoring the agent and the host', () => {
  expect(lastHumanText([
    { kind: 'user', text: 'plant the herbs' },
    { kind: 'assistant-text', text: 'on it' },
  ])).toBe('plant the herbs');
  expect(lastHumanText([
    { kind: 'user', text: 'first' },
    { kind: 'user', text: 'second' },
    { kind: 'user', text: '[host] FINAL WARNING' },
    { kind: 'user', text: '[Forwarded from the chat "x"]\n\nhi' },
  ])).toBe('second');
  expect(lastHumanText([{ kind: 'assistant-text', text: 'only me' }])).toBe('');
  expect(lastHumanText([])).toBe('');
});

test('BornFromChip: a work session says "נולד מ-<agent>"; a home chat never does', () => {
  prefs.setPrefs({ language: 'he' });
  const work = render(h(BornFromChip, { session: { id: 'sess_work', metadata: { agent: 'nili' } } }));
  expect(work).toContain('data-born-from="nili"');
  expect(work).toContain('סשן עבודה · נולד מ-Nili');
  expect(work).toContain('data-agent-avatar="nili"');
  expect(render(h(BornFromChip, { session: { id: 'sess_home', metadata: { agent: 'nili', agentHome: true } } }))).toBe('');
  expect(render(h(BornFromChip, { session: { id: 'sess_free', metadata: {} } }))).toBe('');
  prefs.setPrefs({ language: 'en' });
});

test('teamRows: the count is work sessions — a busy home chat still reads "working"', () => {
  const rows = teamRows(AGENTS, SESSIONS);
  const nili = rows.find((r) => r.agent.slug === 'nili');
  expect(nili.sessions).toBe(1); // sess_work only
  expect(nili.working).toBe(true); // …but the home chat is mid-turn
  expect(rows.find((r) => r.agent.slug === 'scout').sessions).toBe(0);
});
