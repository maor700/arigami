// EXT wave 2 (web) — the cockpit side of the extension system.
//
//   · lib/ext.js         the permission algebra, wire-event normalisation and
//                        the manifest→UI derivations (settings form, tab rows,
//                        slash items)
//   · lib/ext-bridge.js  the shell half of the FROZEN postMessage protocol
//                        (sdk/browser/ext-sdk.js): source check, permission
//                        check, REST routing, event forwarding
//   · Settings           the new "extensions" category renders a manifest
//   · ChatPane           `ext-card` renders, and degrades instead of breaking
//   · composer           a manifest `openFrom:"slash:/pick"` becomes a command
//
// Pure and offline: no host, no network, no claude. `fetch` is stubbed and the
// bridge takes its REST client by injection.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, ext, bridgeMod, composer, prefs, SettingsMod, ChatPane, ExtensionsPage, ExtensionCard, TabBarMod;
const h = (...a) => React.createElement(...a);

// A manifest as GET /__api/extensions reports it (server/extensions.ts listExtensions).
const HELLO = {
  name: 'hello',
  title: 'Hello',
  description: 'The smallest extension.',
  version: '0.1.0',
  apiVersion: 1,
  enabled: true,
  state: 'loaded',
  error: null,
  warnings: ['daemons[] is parsed but NOT run'],
  sha: 'abcdef1234567890',
  permissions: ['session:message', 'session:tabs', 'tools:hello_echo', 'notify', 'events:merge.*', 'events:chat'],
  settingsSchema: {
    greeting: { type: 'string', default: 'שלום', title: 'Greeting', description: 'What the tab greets with' },
    count: { type: 'number', default: 3, title: 'Count' },
    loud: { type: 'boolean', default: false, title: 'Loud' },
  },
  settings: { greeting: 'hi' },
  secretKeys: [],
  contributions: { tools: 1, listeners: 1, docs: 1, tabs: 1, hooks: 2, gates: 1, channels: 0, webhooks: 1 },
  tabs: [{ id: 'hello', title: 'Hello', icon: 'hand-wave', entry: 'ui/index.html', openFrom: ['tab-bar', 'slash:/hi'] }],
  listenerTypes: ['hello-tick'],
  docs: [{ skill: 'hello', description: 'Use when…' }],
  toolServers: ['ext-hello'],
};

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '', search: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, getElementById: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => ({}), text: async () => '{}' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  ext = await import(web('lib/ext.js'));
  bridgeMod = await import(web('lib/ext-bridge.js'));
  composer = await import(web('lib/composer.js'));
  SettingsMod = await import(web('components/Settings.jsx'));
  ({ default: ChatPane } = await import(web('components/ChatPane.jsx')));
  ({ default: ExtensionsPage, ExtensionCard } = await import(web('components/settings/Extensions.jsx')));
  TabBarMod = await import(web('components/TabBar.jsx'));
  prefs.setPrefs({ language: 'en' });
});

/* ---------- the permission algebra --------------------------------------- */

test('globMatch: exact, trailing-star prefix, and a bare "*" is NOT a wildcard', () => {
  const { globMatch } = ext;
  expect(globMatch('chat', 'chat')).toBe(true);
  expect(globMatch('merge.*', 'merge.done')).toBe(true);
  expect(globMatch('merge.*', 'merge')).toBe(false); // the prefix is 'merge.', not 'merge'
  expect(globMatch('merge.*', 'mergedone')).toBe(false);
  expect(globMatch('chat', 'chat:s1')).toBe(false);
  expect(globMatch('*', 'anything')).toBe(false); // a bare star grants nothing
  expect(globMatch('a*b', 'axxb')).toBe(false); // only a TRAILING star is a glob
});

test('hasPermission: exact, namespaced glob, and no accidental prefix matches', () => {
  const { hasPermission } = ext;
  const p = HELLO.permissions;
  expect(hasPermission(p, 'session:message')).toBe(true);
  expect(hasPermission(p, 'session:prompts')).toBe(false);
  expect(hasPermission(p, 'tools:hello_echo')).toBe(true);
  expect(hasPermission(p, 'tools:other')).toBe(false);
  expect(hasPermission(['tools:*'], 'tools:anything')).toBe(true);
  expect(hasPermission(p, 'events:merge.done')).toBe(true);
  expect(hasPermission(p, 'events:chat')).toBe(true);
  expect(hasPermission(p, 'events:session-updated')).toBe(false);
  expect(hasPermission(['*'], 'session:message')).toBe(false); // un-namespaced star: nothing
  expect(hasPermission([], 'session:message')).toBe(false);
  expect(hasPermission(null, '')).toBe(false);
});

