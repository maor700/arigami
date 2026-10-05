// Scanner #1/#4/#5: exercise actual form changes, log rendering and failed requests.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();
const rootPath = path.resolve(import.meta.dir, '..');
// Mounting CronSubPanel also mounts EngineToggle/useModels. Bun shares module
// caches across test files, so restoring globals cannot undo that model fetch.
// Run the complete DOM suite in a child (as bugs1-whatsapp.test.ts does) to keep
// the picker/store caches and React subscriptions out of unrelated test files.
if (process.env.CRON_WORKFLOWS_WEB_CHILD !== '1') {
  test('cron workflow DOM regressions run in an isolated process', () => {
    const result = spawnSync('bun', ['test', fileURLToPath(import.meta.url)], {
      cwd: rootPath,
      env: { ...process.env, CRON_WORKFLOWS_WEB_CHILD: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status !== 0) console.error(`${result.stdout}\n${result.stderr}`);
    expect(result.status).toBe(0);
  }, 35_000);
} else {
let React, act, createRoot, CronSubPanel, TriggerLogModal, store, originalStore, root, container, w;
let response, calls = [], poll;
const job = { id: 'trig_test', type: 'cron', name: 'Regression job', enabled: true,
  schedule: { kind: 'cron', value: '5/15 * * * *' }, sessionMode: 'isolated',
  runs: [{ at: '2026-10-05T10:00:00Z', state: 'started', sessionId: 'sess_test' }], log: [], nextRunAt: 1791205200000 };
beforeAll(async () => {
  const { Window } = await import(path.join(rootPath, 'web/node_modules/happy-dom/lib/index.js'));
  w = new Window();
  globalThis.window = globalThis;
  for (const key of ['document', 'HTMLElement', 'HTMLIFrameElement', 'Node', 'Event', 'CustomEvent', 'localStorage']) globalThis[key] = w[key];
  globalThis.location = { origin: 'http://host.test', pathname: '/', port: '', search: '', hash: '' };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.addEventListener = (...args) => w.addEventListener(...args);
  globalThis.removeEventListener = (...args) => w.removeEventListener(...args);
  globalThis.dispatchEvent = (...args) => w.dispatchEvent(...args);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Capture polling so stale/404 handling can be tested without waiting on wall time.
  globalThis.setInterval = (fn) => { poll = fn; return 99; };
  globalThis.clearInterval = () => {};
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).includes('/triggers')) return { ok: true, json: async () => ({ models: [], skills: [] }) };
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    const r = response || { status: 200, body: job };
    if (r.error) throw new Error(r.error);
    return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  React = (await import(path.join(rootPath, 'web/node_modules/react/index.js'))).default;
  act = React.act;
  ({ createRoot } = await import(path.join(rootPath, 'web/node_modules/react-dom/client.js')));
  ({ CronSubPanel, TriggerLogModal } = await import('../web/src/components/Launcher.jsx'));
  store = await import('../web/src/lib/store.js');
  originalStore = { triggers: store.getState().triggers, sessions: store.getState().sessions };
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  container?.remove();
  calls = [];
  response = null;
});
afterAll(() => Object.assign(store.getState(), originalStore));
async function mount(Component, props = {}) {
  Object.assign(store.getState(), { triggers: [job], sessions: [{ id: 'sess_test', title: 'My target' }] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(Component, props)));
}
async function click(text) {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent.trim() === text);
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function select(el, value) {
  await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}

test('schedule kinds retain separate inputs and existing mode offers session titles', async () => {
  await mount(CronSubPanel);
  const kind = container.querySelector('select');
  expect(container.querySelector('input[placeholder="0 9 * * 1-5"]').value).toBe('0 9 * * *');
  await select(kind, 'at');
  expect(container.querySelector('input[placeholder="2026-09-01T09:00:00"]').value).toBe('');
  await select(kind, 'interval');
  expect(container.querySelector('input[placeholder="30m"]').value).toBe('30m');
  await select(kind, 'cron');
  expect(container.querySelector('input[placeholder="0 9 * * 1-5"]').value).toBe('0 9 * * *');
  const mode = [...container.querySelectorAll('select')].find((el) => [...el.options].some((o) => o.value === 'existing'));
  await select(mode, 'existing');
  expect(container.textContent).toContain('My target');
});

test('cron logs display schedule, target and actual run history without Linear metadata', async () => {
  await mount(TriggerLogModal, { triggerId: job.id, onClose() {} });
  expect(container.textContent).toContain('5/15 * * * *');
  expect(container.textContent).toContain('isolated');
  expect(container.textContent).toContain('history: 1 entries');
  expect(container.querySelector('a').getAttribute('href')).toBe('#/session/sess_test');
  expect(container.textContent).not.toContain('primed:');
  expect(container.textContent).not.toContain('filter:');
  expect(container.textContent).not.toContain('polling');
});

test('log failures show retry, recovered details, stale timestamp, and terminal deletion', async () => {
  response = { status: 500, body: { error: 'log unavailable' } };
  await mount(TriggerLogModal, { triggerId: job.id, onClose() {} });
  expect(container.querySelector('[role="alert"]').textContent).toContain('log unavailable');
  response = null;
  await click('Retry');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  response = { error: 'offline' };
  await act(async () => poll());
  expect(container.querySelector('[role="alert"]').textContent).toContain('Last updated:');
  expect(container.textContent).toContain('5/15');
  response = { status: 404, body: { error: 'not found' } };
  await act(async () => poll());
  expect(container.querySelector('[role="alert"]').textContent).toContain('deleted');
  const count = calls.length;
  await act(async () => poll());
  expect(calls.length).toBe(count);
});

for (const action of ['run', 'toggle', 'delete']) test(`failed ${action} is visible and retry reissues the operation`, async () => {
  response = { status: 500, body: { error: 'operation unavailable' } };
  await mount(CronSubPanel);
  const buttons = [...container.querySelectorAll('button')];
  const button = action === 'run' ? buttons.find((b) => b.textContent.trim() === 'Run now')
    : action === 'toggle' ? buttons.find((b) => b.textContent.trim() === 'On')
    : buttons.find((b) => b.title === 'Delete trigger');
  expect(button).toBeTruthy();
  await act(async () => button.click());
  expect(container.querySelector('[role="alert"]').textContent).toContain('operation unavailable');
  const previous = calls.at(-1);
  response = { status: 200, body: { ok: true } };
  await click('Retry');
  expect(calls.at(-1)).toEqual(previous);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

}
