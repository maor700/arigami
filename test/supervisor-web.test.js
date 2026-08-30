// RES1 web (§4): the rail's health dot + "ממתין לך" pill, and the Settings ›
// Host › Health panel. Server-rendered, so what is asserted is the markup the
// human actually gets — including that both locales carry every string the new
// UI reaches for by a computed key (`waiting.what.<kind>`, `health.action.<x>`),
// which the static i18n-keys test cannot see.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, store, prefs, Health, origFetch;
const h = (...a) => React.createElement(...a);

// What GET /health and GET /health/incidents answer in this test.
let HEALTH = {};
let INCIDENTS = {};

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
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/health/incidents') ? INCIDENTS : u.includes('/health') ? HEALTH : {};
    return { ok: true, status: 200, url: u, json: async () => body, text: async () => JSON.stringify(body) };
  };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  store = await import(web('lib/store.js'));
  prefs = await import(web('lib/prefs.js'));
  prefs.setPrefs({ language: 'en' });
  Health = (await import(web('components/settings/Health.jsx'))).default;
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

// ---- the locales carry every computed key the new UI builds -----------------

async function dict(lang) {
  const core = (await import(web(`locales/${lang}.js`)))[lang];
  let d = { ...core };
  for (const f of fs.readdirSync(web(`locales/${lang}`))) d = { ...d, ...(await import(web(`locales/${lang}/${f}`))).strings };
  return d;
}

test('both locales cover every health / waiting key built at runtime', async () => {
  // These are reached as t(`waiting.what.${kind}`) etc., so the static scan in
  // i18n-keys.test.js cannot see them — enumerate them from the source of truth.
  const sup = await import(path.join(ROOT, 'server/supervisor.ts'));
  const kinds = ['action', 'screen', 'setup', 'review', 'merge', 'budget', 'system'];
  const unblocks = ['answer', 'take-over', 'connect', 'approve', 'merge', 'raise-cap', 'fix'];
  const actions = [
    'respawn', 'refresh-auth', 'account-switch', 'model-down', 'model-restore',
    'disable-mcp', 'nudge', 'synthesize-report', 'redeliver-ask', 'notify-human', 'escalate',
  ];
  const keys = [
    ...Object.keys(sup.HEALTH_DOT).map((s) => `rail.health.${s}`),
    ...kinds.map((k) => `waiting.what.${k}`),
    ...unblocks.map((k) => `waiting.do.${k}`),
    ...actions.map((a) => `health.action.${a}`),
    ...['ok', 'failed', 'escalated'].map((o) => `health.outcome.${o}`),
  ];
  const en = await dict('en');
  const he = await dict('he');
  expect(keys.filter((k) => !(k in en))).toEqual([]);
  expect(keys.filter((k) => !(k in he))).toEqual([]);
});

// ---- the store keeps the health map + the queue ------------------------------

test('loadHealth keys the map by session and keeps the queue', async () => {
  HEALTH = {
    sessions: [
      { sessionId: 's1', title: 'one', state: 'RUNNING', reason: 'working', dot: 'blue', since: new Date().toISOString() },
      { sessionId: 's2', title: 'two', state: 'WAITING_HUMAN', reason: 'action-card', dot: 'amber', since: new Date().toISOString() },
    ],
    waiting: [{ sessionId: 's2', title: 'two', kind: 'action', what: 'waiting.what.action', unblock: 'answer', since: new Date().toISOString() }],
  };
  await store.loadHealth();
  const st = store.getState();
  expect(st.health.s2.state).toBe('WAITING_HUMAN');
  expect(st.health.s2.dot).toBe('amber');
  expect(st.health.s1.dot).toBe('blue');
  expect(st.waiting).toHaveLength(1);
  expect(st.waiting[0].unblock).toBe('answer');
});

// ---- Settings › Host › Health ------------------------------------------------

test('the Health panel names what the supervisor did, and offers the one fix', async () => {
  HEALTH = {
    sessions: [
      { sessionId: 's1', title: 'nightly build', state: 'BLOCKED_SYSTEM', reason: 'proc-dead', dot: 'red', since: new Date(Date.now() - 5 * 60_000).toISOString(), model: 'sonnet', modelRung: 1 },
    ],
    waiting: [],
    waitingCount: 0,
    incidents24h: 2,
    by: { respawn: 1, 'model-down': 1 },
    accounts: [
      { id: 'a1', label: 'Personal', pool: true, active: true, available: false, quarantineUntil: new Date(Date.now() + 3 * 3600_000).toISOString() },
      { id: 'a2', label: 'Work', pool: true, active: false, available: true, quarantineUntil: null },
    ],
    modelChain: ['fable', 'sonnet', 'haiku'],
    supervisor: { enabled: true, tickSec: 30 },
  };
  INCIDENTS = {
    hours: 24,
    count: 2,
    incidents: [
      { ts: new Date(Date.now() - 60_000).toISOString(), sessionId: 's1', action: 'model-down', reason: 'accounts-exhausted', outcome: 'ok' },
      { ts: new Date(Date.now() - 9 * 60_000).toISOString(), sessionId: 's1', action: 'respawn', reason: 'proc-dead', outcome: 'ok' },
    ],
  };
  // The store's session list is where the panel reads titles + the ladder state.
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/sessions')
      ? [{ id: 's1', title: 'nightly build', tabs: [], claude: { modelRung: 1, modelChoice: 'sonnet', modelDowngradedFrom: 'fable', modelRestoreAt: new Date(Date.now() + 3600_000).toISOString() } }]
      : u.includes('/health/incidents') ? INCIDENTS : u.includes('/health') ? HEALTH : {};
    return { ok: true, status: 200, url: u, json: async () => body, text: async () => JSON.stringify(body) };
  };
  await store.loadSessions();
  await store.loadHealth();

  const out = render(h(Health));
  // The section, its two headline cards and the quota picture render on the
  // first paint — before the two GETs resolve, the panel must not be blank.
  expect(out).toContain('Health');
  expect(out).toContain('Sessions');
  expect(out).toContain('Accounts &amp; models');
  expect(out).toContain('Incidents (24h)');
  // The one action the panel offers: take the top rung back by hand.
  expect(out).toContain('Back on fable');
  expect(out).toContain('fable → sonnet');
});

test('Hebrew renders the panel and the queue in Hebrew', async () => {
  prefs.setPrefs({ language: 'he' });
  try {
    const out = render(h(Health));
    expect(out).toContain('בריאות');
    expect(out).toContain('חשבונות ומודלים');
    expect(out).toContain('אירועים (24 שעות)');
    expect(out).toContain('חזרה ל-fable');
    // The pill's own label, straight out of the dictionary.
    const he = await dict('he');
    expect(he['rail.waiting.pill']).toContain('ממתין לך');
  } finally {
    prefs.setPrefs({ language: 'en' });
  }
});