test('permissionsFor: queue is covered by session:prompts OR the stronger session:message', () => {
  const { permissionsFor } = ext;
  expect(permissionsFor('sendPrompt', { mode: 'now' })).toEqual(['session:message']);
  expect(permissionsFor('sendPrompt', { mode: 'queue' })).toEqual(['session:prompts', 'session:message']);
  expect(permissionsFor('runTool', { name: 'x' })).toEqual(['tools:x']);
  expect(permissionsFor('setStatus')).toEqual(['session:tabs']);
  expect(permissionsFor('openArtifact')).toEqual(['session:tabs']);
  expect(permissionsFor('close')).toEqual(['session:tabs']);
  expect(permissionsFor('subscribe')).toEqual([]);
  expect(permissionsFor('deleteEverything')).toBe(null);
});

test('normalizeWireEvent: exactly the four subscribable names, with their session id', () => {
  const { normalizeWireEvent } = ext;
  expect(normalizeWireEvent({ type: 'chat:s1', event: { kind: 'result' } })).toEqual({ name: 'chat', sessionId: 's1', payload: { kind: 'result' } });
  expect(normalizeWireEvent({ type: 'session-updated', session: { id: 's2', title: 'x' } })).toEqual({ name: 'session-updated', sessionId: 's2', payload: { id: 's2', title: 'x' } });
  expect(normalizeWireEvent({ type: 'listener-updated', listener: { id: 'l1', sessionId: 's3' } })).toEqual({ name: 'listener-updated', sessionId: 's3', payload: { id: 'l1', sessionId: 's3' } });
  expect(normalizeWireEvent({ type: 'ext:hello', n: 1 })).toEqual({ name: 'ext:hello', sessionId: '', payload: { type: 'ext:hello', n: 1 } });
  // Everything else stays inside the cockpit.
  expect(normalizeWireEvent({ type: 'tab-updated' })).toBe(null);
  expect(normalizeWireEvent({ type: 'permission-request' })).toBe(null);
  expect(normalizeWireEvent({ type: 'health' })).toBe(null);
  expect(normalizeWireEvent(null)).toBe(null);
});

/* ---------- manifest → UI ------------------------------------------------- */

test('settingsFields / fieldValue / coerceSettings round-trip the three types', () => {
  const fields = ext.settingsFields(HELLO.settingsSchema);
  expect(fields.map((f) => [f.key, f.type])).toEqual([['greeting', 'string'], ['count', 'number'], ['loud', 'boolean']]);
  expect(fields[0].title).toBe('Greeting');
  // saved value wins over the schema default
  expect(ext.fieldValue(fields[0], HELLO.settings)).toBe('hi');
  expect(ext.fieldValue(fields[1], HELLO.settings)).toBe('3');
  expect(ext.fieldValue(fields[2], HELLO.settings)).toBe(false);
  expect(ext.coerceSettings(fields, { greeting: 'yo', count: '7', loud: true })).toEqual({ greeting: 'yo', count: 7, loud: true });
  // an empty or non-numeric number field is omitted, never sent as NaN
  expect(ext.coerceSettings(fields, { greeting: '', count: '', loud: false })).toEqual({ greeting: '', loud: false });
  expect(ext.coerceSettings(fields, { count: 'abc' })).toEqual({ greeting: '', loud: false });
  expect(ext.settingsFields(null)).toEqual([]);
  expect(ext.settingsFields([1, 2])).toEqual([]);
});

test('extTabItems / extSlashItems only offer LOADED and ENABLED extensions', () => {
  const off = { ...HELLO, name: 'off', enabled: false };
  const broken = { ...HELLO, name: 'broken', state: 'error' };
  const list = [HELLO, off, broken];
  expect(ext.extTabItems(list)).toEqual([{ ext: 'hello', extTitle: 'Hello', tab: 'hello', title: 'Hello', icon: 'hand-wave' }]);
  const slash = ext.extSlashItems(list);
  expect(slash).toHaveLength(1);
  expect(slash[0].name).toBe('hi');
  expect(slash[0].run).toBe(true);
  expect(slash[0].extTab).toEqual({ ext: 'hello', tab: 'hello', title: 'Hello' });
  expect(ext.extSlashItems([])).toEqual([]);
});

