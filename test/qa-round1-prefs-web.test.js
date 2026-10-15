// QA round 1 — theme follows the system on a fresh preference store, an explicit
// choice (or a store written before `themeMode`) keeps winning, chat theme 'auto'
// follows the app.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;

async function load({ stored, light }) {
  globalThis.localStorage = { getItem: () => (stored ? JSON.stringify(stored) : null), setItem() {}, removeItem() {} };
  globalThis.window = { matchMedia: (q) => ({ matches: !!light && /light/.test(q), addEventListener() {} }) };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} } },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  return import(`${path.join(ROOT, 'web/src/lib/prefs.js')}?qa${++n}`);
}

test('fresh store + system light → light; system dark / no signal → dark', async () => {
  let p = await load({ light: true });
  expect(p.getPrefs()).toMatchObject({ themeMode: 'system', theme: 'light' });
  p = await load({ light: false });
  expect(p.getPrefs()).toMatchObject({ themeMode: 'system', theme: 'dark' });
});

test('a store from before themeMode keeps its explicit theme; explicit choice beats the system', async () => {
  let p = await load({ stored: { theme: 'dark' }, light: true });
  expect(p.getPrefs()).toMatchObject({ themeMode: 'dark', theme: 'dark' });
  p = await load({ stored: { theme: 'light' }, light: false });
  expect(p.getPrefs()).toMatchObject({ themeMode: 'light', theme: 'light' });
  p = await load({ light: true });
  p.setPrefs({ theme: 'dark' }); // palette toggle / settings write `theme`
  expect(p.getPrefs()).toMatchObject({ themeMode: 'dark', theme: 'dark' });
  p.setPrefs({ themeMode: 'system' });
  expect(p.getPrefs()).toMatchObject({ themeMode: 'system', theme: 'light' });
});

test('chat theme: auto follows the app theme, an explicit value and a per-session override win', async () => {
  const p = await load({ light: true });
  expect(p.getPrefs().termTheme).toBe('auto');
  expect(p.termViewFrom(p.getPrefs(), 's1').theme).toBe('light');
  p.setPrefs({ termTheme: 'dark' });
  expect(p.termViewFrom(p.getPrefs(), 's1').theme).toBe('dark');
  p.setPrefs({ termTheme: 'auto', termOverrides: { s2: { theme: 'dark' } } });
  expect(p.termViewFrom(p.getPrefs(), 's2').theme).toBe('dark');
  expect(p.termViewFrom(p.getPrefs(), 's1').theme).toBe('light');
});
