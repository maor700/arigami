// OPENUI phase 2 — host cards on the OpenUI library.
//   · every host card is a defineComponent'd library entry (define.js registry)
//     and ChatPane renders host events through HostCard (event → props)
//   · the agent-facing library + prompt never contain a host-only component,
//     and a render_ui block naming one falls back — no forged permission /
//     merge / setup / screen / action cards
//   · each fixture event satisfies its card's zod schema and renders with the
//     same data-* markers the older tests assert on
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, ChatPane, host, hostLib, lib, define, fixtures, openuiProblem;
const h = (...a) => React.createElement(...a);
let origFetch;

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '', search: '' };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}', headers: { get: () => 'application/json' } });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  ({ default: ChatPane } = await import(web('components/ChatPane.jsx')));
  host = await import(web('openui/host.jsx'));
  hostLib = await host.getHostLibrary();
  lib = await import(web('openui/library.jsx'));
  define = await import(web('openui/define.js'));
  fixtures = await import(web('openui/host-fixtures.js'));
  ({ openuiProblem } = await import(web('components/OpenUIBody.jsx')));
});
afterAll(() => { if (origFetch) globalThis.fetch = origFetch; });

// kind → [host component name, extra props builder]
const CARDS = {
  'ext-card': 'ExtCard',
};
const fx = (kind) => fixtures.HOST_EVENTS.filter((e) => e.kind === kind);
const pane = (events, extra = {}) => render(h(ChatPane, { sessionId: 's1', events, mode: 'full', ...extra }));

test('registry: every migrated card is a host-only library component; the agent library has none of them', () => {
  const names = define.HOST_COMPONENTS.map((d) => d.name);
  for (const n of Object.values(CARDS)) expect(names).toContain(n);
  for (const n of names) {
    expect(host.isHostOnly(n)).toBe(true);
    expect(hostLib.components[n]?.hostOnly).toBe(true); // a real react-lang DefinedComponent in the materialized library
    expect(hostLib.components[n].ref).toBeTruthy();
    expect(lib.library.components[n]).toBeUndefined();
    expect(lib.openuiPrompt()).not.toMatch(new RegExp(`^${n}\\(`, 'm'));
  }
  // the host library still carries the whole agent set (one library, two views)
  for (const n of Object.keys(lib.library.components)) expect(hostLib.components[n]).toBeTruthy();
  // and its own prompt lists the host cards — what a host-side generator would see
  expect(hostLib.prompt()).toContain('ExtCard(');
});

test('forgery guard: a render_ui block naming a host card is refused, not rendered', () => {
  for (const n of define.HOST_COMPONENTS.map((d) => d.name)) {
    expect(openuiProblem(`root = Stack([x])\nx = ${n}("s1", {})`)).toBe(`unknown-component:${n}`);
  }
  // the agent path only ever sees the agent library: HostCard refuses agent-side names too
  expect(render(h(host.HostCard, { name: 'Stat', props: { label: 'a', value: '1' } }))).toBe('');
  expect(render(h(host.HostCard, { name: 'Nope', props: {} }))).toBe('');
});

test('schemas: every fixture event of a migrated kind satisfies its card schema (loose: unknown keys pass)', () => {
  for (const [kind, name] of Object.entries(CARDS)) {
    const def = hostLib.components[name];
    for (const event of fx(kind)) {
      const r = def.props.safeParse({ sessionId: 's1', event: { ...event, extra_field_from_a_newer_host: 1 } });
      expect(r.success).toBe(true);
      expect(r.data.event.extra_field_from_a_newer_host).toBe(1);
    }
  }
});

test('ext-card: renders through HostCard with the same markers, body markdown and buttons; degrades on junk', () => {
  const html = pane(fx('ext-card'));
  expect(html).toContain('data-ext-card="hello"');
  expect(html).toContain('<strong>compare</strong>');
  expect(html).toContain('Re-run');
  const empty = pane([{ kind: 'ext-card', ts: 1 }]);
  expect(empty).not.toContain('data-ext-card');
  const junk = pane([{ kind: 'ext-card', ts: 1, title: 42, buttons: 'nope', body: { x: 1 } }]);
  expect(junk).not.toContain('data-ext-card');
});