test('extOfTab: the stamped field, else the /__ext/ url, else nothing', () => {
  expect(ext.extOfTab({ ext: 'hello', url: '/__ext/hello/' })).toBe('hello');
  expect(ext.extOfTab({ url: '/__ext/hello/index.html?x=1' })).toBe('hello');
  expect(ext.extOfTab({ url: '/__ext/hello' })).toBe('hello');
  expect(ext.extOfTab({ url: '/__artifacts/abc/' })).toBe('');
  expect(ext.extOfTab({ url: 'http://localhost:3021/' })).toBe('');
  expect(ext.extOfTab(null)).toBe('');
});

/* ---------- the bridge ---------------------------------------------------- */

function harness(overrides = {}) {
  const calls = [];
  const posted = [];
  const win = { id: 'the-iframe' };
  let wireFn = null;
  const api = {
    post: async (p, b) => { calls.push(['POST', p, b]); return { ok: true, result: { echoed: b } }; },
    patch: async (p, b) => { calls.push(['PATCH', p, b]); return { ok: true }; },
    del: async (p) => { calls.push(['DELETE', p]); return { ok: true }; },
    get: async (p) => { calls.push(['GET', p]); return {}; },
  };
  const bridge = bridgeMod.createExtBridge({
    sessionId: 's1',
    tabId: 'tab_1',
    extension: 'hello',
    getWindow: () => win,
    getPermissions: () => overrides.permissions ?? HELLO.permissions,
    getSessionState: () => overrides.sessionState ?? 'idle',
    getContext: () => ({ sessionId: 's1', tabId: 'tab_1', extension: 'hello', apiVersion: 1, settings: { greeting: 'hi' }, permissions: HELLO.permissions }),
    post: (m) => posted.push(m),
    api,
    subscribeWire: (fn) => { wireFn = fn; return () => { wireFn = null; }; },
  });
  const send = (data) => bridge.onMessage({ source: win, data });
  return { bridge, calls, posted, win, send, api, wire: (m) => wireFn?.(m), hasWire: () => !!wireFn };
}

// A LAUNCHER tab: `sessionId: null`. Same bridge, same protocol — the whole
// difference is that there is no session yet, which is the point of the surface.
function launcherHarness(overrides = {}) {
  const calls = [];
  const posted = [];
  const created = [];
  const win = { id: 'the-iframe' };
  let wireFn = null;
  const api = {
    post: async (p, b) => {
      calls.push(['POST', p, b]);
      return overrides.postResult ?? { id: 'sess_new', title: b?.title };
    },
    patch: async (p, b) => { calls.push(['PATCH', p, b]); return { ok: true }; },
    del: async (p) => { calls.push(['DELETE', p]); return { ok: true }; },
    get: async (p) => { calls.push(['GET', p]); return {}; },
  };
  const perms = overrides.permissions ?? ['host:create-session', 'tools:list_pulls', 'events:chat'];
  const bridge = bridgeMod.createExtBridge({
    sessionId: null,
    tabId: null,
    extension: 'hello',
    getWindow: () => win,
    getPermissions: () => perms,
    getContext: () => ({ sessionId: null, tabId: null, extension: 'hello', apiVersion: 1, settings: {}, permissions: perms }),
    post: (m) => posted.push(m),
    onCreated: (s) => created.push(s),
    api,
    subscribeWire: (fn) => { wireFn = fn; return () => { wireFn = null; }; },
  });
  const send = (data) => bridge.onMessage({ source: win, data });
  return { bridge, calls, posted, created, send, wire: (m) => wireFn?.(m) };
}

const callMsg = (method, args) => ({ type: 'arigami:call', id: 'c1', method, args });
const reply = (posted) => posted.find((m) => m.type === 'arigami:result');

test('launcher tab: the context says there is no session', async () => {
  const t = launcherHarness();
  await t.send({ type: 'arigami:hello', v: 1 });
  expect(t.posted[0].type).toBe('arigami:init');
  expect(t.posted[0].context.sessionId).toBe(null);
});

test('launcher tab: every session-scoped call is refused, and says why', async () => {
  for (const [method, args] of [
    ['sendPrompt', { text: 'hi', mode: 'now' }],
    ['setStatus', { badge: 'x' }],
    ['openArtifact', { path: '/a.png' }],
  ]) {
    const t = launcherHarness({ permissions: ['session:message', 'session:tabs', 'host:create-session'] });
    await t.send(callMsg(method, args));
    const r = reply(t.posted);
    expect(r.error).toContain('needs a session');
    // The real damage this prevents: a request to /sessions/null/... which the
    // host answers 404 and the tab reports as "not found" to a blameless human.
    expect(t.calls).toEqual([]);
  }
});

