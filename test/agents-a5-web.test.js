// A5 web: the Routine tab's own "add routine" form (chat is no longer the only
// path, trip-up #2) and its separate "add via chat" button (#8), plus the error
// text a failed command / a refused turn shows — never `Error: HTTP 429 — …`,
// never a Hebrew settings path inside an English sentence (#10 / #11).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, RoutineList, routinePayload, errors, toast;
const h = (...a) => React.createElement(...a);
const AGENT = { slug: 'nili', name: 'Nili', emoji: '✍️', color: '#E0594F' };
const noop = () => {};

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
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  ({ RoutineList, routinePayload } = await import(web('components/RoutineList.jsx')));
  errors = await import(web('lib/errors.js'));
  toast = await import(web('lib/toast.js'));
});

test('#8 the Routine tab offers BOTH an add form and the agent home chat', () => {
  const data = { cron: [], listeners: [] };
  const closed = render(h(RoutineList, { agent: AGENT, data, onAdd: noop, onAddViaChat: noop }));
  expect(closed).toContain('data-routine-add'); // opens the form
  expect(closed).toContain('data-routine-add-chat'); // opens the home chat
  expect(closed).toContain('Add routine');
  expect(closed).toContain('Add via chat');
  expect(closed).not.toContain('data-routine-form');
  expect(closed).toContain('add one with the form above'); // the empty state points at it
  const open = render(h(RoutineList, { agent: AGENT, data, adding: true, onAdd: noop, onAddViaChat: noop, onCreate: noop }));
  expect(open).toContain('data-routine-form="nili"');
  expect(open).toContain('data-routine-schedule');
  expect(open).toContain('data-routine-prompt');
  expect(open).toContain('data-routine-save');
  expect(open).toContain('0 7 * * *'); // a working default, not an empty box
  expect(open).toContain('What should Nili do on every run?');
});

test('#8 the form hands the host a cron trigger payload (schedule + prompt), and needs both', () => {
  expect(routinePayload({ kind: 'cron', value: '0 7 * * *', name: '', prompt: '' })).toBeNull(); // no prompt → nothing is posted
  expect(routinePayload({ kind: 'cron', value: '', name: 'x', prompt: 'do it' })).toBeNull();
  expect(routinePayload({ kind: 'cron', value: ' 0 7 * * * ', name: '', prompt: '  Scan the feeds and report 3 items  ' })).toEqual({
    name: 'Scan the feeds and report 3 items',
    prompt: 'Scan the feeds and report 3 items',
    schedule: { kind: 'cron', value: '0 7 * * *' },
  });
  expect(routinePayload({ kind: 'interval', value: '2h', name: 'Feeds', prompt: 'scan' })).toEqual({
    name: 'Feeds',
    prompt: 'scan',
    schedule: { kind: 'interval', value: '2h' },
  });
});

test('#11 errText: a 429 with a structured budget renders localized, never "Error: HTTP 429"', () => {
  const err = Object.assign(new Error('HTTP 429 — agent "Nili" hit its daily token budget'), {
    status: 429,
    body: { error: 'agent "Nili" hit its daily token budget', budget: { slug: 'nili', name: 'Nili', cap: 900000, usedTokens: 1105884, exceeded: true, resetsAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString() } },
  });
  prefs.setPrefs({ language: 'en' });
  const en = errors.errText(err);
  expect(en).not.toMatch(/HTTP 429/);
  expect(en).not.toMatch(/^Error:/);
  expect(en).not.toMatch(/[֐-׿]/); // no Hebrew path inside the English string
  expect(en).toMatch(/Nili/);
  expect(en).toMatch(/1,105,884/);
  expect(en).toMatch(/900,000/);
  expect(en).toMatch(/00:00/);
  prefs.setPrefs({ language: 'he' });
  const he = errors.errText(err);
  expect(he).toMatch(/[֐-׿]/);
  expect(he).toMatch(/1,105,884/);
  expect(he).not.toMatch(/HTTP 429/);
  prefs.setPrefs({ language: 'en' });
  // anything else falls back to the server's {error}, then the message
  expect(errors.errText(Object.assign(new Error('HTTP 403 — nope'), { body: { error: 'agent "Scout" may not publish artifacts' } }))).toBe('agent "Scout" may not publish artifacts');
  expect(errors.errText(new Error('boom'))).toBe('boom');
  expect(errors.errText('plain')).toBe('plain');
  expect(errors.errText(null)).toBe('');
});

test('#10/#11 toast(): an Error object never reaches the user as "Error: HTTP …"', () => {
  const err = Object.assign(new Error('HTTP 500 — kaboom'), { body: { error: 'kaboom' } });
  expect(toast.toastText(err)).toBe('kaboom');
  expect(toast.toastText('already a sentence')).toBe('already a sentence');
  expect(toast.toastText(new Error('plain failure'))).toBe('plain failure');
  expect(typeof toast.toastError(err)).toBe('number'); // still pushes a toast
});
