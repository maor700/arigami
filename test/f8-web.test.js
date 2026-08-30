// F8 — first-screen render: the no-sessions view is one question + three
// chips + an "Advanced" link (no Linear / permission-mode jargon), in both
// locales; the launcher's empty form hides its options behind "Advanced".
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, FirstRun, FIRST_RUN_CHIPS;

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  ({ default: FirstRun, FIRST_RUN_CHIPS } = await import(web('components/FirstRun.jsx')));
});

const mount = () => render(React.createElement(FirstRun, { config: { defaultCwd: '/tmp/ws' }, sessions: [], onCreated() {}, onOpenLauncher() {} }));

test('FirstRun (en): one prompt box, three chips, Advanced link — no Linear', () => {
  prefs.setPrefs({ language: 'en' });
  const html = mount();
  expect(html).toContain('What would you like me to do?');
  expect(html).toContain('data-testid="first-run-prompt"');
  for (const c of ['screenshot', 'whatsapp', 'clone']) expect(html).toContain(`first-run-chip-${c}`);
  expect(html).toContain('Screenshot a site');
  expect(html).toContain('Connect WhatsApp');
  expect(html).toContain('Clone a repo');
  expect(html).toContain('Advanced');
  expect(html).not.toMatch(/Linear|ENG-|bypassPermissions/);
  expect(FIRST_RUN_CHIPS.map((c) => c.id)).toEqual(['screenshot', 'whatsapp', 'clone']);
});

test('FirstRun (he): the question and chips are Hebrew', () => {
  prefs.setPrefs({ language: 'he' });
  const html = mount();
  expect(html).toContain('מה תרצה שאעשה?');
  expect(html).toContain('צלם לי אתר');
  expect(html).toContain('חבר וואטסאפ');
  expect(html).toContain('שכפל ריפו');
  prefs.setPrefs({ language: 'en' });
});

test('Launcher source: ticket tab gated on Linear, empty form has an Advanced fold, default tab is empty', () => {
  const src = fs.readFileSync(web('components/Launcher.jsx'), 'utf8');
  expect(src).toMatch(/useState\(initialMode \|\| 'empty'\)/);
  expect(src).toMatch(/\{linear && \(\s*<button/);
  expect(src).toMatch(/launcher\.empty\.advanced/);
  expect(src).toMatch(/api\.get\('\/linear\/status'\)/);
});

test('Rail source: Pending/Triggers and Usage are hidden until a session exists', () => {
  const src = fs.readFileSync(web('components/Rail.jsx'), 'utf8');
  expect(src).toMatch(/\{\(serverCount > 0 \|\| \(pending \|\| \[\]\)\.length > 0\) && \(\s*<PendingSection/);
  expect(src).toMatch(/\{serverCount > 0 && <UsageMini/);
});