test('launcher tab: runTool is NOT session-scoped and still works', async () => {
  const t = launcherHarness();
  await t.send(callMsg('runTool', { name: 'list_pulls', args: { repo: 'a/b' } }));
  expect(t.calls[0][0]).toBe('POST');
  expect(t.calls[0][1]).toBe('/ext/hello/tool/list_pulls');
  expect(reply(t.posted).ok).toBe(true);
});

test('launcher tab: createSession posts, hands the record back, and returns the id', async () => {
  const t = launcherHarness();
  await t.send(callMsg('createSession', { spec: { title: 'Review a/b#7', prompt: 'review it', agent: 'code-review', metadata: { prNumber: 7 } } }));
  expect(t.calls[0][0]).toBe('POST');
  expect(t.calls[0][1]).toBe('/sessions');
  expect(t.calls[0][2].title).toBe('Review a/b#7');
  expect(t.calls[0][2].metadata).toEqual({ prNumber: 7 });
  expect(t.created[0].id).toBe('sess_new');
  expect(reply(t.posted).value).toEqual({ id: 'sess_new' });
});

test('launcher tab: createSession drops the orchestration fields a tab must not set', async () => {
  const t = launcherHarness();
  // `master`/`kind`/`subtask`/`worktree` would graft this session into someone
  // else's dispatch tree. An allowlist, not a spread — so they never arrive.
  await t.send(callMsg('createSession', { spec: { title: 'x', master: 's_other', kind: 'mutating', subtask: 'n1', worktree: true } }));
  const body = t.calls[0][2];
  expect(body.title).toBe('x');
  for (const k of ['master', 'kind', 'subtask', 'worktree']) expect(body[k]).toBeUndefined();
});

test('launcher tab: createSession without the permission is refused before any POST', async () => {
  const t = launcherHarness({ permissions: ['tools:list_pulls'] });
  await t.send(callMsg('createSession', { spec: { title: 'x' } }));
  expect(reply(t.posted).error).toContain('host:create-session');
  expect(t.calls).toEqual([]);
});

test('launcher tab: a deferred create is reported as such, not as a session', async () => {
  const t = launcherHarness({ postResult: { deferred: true, reason: 'at-capacity' } });
  await t.send(callMsg('createSession', { spec: { title: 'x' } }));
  expect(reply(t.posted).error).toContain('at-capacity');
  expect(t.created).toEqual([]);
});

test('createSession is refused INSIDE a session — the MCP tool is that path', async () => {
  const t = harness({ permissions: [...HELLO.permissions, 'host:create-session'] });
  await t.send(callMsg('createSession', { spec: { title: 'x' } }));
  expect(reply(t.posted).error).toContain('launcher tabs');
});

test('launcher tab: a session-scoped event never reaches it', async () => {
  const t = launcherHarness();
  await t.send(callMsg('subscribe', { events: ['chat'] }));
  t.wire({ type: 'chat:s1', payload: { event: { kind: 'result' } } });
  expect(t.posted.filter((m) => m.type === 'arigami:event')).toEqual([]);
});

test('extLauncherItems: only launcher tabs, only with the permission', () => {
  const mk = (over) => ({ name: 'pr', title: 'PR', state: 'loaded', enabled: true, ...over });
  const tabs = [
    { id: 'pick', title: 'From PR', entry: 'ui/index.html', openFrom: ['launcher'] },
    { id: 'side', title: 'Side', entry: 'ui/side.html', openFrom: ['tab-bar'] },
  ];
  // Holds the permission → the launcher tab is offered, the tab-bar one is not.
  const ok = ext.extLauncherItems([mk({ tabs, permissions: ['host:create-session'] })]);
  expect(ok.length).toBe(1);
  expect(ok[0].mode).toBe('ext:pr:pick');
  expect(ok[0].url).toBe('/__ext/pr/index.html');

  // No permission → nothing. A mode that can pick but not start is worse than
  // an absent one: the human finds out at the last click.
  expect(ext.extLauncherItems([mk({ tabs, permissions: [] })])).toEqual([]);
  // Disabled → nothing.
  expect(ext.extLauncherItems([mk({ tabs, permissions: ['host:create-session'], enabled: false })])).toEqual([]);
});

