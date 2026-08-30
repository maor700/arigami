// M1 web: the native remote-MCP section renders one card per catalog service
// above the Composio grid, shows the grant name and its tool pattern once
// connected, refuses to offer a BYO-client vendor, and the 'mcp' OAuth flow
// offers both ways to finish (the loopback poll and the pasted redirect URL).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, NativeMcp, OAuthCodeStep, registry, origFetch;
const h = (...a) => React.createElement(...a);
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
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  ({ default: NativeMcp } = await import(web('components/settings/NativeMcp.jsx')));
  ({ default: OAuthCodeStep } = await import(web('components/setup/OAuthCodeStep.jsx')));
  registry = await import(web('components/setup/registry.js'));
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

const CAPS = [
  {
    id: 'mcp:linear', title: 'Linear', provider: 'native-mcp', ok: true, owner: 'agent:sales', resolvedFrom: 'agent:sales',
    data: { name: 'linear--sales', auth: 'oauth', tools: 'mcp__linear--sales__*', docs: 'https://linear.app/docs/mcp' },
  },
  {
    id: 'mcp:github', title: 'GitHub', provider: 'native-mcp', ok: false, owner: 'global', resolvedFrom: null,
    data: { name: 'github', auth: 'bearer', tools: 'mcp__github__*', docs: 'https://docs.github.com/x', note: 'token-based: the host reuses `gh auth token`' },
  },
  {
    id: 'mcp:asana', title: 'Asana', provider: 'native-mcp', ok: false, owner: 'global', resolvedFrom: null,
    data: { auth: 'oauth-byo-client', docs: 'https://developers.asana.com/x' },
  },
];

test('the registry knows the mcp family, its playbook and its provider', () => {
  expect(registry.capFamily('mcp:linear')).toBe('mcp');
  expect(registry.capArg('mcp:linear')).toBe('linear');
  expect(registry.manualFor('mcp:linear')).toEqual({ manual: { kind: 'oauth', flow: 'mcp', token: false }, autoCapable: true, playbook: 'connect-mcp' });
  expect(registry.providerOf('mcp:linear')).toBe('native-mcp');
  expect(registry.providerOf('composio:gmail')).toBe('composio');
  expect(registry.providerOf('whatsapp')).toBe('local');
  // The consent list the dialog shows before an auto connect must exist.
  expect(registry.consentKeys('mcp:linear')).toHaveLength(4);
});

test('NativeMcp: a card per service, the grant name + tool pattern when connected, BYO disabled', () => {
  const html = render(h(NativeMcp, { caps: CAPS, busy: false, onOpen: noop, onDisconnect: noop, audit: [], ownerName: () => 'Sales' }));
  expect(html).toContain('data-mcp-card="mcp:linear"');
  expect(html).toContain('data-mcp-card="mcp:github"');
  // Connected: the human sees WHICH grant this is and what an agent allowlist needs.
  expect(html).toContain('linear--sales');
  expect(html).toContain('mcp__linear--sales__*');
  expect(html).toContain('Disconnect');
  // Not connected: the catalog note is the hint, and the vendor's docs are linked.
  expect(html).toContain('token-based');
  expect(html).toContain('https://linear.app/docs/mcp');
  // A vendor without dynamic client registration cannot be connected from here.
  const asana = html.slice(html.indexOf('data-mcp-card="mcp:asana"'));
  expect(asana).toContain('disabled');
  expect(asana).toContain('own app');
});

test('NativeMcp: an old host that reports no native services says so instead of rendering an empty grid', () => {
  const html = render(h(NativeMcp, { caps: [], busy: false, onOpen: noop, onDisconnect: noop }));
  expect(html).toContain('older Arigami');
});

test("the 'mcp' OAuth flow offers the vendor link and the paste-the-redirect-URL path", () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(OAuthCodeStep, { capability: 'mcp:linear', manual: { kind: 'oauth', flow: 'mcp', token: false }, onDone: noop }));
  expect(html).toContain('Open the vendor consent page');
  // `manual.token:false` — there is no token to paste for an OAuth vendor.
  expect(html).not.toContain('Paste a token');
  prefs.setPrefs({ language: 'he' });
  const he = render(h(OAuthCodeStep, { capability: 'mcp:linear', manual: { kind: 'oauth', flow: 'mcp', token: false }, onDone: noop }));
  expect(he).toContain('פתח את מסך ההסכמה של השירות');
  prefs.setPrefs({ language: 'en' });
});
