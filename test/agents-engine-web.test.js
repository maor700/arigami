// ENGINE (web): the agent forms carry an engine toggle and a model picker scoped to that engine's catalog.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, store, engines, AgentView, AgentDetailsDrawer, AgentCard, EngineToggle, agentModelOptions;
const h = (...a) => React.createElement(...a);

const CLAUDE_MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'claude-opus-5[1m]', label: 'Opus 5' },
  { value: 'sonnet', label: 'Sonnet' },
];
const AGENTS = [
  { slug: 'astra', name: 'Astra', emoji: '🛰️', color: '#1F9C82', engine: 'codex', model: 'gpt-6-astra', tools: ['desktop', 'web'], skills: [], homeSessionId: null, persona: 'You verify UIs.', createdAt: '2026-09-14T10:00:00Z' },
  { slug: 'plain', name: 'Plain', emoji: '🤖', color: '#6A4FC4', model: 'sonnet', tools: [], skills: [], homeSessionId: null, persona: '', createdAt: '2026-09-14T10:00:00Z' },
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
  globalThis.fetch = async (url) => ({
    ok: true, status: 200, url: String(url),
    json: async () => (String(url).includes('/agents') ? { agents: AGENTS } : String(url).includes('/skills') ? { skills: [] } : { models: [] }),
    text: async () => '',
  });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  store = await import(web('lib/store.js'));
  engines = await import(web('lib/engines.js'));
  ({ default: AgentView, AgentDetailsDrawer } = await import(web('components/AgentView.jsx')));
  ({ default: AgentCard } = await import(web('components/AgentCard.jsx')));
  ({ EngineToggle, agentModelOptions } = await import(web('components/EngineToggle.jsx')));
  await store.loadAgents();
  prefs.setPrefs({ language: 'en' });
});
afterAll(() => prefs.setPrefs({ language: 'en' }));

const noop = () => {};
const values = (opts) => opts.map((o) => o.value);

test('agentModelOptions: the engine\'s own catalog, no "default" row, a stored value the catalog lacks is kept', () => {
  engines.setCodexCatalog(null);
  const codex = values(agentModelOptions('codex', CLAUDE_MODELS, ''));
  expect(codex).toContain('gpt-5.6-terra');
  expect(codex).not.toContain('default');
  expect(codex).not.toContain('sonnet');
  const claude = values(agentModelOptions('', CLAUDE_MODELS, ''));
  expect(claude).toEqual(['claude-opus-5[1m]', 'sonnet']);
  engines.setCodexCatalog([{ id: 'gpt-6-astra', name: 'GPT-6-Astra', desc: '', efforts: ['low', 'high'], defaultEffort: 'high' }]);
  expect(values(agentModelOptions('codex', CLAUDE_MODELS, ''))).toEqual(['gpt-6-astra']);
  expect(values(agentModelOptions('codex', CLAUDE_MODELS, 'gpt-5.5'))).toEqual(['gpt-6-astra', 'gpt-5.5']);
  engines.setCodexCatalog(null);
});

test('EngineToggle: switching engines clears a model the new engine does not list (a claude alias never reaches a codex agent)', () => {
  let got = engines.coerceSessionOptions({ engine: 'codex', model: 'sonnet' }, CLAUDE_MODELS);
  expect(got.engine).toBe('codex');
  expect(got.model).toBe('');
  got = engines.coerceSessionOptions({ engine: 'claude', model: 'gpt-5.6-terra' }, CLAUDE_MODELS);
  expect(got.engine).toBe('');
  expect(got.model).toBe('');
  const html = render(h(EngineToggle, { options: { engine: 'codex', model: 'gpt-6-astra' }, onChange: noop, label: 'Engine', 'data-agent-field': 'engine' }));
  expect(html).toContain('data-agent-field="engine"');
  expect(html).toContain('role="radiogroup"');
  expect(html).toMatch(/aria-checked="true"[^>]*>Codex</);
  expect(html).toMatch(/aria-checked="false"[^>]*>Claude</);
});

test('agent page › settings: a codex agent opens with Advanced expanded, Codex checked, and the model select on the Codex catalog with its model selected', () => {
  engines.setCodexCatalog([{ id: 'gpt-6-astra', name: 'GPT-6-Astra', desc: '', efforts: ['low', 'high'], defaultEffort: 'high' }]);
  const html = render(h(AgentView, { slug: 'astra', tab: 'persona', onClose: noop, onTab: noop, onOpenSession: noop }));
  expect(html).toContain('data-agent-field="engine"');
  expect(html).toMatch(/aria-checked="true"[^>]*>Codex</);
  const sel = html.slice(html.indexOf('data-agent-field="model"'));
  const select = sel.slice(0, sel.indexOf('</select>'));
  expect(select).toContain('value="gpt-6-astra"');
  expect(select).toContain('selected');
  expect(select).not.toContain('value="sonnet"');
  engines.setCodexCatalog(null);
});

test('agent page › settings: an agent without an engine shows Claude Code checked and the claude list', () => {
  const html = render(h(AgentView, { slug: 'plain', tab: 'persona', onClose: noop, onTab: noop, onOpenSession: noop }));
  expect(html).toMatch(/aria-checked="true"[^>]*>Claude</);
  const sel = html.slice(html.indexOf('data-agent-field="model"'));
  const select = sel.slice(0, sel.indexOf('</select>'));
  expect(select).not.toContain('gpt-5.6-terra');
  expect(select).toContain('value="sonnet"'); // kept as the stored value even before the claude list loads
});

test('details drawer: names the engine for a codex agent, says nothing for the default', () => {
  const codex = render(h(AgentDetailsDrawer, { agent: AGENTS[0], budget: null, onClose: noop, onEditPersona: noop }));
  expect(codex).toContain('Codex');
  expect(codex).toContain('gpt-6-astra');
  const plain = render(h(AgentDetailsDrawer, { agent: AGENTS[1], budget: null, onClose: noop, onEditPersona: noop }));
  expect(plain).not.toContain('Claude Code');
  expect(plain).not.toContain('Codex');
});

test('AgentCard: a pending draft with engine codex renders the toggle on Codex; the created summary names Codex', () => {
  const pending = render(h(AgentCard, { sessionId: 'sess_x', event: { kind: 'agent-card', cardId: 'agc_1', action: 'create', state: 'pending', draft: { name: 'Astra', slug: 'astra', emoji: '🛰️', engine: 'codex', model: 'gpt-5.6-terra', persona: 'Verify UIs.' } } }));
  expect(pending).toContain('data-agent-advanced');
  const created = render(h(AgentCard, { sessionId: 'sess_x', event: { kind: 'agent-card', cardId: 'agc_1', action: 'create', state: 'created', agent: AGENTS[0] } }));
  expect(created).toContain('Codex');
  expect(created).toContain('gpt-6-astra');
});

test('Hebrew: the engine label is translated', () => {
  prefs.setPrefs({ language: 'he' });
  const html = render(h(AgentView, { slug: 'astra', tab: 'persona', onClose: noop, onTab: noop, onOpenSession: noop }));
  expect(html).toContain('מנוע');
  prefs.setPrefs({ language: 'en' });
});
