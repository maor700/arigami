import { test, expect } from 'bun:test';
import { toolDisplayName, inputRows } from '../web/src/lib/pretty-input.js';
import { withBest } from '../server/models.js';

test('toolDisplayName: an MCP tool reads as source + action, a built-in keeps its name', () => {
  expect(toolDisplayName('mcp__arigami__browser_logins')).toEqual({ source: 'Arigami', action: 'Browser logins' });
  expect(toolDisplayName('mcp__composio-mcp__GMAIL_SEND_EMAIL')).toEqual({ source: 'Composio', action: 'Gmail send email' });
  expect(toolDisplayName('WebFetch')).toEqual({ source: '', action: 'Web Fetch' });
});

test('inputRows: no params → [], flat scalars → rows, nested → null (raw JSON fallback)', () => {
  expect(inputRows({})).toEqual([]);
  expect(inputRows(null)).toEqual([]);
  expect(inputRows({ site: 'pluxee.co.il', session_id: '' })).toEqual([{ key: 'site', value: 'pluxee.co.il', long: false }]);
  expect(inputRows({ patch: { a: 1 } })).toBeNull();
});

test('withBest: puts the CLI `best` alias first, once, with the effort ladder of the list', () => {
  const list = { models: [{ value: 'default', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }, { value: 'haiku' }] };
  const out = withBest(list);
  expect(out.models.map((m) => m.value)).toEqual(['best', 'default', 'haiku']);
  expect(out.models[0].supportedEffortLevels).toEqual(['low', 'high']);
  expect(withBest(out).models.length).toBe(3);
  expect(withBest({ models: [] }).models).toEqual([]);
});