test('the browser SDK exposes every method the bridge implements', async () => {
  // The gap this closes, found by actually clicking the button and not by any
  // of the tests above: `createSession` was added to the bridge (the shell half)
  // and to the types, and NOT to sdk/browser/ext-sdk.js — the file that defines
  // `window.arigami`. Every test here drives the bridge directly, so all of them
  // passed while the page itself got "arigami.createSession is not a function".
  const fs = await import('node:fs');
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'web/src/lib/ext-bridge.js'), 'utf8');
  const shimSrc = fs.readFileSync(path.join(ROOT, 'sdk/browser/ext-sdk.js'), 'utf8');

  const handled = [...bridgeSrc.matchAll(/^\s*case '([a-zA-Z]+)':/gm)].map((m) => m[1]);
  // `unsubscribe` rides on the object subscribe() returns, not as its own
  // method; everything else is called by name from a page.
  const expected = [...new Set(handled)].filter((m) => m !== 'unsubscribe');
  expect(expected.length).toBeGreaterThan(4);
  for (const m of expected)
    expect(shimSrc).toContain(`${m}: function`);
});

test('permissionsFor: createSession asks for host:create-session', () => {
  expect(ext.permissionsFor('createSession')).toEqual(['host:create-session']);
});

test('bridge: a message from another window is ignored entirely', async () => {
  const t = harness();
  await t.bridge.onMessage({ source: { other: true }, data: { type: 'arigami:call', id: 'c1', method: 'sendPrompt', args: { text: 'x', mode: 'now' } } });
  await t.bridge.onMessage({ source: null, data: { type: 'arigami:hello' } });
  expect(t.calls).toEqual([]);
  expect(t.posted).toEqual([]);
});

test('bridge: hello → init with the tab context; a load can init again', async () => {
  const t = harness();
  await t.send({ type: 'arigami:hello', v: 1 });
  expect(t.posted[0].type).toBe('arigami:init');
  expect(t.posted[0].v).toBe(1);
  expect(t.posted[0].context.sessionId).toBe('s1');
  expect(t.posted[0].context.extension).toBe('hello');
  t.bridge.sendInit();
  expect(t.posted).toHaveLength(2);
});

test('bridge: sendPrompt "now" posts a message, "queue" posts a prompt', async () => {
  const t = harness();
  await t.send({ type: 'arigami:call', id: 'c1', method: 'sendPrompt', args: { text: 'hi', mode: 'now' } });
  expect(t.calls[0]).toEqual(['POST', '/sessions/s1/message', { text: 'hi' }]);
  expect(t.posted[0]).toEqual({ type: 'arigami:result', v: 1, id: 'c1', ok: true, value: { delivered: 'now' } });

  await t.send({ type: 'arigami:call', id: 'c2', method: 'sendPrompt', args: { text: 'later', mode: 'queue' } });
  expect(t.calls[1]).toEqual(['POST', '/sessions/s1/prompts', { text: 'later' }]);
  expect(t.posted[1].value).toEqual({ delivered: 'queued' });

  // empty text is refused before any REST call
  await t.send({ type: 'arigami:call', id: 'c3', method: 'sendPrompt', args: { text: '   ', mode: 'now' } });
  expect(t.calls).toHaveLength(2);
  expect(t.posted[2]).toMatchObject({ ok: false, error: 'text required' });
});

test('bridge: sendPrompt default mode is "auto" — idle delivers now', async () => {
  const t = harness({ sessionState: 'idle' });
  await t.send({ type: 'arigami:call', id: 'c1', method: 'sendPrompt', args: { text: 'go' } });
  expect(t.calls).toEqual([['POST', '/sessions/s1/message', { text: 'go' }]]);
  expect(t.posted[0].value).toEqual({ delivered: 'now' });

  // an explicit 'auto' is the same thing
  await t.send({ type: 'arigami:call', id: 'c2', method: 'sendPrompt', args: { text: 'go2', mode: 'auto' } });
  expect(t.calls[1]).toEqual(['POST', '/sessions/s1/message', { text: 'go2' }]);
  expect(t.posted[1].value).toEqual({ delivered: 'now' });
});

test('bridge: "auto" on a busy session queues AND turns auto-play on', async () => {
  const t = harness({ sessionState: 'working' });
  await t.send({ type: 'arigami:call', id: 'c1', method: 'sendPrompt', args: { text: 'later' } });
  expect(t.calls).toEqual([
    ['POST', '/sessions/s1/prompts', { text: 'later' }],
    ['POST', '/sessions/s1/prompts/autoplay', { on: true }],
  ]);
  expect(t.posted[0].value).toEqual({ delivered: 'queued' });

  // anything that is not 'idle' is busy — awaiting-input included.
  const t2 = harness({ sessionState: 'awaiting-input' });
  await t2.send({ type: 'arigami:call', id: 'c1', method: 'sendPrompt', args: { text: 'x', mode: 'auto' } });
  expect(t2.calls[1]).toEqual(['POST', '/sessions/s1/prompts/autoplay', { on: true }]);
});

