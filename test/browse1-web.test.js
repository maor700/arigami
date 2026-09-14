// BROWSE1 web: the machine side panel's empty state (ScreenSidePanel.jsx)
// when a session has no display of its own yet — an explicit message + an
// "allocate" button + a clearly-labelled link out to the shared desktop, per
// SPEC-ARIGAMI-BROWSER-FOR-AGENTS.md #2 (never silently render the shared
// desktop in a session's own panel).
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, ScreenEmptyState;

beforeAll(async () => {
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  ({ ScreenEmptyState } = await import(web('components/ScreenSidePanel.jsx')));
});

const h = (...a) => React.createElement(...a);

test('ScreenEmptyState: explicit "no machine yet" message, an allocate button, and a distinctly-labelled link to the shared machine', () => {
  const out = render(h(ScreenEmptyState, { busy: false, onAllocate: () => {}, onViewShared: () => {} }));
  expect(out).toContain('data-screen-empty-state');
  expect(out).toContain('This session has no machine yet');
  expect(out).toContain('Give this session a machine');
  expect(out).toContain('Shared machine');
  // It must never say "shared" in a way that implies THIS panel already IS
  // the shared desktop — the link text is the only place "shared" appears.
  const sharedCount = (out.match(/[Ss]hared/g) || []).length;
  expect(sharedCount).toBe(1);
});

test('ScreenEmptyState: the allocate button disables while busy', () => {
  const idle = render(h(ScreenEmptyState, { busy: false, onAllocate: () => {}, onViewShared: () => {} }));
  const busy = render(h(ScreenEmptyState, { busy: true, onAllocate: () => {}, onViewShared: () => {} }));
  expect(idle).not.toMatch(/Give this session a machine[^<]*<\/button>[^]*?disabled/);
  expect(busy).toContain('disabled=""');
});
