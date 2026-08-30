// UX2 web: creating an agent is a SURFACE (AgentView in create mode), not a
// session — the rail button and `/agent new` both open it; "אמץ סוכן" is a
// composer command (`/adopt <agent>`) with a chat receipt + revert button.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, store, AgentView, resolveSubmission, AgentAdoptLine, origFetch;
const h = (...a) => React.createElement(...a);

const AGENTS = [{ slug: 'nili', name: 'Nili', emoji: '🌿', color: '#1F9C82', skills: [], homeSessionId: null, persona: '' }];

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
  ({ default: AgentView } = await import(web('components/AgentView.jsx')));
  ({ resolveSubmission } = await import(web('lib/composer.js')));
  ({ AgentAdoptLine } = await import(web('components/DelegatedLine.jsx')));
  await store.loadAgents();
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

const noop = () => {};

test('AgentView create mode: a draft, not a fetched agent — disabled tabs with a hint, "צור סוכן", no delete/openHome, a slug field', () => {
  prefs.setPrefs({ language: 'he' });
  const html = render(h(AgentView, { slug: '__new__', tab: 'persona', draftName: 'שרה', onClose: noop, onTab: noop, onOpenSession: noop, onCreated: noop }));
  expect(html).toContain('data-agent-page="__new__"');
  // only פרסונה is enabled; the rest carry the "available after creation" hint
  expect(html).toContain('data-agent-tab="persona"');
  for (const id of ['home', 'memory', 'connections', 'routine', 'activity', 'runs']) {
    expect(html).toMatch(new RegExp(`data-agent-tab="${id}"[^>]*disabled`));
  }
  expect(html).toContain('יהיה זמין אחרי היצירה');
  expect(html).toContain('צור סוכן'); // primary action, not "שמור"
  expect(html).not.toContain('מחק סוכן'); // no delete in create mode
  expect(html).not.toContain('פתח צ׳אט בית'); // no home button before the agent exists
  expect(html).toContain('data-agent-field="slug"');
  expect(html).toContain('שרה'); // draftName prefilled
  expect(html).not.toContain('@__new__'); // the sentinel never leaks into the header
  prefs.setPrefs({ language: 'en' });
});

test('AgentView existing-agent mode is unaffected: tabs enabled, save + delete + open home present', () => {
  prefs.setPrefs({ language: 'he' });
  const html = render(h(AgentView, { slug: 'nili', tab: 'persona', onClose: noop, onTab: noop, onOpenSession: noop }));
  expect(html).not.toMatch(/data-agent-tab="home"[^>]*disabled/);
  expect(html).toContain('שמור');
  expect(html).toContain('מחק סוכן');
  expect(html).toContain('פתח צ׳אט בית');
  expect(html).not.toContain('data-agent-field="slug"'); // slug is fixed once the agent exists
  prefs.setPrefs({ language: 'en' });
});

test('composer /adopt <agent>: resolves to an adopt action; unknown agent and bare usage are distinct', () => {
  const agents = [{ slug: 'nili', name: 'Nili' }];
  expect(resolveSubmission('/adopt nili', { agents })).toMatchObject({ type: 'adopt', agent: { slug: 'nili' } });
  expect(resolveSubmission('/adopt ghost', { agents })).toEqual({ type: 'unknown-agent', name: 'ghost' });
  expect(resolveSubmission('/adopt', { agents })).toEqual({ type: 'adopt-usage' });
  expect(resolveSubmission('/adopt   ', { agents })).toEqual({ type: 'adopt-usage' });
});

test('{kind:"agent-adopt"} receipt: says what changed and offers "החזר לרגיל"; a reverted one does not', () => {
  prefs.setPrefs({ language: 'he' });
  const on = render(h(AgentAdoptLine, { sessionId: 's1', event: { kind: 'agent-adopt', agent: { slug: 'nili', name: 'Nili', emoji: '🌿' }, prevAgent: null } }));
  expect(on).toContain('data-agent-adopt="nili"');
  expect(on).toContain('Nili');
  expect(on).toContain('חלים מהתור הבא');
  expect(on).toContain('data-agent-adopt-revert');
  expect(on).toContain('החזר לרגיל');
  const off = render(h(AgentAdoptLine, { sessionId: 's1', event: { kind: 'agent-adopt', agent: null, reverted: true } }));
  expect(off).toContain('data-agent-adopt-reverted');
  expect(off).not.toContain('data-agent-adopt-revert="'); // the button, not the -reverted flag
  expect(off).toContain('חזר לרגיל');
  prefs.setPrefs({ language: 'en' });
});

test('Rail source: "+ סוכן חדש" opens the agent surface in create mode — no session is created', () => {
  const src = fs.readFileSync(web('components/Rail.jsx'), 'utf8');
  const m = /onNewAgent=\{([^\n]*)\}\s*\n/.exec(src);
  expect(m).toBeTruthy();
  const snippet = m[1];
  expect(snippet).toMatch(/openAgent\(\s*'__new__'/);
  expect(snippet).not.toMatch(/post\(\s*['"`]\/sessions['"`]/);
});

test('SessionView source: "/agent new" opens the create-mode surface (not the agent-card chat route); "/adopt" posts adopt-agent', () => {
  const src = fs.readFileSync(web('components/SessionView.jsx'), 'utf8');
  const agentNew = /if \(r\.type === 'agent-new'\) \{([\s\S]*?)\n\s*\}/.exec(src);
  expect(agentNew).toBeTruthy();
  expect(agentNew[1]).toMatch(/openAgent\('__new__'/);
  expect(agentNew[1]).not.toMatch(/agent-card/);
  const adopt = /if \(r\.type === 'adopt'\) \{([\s\S]*?)\n\s*\}/.exec(src);
  expect(adopt).toBeTruthy();
  expect(adopt[1]).toMatch(/\/adopt-agent/);
});
