// A3 web: the request_action card / bar of an agent session shows the agent
// avatar + name + kind and the "auto-approve this kind from now on" toggle
// (never for a plain session or a kind-less action); the auto-approved receipt
// line renders; the Budgets table lists agent × model × cap × used today with
// the exhausted state; the Activity totals + rows render the ledger; the web
// TOOL_FAMILIES match the host's policy families.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, ActionCard, ActionAutoLine, ActionBar, BudgetsTable, fmtTokens, fmtUsd, ActivityTotals, ActivityRow, TOOL_FAMILIES, origFetch;
const h = (...a) => React.createElement(...a);
const AGENT = { slug: 'bot', name: 'Bot', emoji: '🤖', color: '#E0594F' };

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
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  ({ ActionCard, ActionAutoLine, ActionBar } = await import(web('components/ActionCard.jsx')));
  ({ BudgetsTable, fmtTokens, fmtUsd } = await import(web('components/settings/Budgets.jsx')));
  ({ ActivityTotals, ActivityRow } = await import(web('components/AgentView.jsx')));
  ({ TOOL_FAMILIES } = await import(web('components/AgentCard.jsx')));
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

test('ActionCard: agent avatar + name + kind + auto-approve toggle for an agent action with a kind; neither for a plain / kind-less one', () => {
  prefs.setPrefs({ language: 'he' });
  const withAgent = render(h(ActionCard, { sessionId: 's1', action: { id: 'a1', prompt: 'לשלוח?', kind: 'send-email', agent: AGENT, buttons: [{ label: 'כן', value: 'yes', style: 'primary' }] } }));
  expect(withAgent).toContain('data-action-agent="bot"');
  expect(withAgent).toContain('data-agent-avatar="bot"');
  expect(withAgent).toContain('Bot');
  expect(withAgent).toContain('send-email');
  expect(withAgent).toContain('data-action-auto');
  expect(withAgent).toContain('אשר אוטומטית פעולות מסוג &quot;send-email&quot; של Bot מעכשיו');
  const noKind = render(h(ActionCard, { sessionId: 's1', action: { id: 'a2', prompt: 'x', agent: AGENT, buttons: [{ label: 'a', value: 'a' }] } }));
  expect(noKind).toContain('data-action-agent="bot"');
  expect(noKind).not.toContain('data-action-auto');
  const plain = render(h(ActionCard, { sessionId: 's1', action: { id: 'a3', prompt: 'x', kind: 'send-email', buttons: [{ label: 'a', value: 'a' }] } }));
  expect(plain).not.toContain('data-action-agent');
  expect(plain).not.toContain('data-action-auto');
});

test('ActionBar (sticky) and the auto-approved receipt line', () => {
  prefs.setPrefs({ language: 'en' });
  const bar = render(h(ActionBar, { session: { id: 's1', action: { id: 'a1', prompt: 'Merge?', kind: 'merge', agent: AGENT, buttons: [{ label: 'Yes', value: 'yes' }] } } }));
  expect(bar).toContain('data-action-agent="bot"');
  expect(bar).toContain('merge');
  expect(bar).toContain('auto-approve this kind from now on');
  const plainBar = render(h(ActionBar, { session: { id: 's1', action: { id: 'a1', prompt: 'Merge?', buttons: [{ label: 'Yes', value: 'yes' }] } } }));
  expect(plainBar).not.toContain('data-action-auto');
  const line = render(h(ActionAutoLine, { event: { kind: 'action-auto', prompt: 'Send the mail?', actionKind: 'send-email', value: 'send', label: 'Send', agent: AGENT } }));
  expect(line).toContain('data-action-auto-line');
  expect(line).toContain('auto-approved · send-email');
  expect(line).toContain('Send the mail?');
  expect(line).toContain('data-agent-avatar="bot"');
});