test('bridge: explicit "queue" keeps its old meaning — no auto-play, even when idle', async () => {
  const t = harness({ sessionState: 'idle' });
  await t.send({ type: 'arigami:call', id: 'c1', method: 'sendPrompt', args: { text: 'wait for me', mode: 'queue' } });
  expect(t.calls).toEqual([['POST', '/sessions/s1/prompts', { text: 'wait for me' }]]);
  expect(t.posted[0].value).toEqual({ delivered: 'queued' });
});

test('bridge: "auto" without session:message queues instead of promoting itself', async () => {
  const t = harness({ permissions: ['session:prompts'], sessionState: 'idle' });
  await t.send({ type: 'arigami:call', id: 'c1', method: 'sendPrompt', args: { text: 'hi' } });
  expect(t.calls).toEqual([
    ['POST', '/sessions/s1/prompts', { text: 'hi' }],
    ['POST', '/sessions/s1/prompts/autoplay', { on: true }],
  ]);
  expect(t.posted[0].value).toEqual({ delivered: 'queued' });
});

test('bridge: a missing permission denies BEFORE the REST call, and names the permission', async () => {
  const t = harness({ permissions: ['session:prompts'] });
  await t.send({ type: 'arigami:call', id: 'c1', method: 'sendPrompt', args: { text: 'x', mode: 'now' } });
  expect(t.posted[0]).toEqual({ type: 'arigami:result', v: 1, id: 'c1', ok: false, error: 'permission denied: session:message' });
  await t.send({ type: 'arigami:call', id: 'c2', method: 'setStatus', args: { badge: '✓' } });
  expect(t.posted[1].error).toBe('permission denied: session:tabs');
  await t.send({ type: 'arigami:call', id: 'c3', method: 'runTool', args: { name: 'rm_rf' } });
  expect(t.posted[2].error).toBe('permission denied: tools:rm_rf');
  // …but the queue IS allowed by session:prompts
  await t.send({ type: 'arigami:call', id: 'c4', method: 'sendPrompt', args: { text: 'q', mode: 'queue' } });
  expect(t.posted[3].ok).toBe(true);
  expect(t.calls).toEqual([['POST', '/sessions/s1/prompts', { text: 'q' }]]);
});

test('bridge: an unknown method is refused, not guessed at', async () => {
  const t = harness();
  await t.send({ type: 'arigami:call', id: 'c1', method: 'deleteSession', args: { id: 's2' } });
  expect(t.posted[0]).toMatchObject({ ok: false, error: 'unknown method: deleteSession' });
  expect(t.calls).toEqual([]);
});

test('bridge: runTool is scoped to THIS extension and unwraps the result', async () => {
  const t = harness();
  await t.send({ type: 'arigami:call', id: 'c1', method: 'runTool', args: { name: 'hello_echo', args: { text: 'x' } } });
  expect(t.calls[0]).toEqual(['POST', '/ext/hello/tool/hello_echo', { args: { text: 'x' } }]);
  expect(t.posted[0].ok).toBe(true);
  expect(t.posted[0].value).toEqual({ echoed: { args: { text: 'x' } } });
});

test('bridge: setStatus patches only THIS tab; openArtifact refuses a non-host path', async () => {
  const t = harness();
  await t.send({ type: 'arigami:call', id: 'c1', method: 'setStatus', args: { badge: '✓', color: '#111', title: 'T', url: '/evil' } });
  expect(t.calls[0]).toEqual(['PATCH', '/sessions/s1/tabs/tab_1', { badge: '✓', color: '#111', title: 'T' }]);

  await t.send({ type: 'arigami:call', id: 'c2', method: 'openArtifact', args: { path: '/__artifacts/a1/', title: 'A' } });
  expect(t.calls[1]).toEqual(['POST', '/sessions/s1/tabs', { type: 'url', url: '/__artifacts/a1/', title: 'A' }]);

  await t.send({ type: 'arigami:call', id: 'c3', method: 'openArtifact', args: { path: 'https://evil.example/' } });
  expect(t.calls).toHaveLength(2);
  expect(t.posted[2]).toMatchObject({ ok: false });
  expect(t.posted[2].error).toContain('host-relative');
});

