// The "add a repository" form shows what almost everyone needs — pick or paste a repo, then Add — and keeps the
// name, install command and env-file options behind "Advanced options" (they were tiring, and rarely matter).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
let React, render, AddRepo, prefs;

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
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  ({ AddRepo } = await import(web('components/Setup.jsx')));
});
afterAll(() => {});

test('the open form hides install command, env options and the name field until "Advanced options"', () => {
  prefs.setPrefs({ language: 'en' }); // other files in this process may have left another language on
  const html = render(React.createElement(AddRepo, { onAdd() {}, busy: false, defaultOpen: true }));
  expect(html).toContain('Advanced options');
  expect(html).toContain('Add'); // the primary action
  expect(html).not.toContain('install command (auto-detected if blank)');
  expect(html).not.toContain('env:');
  expect(html).not.toContain('name (e.g. app)');
});
