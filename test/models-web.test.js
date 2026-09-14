// MODEL1 (web half): the picker's module-level cache used to be filled ONCE per
// page load and never re-asked — a cockpit tab open for days kept showing the
// model list from the day it was opened, no matter what the server (or the
// CLI behind it) had learned since. Now every picker mount past REVALIDATE_MS
// quietly re-asks GET /models, so a new model appears on the next open.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let models;
let engines;
let LIST = [];
let CODEX = undefined;
let calls = [];

beforeAll(async () => {
  globalThis.fetch = async (url, init) => {
    calls.push(`${init?.method || 'GET'} ${url}`);
    const body = { models: LIST, fetchedAt: 1000, ...(CODEX === undefined ? {} : { codex: CODEX }) };
    return { ok: true, status: 200, url: String(url), json: async () => body, text: async () => JSON.stringify(body) };
  };
  models = await import(web('lib/models.js'));
  engines = await import(web('lib/engines.js'));
});

const values = () => models.modelsSnapshot().models.map((o) => o.value);

test('picker revalidates on mount once REVALIDATE_MS has passed, so a new model appears without a reload', async () => {
  LIST = [{ value: 'default', displayName: 'Default' }, { value: 'claude-fable-5[1m]', displayName: 'Fable' }];
  await models.ensureModels();
  expect(calls).toEqual(['GET /__api/models']);
  expect(values()).toEqual(['default', 'claude-fable-5[1m]']);

  // the CLI updates behind the server; the tab stays open
  LIST = [{ value: 'default', displayName: 'Default' }, { value: 'claude-fable-5-1[1m]', displayName: 'Fable' }];

  // a picker opened right away: fresh enough, no request — the old list stands
  expect(models.ensureModels()).toBeNull();
  expect(calls.length).toBe(1);
  expect(values()).toEqual(['default', 'claude-fable-5[1m]']);

  // a picker opened later: quiet background revalidate → the new model lands
  const p = models.ensureModels(Date.now() + models.REVALIDATE_MS + 1);
  expect(p).not.toBeNull();
  expect(models.modelsSnapshot().loading).toBe(false); // quiet: no spinner, refresh button stays usable
  await p;
  expect(calls).toEqual(['GET /__api/models', 'GET /__api/models']);
  expect(values()).toEqual(['default', 'claude-fable-5-1[1m]']);
});

test('a failed revalidate keeps the last good list and does not retry in a loop', async () => {
  const fetchOk = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(`${init?.method || 'GET'} ${url}`);
    return { ok: false, status: 500, url: String(url), json: async () => ({}), text: async () => 'boom' };
  };
  try {
    const before = values();
    await models.ensureModels(Date.now() + 2 * models.REVALIDATE_MS);
    expect(values()).toEqual(before);
    expect(models.modelsSnapshot().error).toMatch(/500/);
    // the failure counts as a check: the next mount inside the window is silent
    expect(models.ensureModels()).toBeNull();
  } finally {
    globalThis.fetch = fetchOk;
  }
});

// The same response carries the Codex catalog of the ACTIVE codex account
// (server/codex.ts codexModels()); it must reach lib/engines.js so the Codex
// picker lists that login's models — and a response without it (older server,
// or a refresh that failed to read the cache) keeps the last catalog.
test('the Codex catalog rides GET /models into engines.setCodexCatalog(), and is kept when a later response omits it', async () => {
  CODEX = [{ id: 'gpt-6-astra', name: 'GPT-6-Astra', desc: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' }];
  try {
    await models.refreshModels();
    expect(models.modelsSnapshot().codex).toEqual(CODEX);
    expect(engines.codexCatalog().map((m) => m.value)).toEqual(['gpt-6-astra']);
    CODEX = undefined;
    await models.refreshModels();
    expect(engines.codexCatalog().map((m) => m.value)).toEqual(['gpt-6-astra']);
  } finally {
    CODEX = undefined;
    engines.setCodexCatalog(null);
  }
});