test('bridge: close deletes the tab, and only with session:tabs', async () => {
  const t = harness();
  await t.send({ type: 'arigami:close', v: 1 });
  expect(t.calls[0]).toEqual(['DELETE', '/sessions/s1/tabs/tab_1']);
  const denied = harness({ permissions: [] });
  await denied.send({ type: 'arigami:close', v: 1 });
  expect(denied.calls).toEqual([]);
});

test('bridge: subscribe needs events:<glob>, and only forwards THIS session', async () => {
  const t = harness();
  expect(t.hasWire()).toBe(false);
  await t.send({ type: 'arigami:call', id: 'c1', method: 'subscribe', args: { events: ['chat'] } });
  expect(t.posted[0].ok).toBe(true);
  expect(t.hasWire()).toBe(true);

  t.wire({ type: 'chat:s1', event: { kind: 'result', text: 'done' } });
  expect(t.posted[1]).toEqual({ type: 'arigami:event', v: 1, name: 'chat', payload: { kind: 'result', text: 'done' } });

  // another session's chat, and an event nobody subscribed to: both dropped
  t.wire({ type: 'chat:s2', event: { kind: 'result' } });
  t.wire({ type: 'session-updated', session: { id: 's1' } });
  t.wire({ type: 'tab-updated', sessionId: 's1' });
  expect(t.posted).toHaveLength(2);

  // unsubscribe drops the wire tap again
  await t.send({ type: 'arigami:call', id: 'c2', method: 'unsubscribe', args: { events: ['chat'] } });
  expect(t.hasWire()).toBe(false);
});

test('bridge: an event the manifest does not permit is refused at subscribe time', async () => {
  const t = harness();
  await t.send({ type: 'arigami:call', id: 'c1', method: 'subscribe', args: { events: ['chat', 'session-updated'] } });
  expect(t.posted[0]).toMatchObject({ ok: false, error: 'permission denied: events:session-updated' });
  expect(t.hasWire()).toBe(false);
  // and nothing leaks even if the wire fires
  t.wire({ type: 'session-updated', session: { id: 's1' } });
  expect(t.posted).toHaveLength(1);
});

test('bridge: a permission revoked after subscribe stops delivery immediately', async () => {
  let perms = ['events:chat'];
  const posted = [];
  let wireFn = null;
  const win = {};
  const b = bridgeMod.createExtBridge({
    sessionId: 's1', tabId: 'tab_1', extension: 'hello',
    getWindow: () => win,
    getPermissions: () => perms,
    getContext: () => ({}),
    post: (m) => posted.push(m),
    api: { post: async () => ({}), patch: async () => ({}), del: async () => ({}), get: async () => ({}) },
    subscribeWire: (fn) => { wireFn = fn; return () => { wireFn = null; }; },
  });
  await b.onMessage({ source: win, data: { type: 'arigami:call', id: 'c1', method: 'subscribe', args: { events: ['chat'] } } });
  wireFn({ type: 'chat:s1', event: { kind: 'user' } });
  expect(posted).toHaveLength(2);
  perms = []; // a reload narrowed the manifest
  wireFn({ type: 'chat:s1', event: { kind: 'user' } });
  expect(posted).toHaveLength(2);
});

test('bridge: dispose stops everything', async () => {
  const t = harness();
  await t.send({ type: 'arigami:call', id: 'c1', method: 'subscribe', args: { events: ['chat'] } });
  t.bridge.dispose();
  expect(t.hasWire()).toBe(false);
  await t.send({ type: 'arigami:call', id: 'c2', method: 'sendPrompt', args: { text: 'x', mode: 'now' } });
  expect(t.calls).toEqual([]);
});

/* ---------- Settings ------------------------------------------------------ */

test('Settings: "extensions" is the fourth nav page and a valid route id', () => {
  expect(SettingsMod.SETTINGS_NAV).toEqual(['appearance', 'connections', 'host', 'extensions']);
  expect(SettingsMod.SETTINGS_CATEGORIES).toContain('extensions');
  expect(SettingsMod.resolveCategory('extensions')).toEqual({ cat: 'extensions', section: '' });
});

test('Settings › Extensions: the page shell offers Reload, Add and an empty state', () => {
  const html = render(h(ExtensionsPage));
  expect(html).toContain('Extensions');
  expect(html).toContain('Add an extension');
  expect(html).toContain('Reload');
  expect(html).toContain('No extension installed');
});