test('Budgets table: agent × model × cap × used today, exhausted state, formatting', () => {
  prefs.setPrefs({ language: 'he' });
  const rows = [
    { slug: 'bot', name: 'Bot', emoji: '🤖', color: '#E0594F', model: 'sonnet', cap: 50000, usedTokens: 52000, usedCostUsd: 0.42, exceeded: true },
    { slug: 'ops', name: 'Ops', emoji: '🛠️', color: '#1F9C82', model: null, cap: null, usedTokens: 1200, usedCostUsd: 0, exceeded: false },
  ];
  const html = render(h(BudgetsTable, { rows, day: '2026-08-30' }));
  expect(html).toContain('data-budget-row="bot"');
  expect(html).toContain('data-budget-row="ops"');
  expect(html).toContain('sonnet');
  expect(html).toContain('ברירת מחדל');
  expect(html).toContain('value="50000"');
  expect(html).toContain('52.0k'); // used
  expect(html).toContain('50.0k'); // cap
  expect(html).toContain('100%');
  expect(html).toContain('$0.420');
  expect(html).toContain('נוצל'); // exhausted pill
  expect(html).toContain('1.2k');
  expect(html).toContain('יום: 2026-08-30');
  expect(render(h(BudgetsTable, { rows: [], day: '' }))).toContain('אין עדיין סוכנים');
  expect(fmtTokens(999)).toBe('999');
  expect(fmtTokens(1_500_000)).toBe('1.5M');
  expect(fmtUsd(0.0042)).toBe('$0.004');
  expect(fmtUsd(0)).toBe('$0');
});

test('Activity totals + rows: budget line, kinds, tokens/cost per turn', () => {
  prefs.setPrefs({ language: 'en' });
  const totals = { tokens: 12345, costUsd: 0.12, turns: 7, sessions: 2, actions: 1, artifacts: 3, denied: 2 };
  const tot = render(h(ActivityTotals, { totals, budget: { cap: 20000, usedTokens: 12345, exceeded: false, resetsAt: '2026-08-31T00:00:00' } }));
  expect(tot).toContain('data-activity-totals');
  expect(tot).toContain('12.3k');
  expect(tot).toContain('$0.12');
  expect(tot).toContain('12.3k / 20.0k (62%)');
  const exhausted = render(h(ActivityTotals, { totals, budget: { cap: 10000, usedTokens: 12345, exceeded: true, resetsAt: '2026-08-31T00:00:00' } }));
  expect(exhausted).toContain('exhausted — no new sessions until 00:00');
  expect(render(h(ActivityTotals, { totals, budget: { cap: null, usedTokens: 0, exceeded: false } }))).toContain('no cap');
  const turn = render(h(ActivityRow, { e: { ts: '2026-08-30T10:05:00', kind: 'turn', sessionId: 'sess_abcdef12', tokens: 1000, costUsd: 0.01, model: 'claude-sonnet' } }));
  expect(turn).toContain('data-activity-kind="turn"');
  expect(turn).toContain('1.0k · $0.010');
  expect(turn).toContain('claude-sonnet');
  const action = render(h(ActivityRow, { e: { ts: '2026-08-30T10:05:00', kind: 'action', auto: true, actionKind: 'send-email', value: 'send', detail: 'Send?' } }));
  expect(action).toContain('auto-approved · send-email → send — Send?');
  const denied = render(h(ActivityRow, { e: { ts: '2026-08-30T10:05:00', kind: 'policy', reason: 'tool "Bash" is not in agent bot\'s allowlist' } }));
  expect(denied).toContain('data-activity-kind="policy"');
  expect(denied).toContain('not in agent bot');
});

test('web TOOL_FAMILIES = the host policy families (server/agent-policy.ts FAMILIES — read as text, never imported in-process)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/agent-policy.ts'), 'utf8');
  const body = src.slice(src.indexOf('export const FAMILIES'), src.indexOf('export const FAMILY_IDS'));
  const ids = [...body.matchAll(/^\s{2}([a-z]+):\s*\[/gm)].map((m) => m[1]);
  expect(ids.length).toBeGreaterThan(5);
  expect([...TOOL_FAMILIES].sort()).toEqual([...ids].sort());
});