test('the extension card shows state, version, sha, contributions, permissions and the settings form', () => {
  const html = render(h(ExtensionCard, { ext: HELLO }));
  expect(html).toContain('Hello');
  expect(html).toContain('Active');            // state pill
  expect(html).toContain('v0.1.0');
  expect(html).toContain('abcdef1');           // short sha, not the whole thing
  expect(html).not.toContain('abcdef1234567890');
  expect(html).toContain('1 tools');           // contributions
  expect(html).toContain('1 listeners');
  expect(html).toContain('Send messages to the session');
  expect(html).toContain('session:message');   // the raw id is shown too
  expect(html).toContain('Greeting');          // settings form, from settings.schema
  expect(html).toContain('Loud');
  expect(html).toContain('daemons[]');         // warnings
  expect(html).toContain('Remove');
});

test('a disabled / broken extension says so instead of pretending to be fine', () => {
  const off = render(h(ExtensionCard, { ext: { ...HELLO, enabled: false, state: 'disabled' } }));
  expect(off).toContain('Off');
  const broken = render(h(ExtensionCard, { ext: { ...HELLO, state: 'error', error: 'manifest.json: bad json' } }));
  expect(broken).toContain('Error');
  expect(broken).toContain('manifest.json: bad json');
});

test('the extension card shows every permission as a sentence AND as its raw id', async () => {
  const { permissionLabel } = await import(web('components/settings/Extensions.jsx'));
  const t = (await import(web('lib/i18n.js'))).t;
  expect(permissionLabel(t, 'session:message')).toBe('Send messages to the session');
  expect(permissionLabel(t, 'session:tabs')).toBe('Open, update and close tabs');
  expect(permissionLabel(t, 'tools:hello_echo')).toContain('hello_echo');
  expect(permissionLabel(t, 'events:merge.*')).toContain('merge.*');
  expect(permissionLabel(t, 'nonsense')).toContain('grants nothing');
});

/* ---------- ChatPane ext-card --------------------------------------------- */

test('ext-card renders title, markdown body and prompt buttons', () => {
  const events = [{ kind: 'ext-card', ts: 1, extension: 'hello', title: 'Pick one', body: '**bold**', buttons: [{ label: 'Yes', prompt: 'do it' }] }];
  const html = render(h(ChatPane, { sessionId: 's1', events, mode: 'full' }));
  expect(html).toContain('Pick one');
  expect(html).toContain('<strong>bold</strong>');
  expect(html).toContain('Yes');
  expect(html).toContain('hello');
});

test('ext-card degrades: missing fields, bad buttons, and a wholly empty card', () => {
  const only = render(h(ChatPane, { sessionId: 's1', events: [{ kind: 'ext-card', ts: 1, title: 'Just a title' }], mode: 'full' }));
  expect(only).toContain('Just a title');

  const bad = render(h(ChatPane, { sessionId: 's1', events: [{ kind: 'ext-card', ts: 1, body: 'x', buttons: [{ label: 'ok' }, 'nope', { prompt: 'p' }, { label: 'Go', prompt: 'go' }] }], mode: 'full' }));
  expect(bad).toContain('Go');
  expect(bad).not.toContain('>ok<');

  const empty = render(h(ChatPane, { sessionId: 's1', events: [{ kind: 'ext-card', ts: 1 }], mode: 'full' }));
  expect(empty).not.toContain('data-ext-card');
});

/* ---------- composer ------------------------------------------------------ */

test('composer: a manifest slash opens the tab; skills still win the name', () => {
  const r = composer.resolveSubmission('/hi', { extensions: [HELLO] });
  expect(r).toEqual({ type: 'ext-tab', ext: 'hello', tab: 'hello', title: 'Hello' });
  // no extensions → an ordinary pass-through to the CLI
  expect(composer.resolveSubmission('/hi', {})).toEqual({ type: 'plain', text: '/hi' });
  // a skill with the same slash keeps it
  const skills = [{ name: 'hi-skill', slash: 'hi', source: 'user', description: 'd' }];
  expect(composer.resolveSubmission('/hi', { skills, extensions: [HELLO] }).type).toBe('skill');
  // a disabled extension contributes no command
  expect(composer.resolveSubmission('/hi', { extensions: [{ ...HELLO, enabled: false }] })).toEqual({ type: 'plain', text: '/hi' });
});

test('TabBar still exports its default component with the extension rows compiled in', () => {
  expect(typeof TabBarMod.default).toBe('function');
});
