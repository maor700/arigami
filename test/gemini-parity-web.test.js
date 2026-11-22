// Gemini as a first-class peer in the cockpit: setup cards, wizard step, sign-in panel, usage tab — the places that used to know two engines.
import { test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
const src = (p) => fs.readFileSync(web(p), 'utf8');

const ACCOUNTS = {
  activeId: 'acc_c',
  activeIds: { claude: 'acc_c', gemini: 'acc_g' },
  accounts: [
    { id: 'acc_c', label: 'Work', provider: 'claude', type: 'oauth-token', pool: true, active: true, available: true, lastUsage: { session: 40, week: 10, at: 1 } },
    { id: 'acc_g', label: 'Default (Gemini login)', provider: 'gemini', type: 'gemini-home', pool: true, active: true, available: true, email: 'someone@example.com', plan: 'Google AI Pro', lastUsage: { session: 3, week: null, sessionMins: 300, at: 1 } },
  ],
};

let React, render, prefs, store, registry, EngineConnectMod, OAuthCodeStep, SlashCommands, AccountsMod;
const h = (...a) => React.createElement(...a);

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
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => (String(url).endsWith('/accounts') ? ACCOUNTS : {}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  prefs.setPrefs({ language: 'en' });
  store = await import(web('lib/store.js'));
  registry = await import(web('components/setup/registry.js'));
  EngineConnectMod = await import(web('components/setup/EngineConnect.jsx'));
  ({ default: OAuthCodeStep } = await import(web('components/setup/OAuthCodeStep.jsx')));
  SlashCommands = await import(web('components/SlashCommands.jsx'));
  AccountsMod = await import(web('components/settings/Accounts.jsx'));
  await store.loadAccounts();
});

test('setup registry: gemini is an OAuth capability with its own flow and playbook, and no pasted secret', async () => {
  expect(registry.manualFor('gemini')).toEqual({ manual: { kind: 'oauth', flow: 'gemini', token: false }, autoCapable: true, playbook: 'connect-gemini' });
  expect(registry.AUTO_CAPABLE).toContain('gemini');
  const { t } = await import(web('lib/i18n.js'));
  expect(registry.capTitle(t, 'gemini')).toBe('Gemini');
  const keys = registry.consentKeys('gemini');
  expect(keys).toEqual([1, 2, 3, 4].map((n) => `setup.consent.connect-gemini.${n}`));
  for (const lang of ['en', 'he']) for (const k of keys) expect(src(`locales/${lang}/setup.js`)).toContain(`'${k}'`);
  expect(src('lib/setup-api.js')).toMatch(/push\('gemini', step\('gemini'\)\?\.status === 'ok'/);
});

test('engine cards: three equal cards; any one connected lifts the gate; a connected peer is named on the others', () => {
  const { ENGINE_SPECS, ENGINE_CAP_IDS, anyEngineConnected, enginesFrom } = EngineConnectMod;
  expect(ENGINE_CAP_IDS).toEqual(['claude', 'codex', 'gemini']);
  expect(ENGINE_SPECS.find((e) => e.id === 'gemini')).toMatchObject({ flow: 'gemini', token: false });
  expect(anyEngineConnected({ gemini: { ok: true } })).toBe(true);
  expect(anyEngineConnected({ claude: { ok: false }, codex: null, gemini: { ok: false } })).toBe(false);
  expect(enginesFrom({ capabilities: [{ id: 'gemini', ok: true }, { id: 'git', ok: true }] })).toEqual({ claude: null, codex: null, gemini: { id: 'gemini', ok: true } });

  const engines = { claude: { ok: false, data: { cli: true } }, codex: { ok: false, data: { cli: true } }, gemini: { ok: true, data: { cli: true } } };
  const html = render(h(EngineConnectMod.default, { engines }));
  expect((html.match(/data-engine="/g) || []).length).toBe(3);
  expect(html).toMatch(/data-engine="gemini" data-connected="true"/);
  expect(html).toContain('Gemini is connected');
  expect(html).toContain('Connect Claude');
  expect((html.match(/You already have Gemini/g) || []).length).toBe(2); // on the claude and codex cards
  expect(html).toContain('xl:grid-cols-3'); // one per row on a phone, two from sm, three on a wide screen

  // not connected: the gemini card has its own three steps and one button; no "paste a token" (there is none)
  const fresh = render(h(EngineConnectMod.default, { engines: { claude: null, codex: null, gemini: { ok: false, data: { cli: true } } } }));
  const card = fresh.slice(fresh.indexOf('data-engine="gemini"'));
  expect(card).toContain('Sign in with Google in the window that opens');
  expect(card).toContain('Connect Gemini');
  expect(card).not.toContain('Paste a token');
  // no CLI: the install pointer, not a sign-in button
  const noCli = render(h(EngineConnectMod.default, { engines: { claude: null, codex: null, gemini: { ok: false, data: { cli: false } } } }));
  const missing = noCli.slice(noCli.indexOf('data-engine="gemini"'));
  expect(missing).toContain('Antigravity CLI (agy) is not installed');
  expect(missing).toContain('href="https://antigravity.google/docs/getting-started.md"');
});

test('OAuth step, flow gemini: a Google sign-in button, and the pasted code is not the end (the card keeps polling)', () => {
  const html = render(h(OAuthCodeStep, { capability: 'gemini', manual: { kind: 'oauth', flow: 'gemini', token: false } }));
  expect(html).toContain('Sign in with Google');
  expect(html).not.toContain('Paste a token');
  const code = src('components/setup/OAuthCodeStep.jsx');
  expect(code).toMatch(/const pasteBack = flow === 'pkce' \|\| flow === 'mcp' \|\| flow === 'codex' \|\| flow === 'gemini';/);
  expect(code).toMatch(/const keepPolling = loopback \|\| flow === 'gemini';/);
  expect(code).toMatch(/if \(keepPolling\) return;/);
  expect(code).toMatch(/flow === 'gemini' \? 'setup\.oauth\.geminiHint'/);
});

test('wizard, Setup, first run and the chat card treat the three engines as one "connect an engine" step', () => {
  const wiz = src('components/Wizard.jsx');
  expect(wiz).toMatch(/const ENGINE_STEPS = new Set\(ENGINE_CAP_IDS\);/);
  expect(wiz).toMatch(/rawSteps\.some\(\(s\) => ENGINE_STEPS\.has\(s\.id\) && s\.status === 'ok'\)/);
  expect(wiz).toMatch(/\.filter\(\(s\) => s\.id === 'claude' \|\| !ENGINE_STEPS\.has\(s\.id\)\)/);
  expect(wiz).toMatch(/ENGINE_STEPS\.has\(view\?\.current\) \? 'claude' : view\?\.current/);
  expect(src('components/Setup.jsx')).toMatch(/setEngines\(enginesFrom\(ov\)\)/);
  expect(src('components/FirstRun.jsx')).toMatch(/anyEngineConnected\(enginesFrom\(ov\)\)/);
  const card = src('components/setup/SetupCard.jsx');
  expect(card).toMatch(/const isEngine = ENGINE_CAP_IDS\.includes\(capFamily\(capability\)\);/);
  expect(card).toMatch(/engineDone && isEngine && engineDone !== capability/);
  expect(card).toMatch(/engine: engineDone, permissionMode/);
  for (const lang of ['en', 'he']) {
    const s = src(`locales/${lang}/setup.js`);
    expect(s).toMatch(/'setup\.engine\.switched': '[^']*\{name\}[^']*\{from\}/);
    expect(s).not.toContain("'setup.engine.newCodex'");
  }
});

test('the usage tab exists on every engine and shows the session\'s own provider: the Gemini 5-hour bucket and plan tier', () => {
  const panel = (session) => render(h(SlashCommands.CapabilitiesPanel, { capabilities: {}, session, initialTab: 'usage', onClose() {} }));
  const gem = panel({ id: 's1', title: 'g', engine: 'gemini', claude: { state: 'idle', sessionId: 'x' } });
  expect(gem).toContain('This session runs on');
  expect(gem).toContain('Default (Gemini login)');
  expect(gem).toContain('Google AI Pro');
  expect(gem).toContain('5-hour window');
  expect(gem).toContain('97%'); // 3% used → 97% left
  expect(gem).not.toContain('Work'); // the claude account is not this session's business
  // a claude session keeps its own view (and the tab no longer throws on its undefined provider/activeId)
  const cl = panel({ id: 's2', title: 'c', claude: { state: 'idle' } });
  expect(cl).toContain('Work');
  expect(cl).toContain('60%');
  expect(cl).not.toContain('Gemini login');
});

test('Accounts: Gemini signs in through the browser panel, and a dead login offers "Sign in again"', () => {
  const { canSignInAgain } = AccountsMod;
  const P = { localType: 'gemini-home', methods: [{ id: 'browser', type: 'gemini-home' }] };
  const acc = { type: 'gemini-home', provider: 'gemini' };
  expect(canSignInAgain(acc, { available: false, reason: 'http-401' }, P)).toBe(true);
  expect(canSignInAgain(acc, { available: false, reason: 'no-credentials' }, P)).toBe(true);
  expect(canSignInAgain(acc, { available: false, reason: 'token-expired' }, P)).toBe(false); // agy renews that itself
  expect(canSignInAgain(acc, { available: true, session: { pct: 1 } }, P)).toBe(false);
  expect(canSignInAgain(acc, null, P)).toBe(false);
  // codex's browser sign-in adds ANOTHER account — it cannot renew the machine's codex-home login
  expect(canSignInAgain({ type: 'codex-home' }, { available: false, reason: 'http-401' }, { localType: 'codex-home', methods: [{ id: 'browser', type: 'chatgpt' }] })).toBe(false);

  const code = src('components/settings/Accounts.jsx');
  expect(code).toMatch(/gemini: \{ starting: 'geminiStarting'/);
  expect(code).toMatch(/data-login-flow=\{auth\.provider\}/);
  expect(code).toMatch(/onSignIn=\{\(prov\) => startAuth\(prov\)\}/);
  for (const lang of ['en', 'he']) for (const k of ['geminiBrowser', 'geminiAddBody', 'geminiStep1', 'geminiStep1b', 'geminiStep2', 'geminiCodePlaceholder', 'geminiStarting', 'geminiVerifying', 'geminiDone', 'signInAgain']) {
    expect(src(`locales/${lang}/launcher.js`)).toContain(`'launcher.account.${k}'`);
  }
});

test('the small ones: Instructions preview, Connections section, search, style guide, the claude-only restart note', () => {
  expect(src('components/settings/Instructions.jsx')).toMatch(/options=\{engineOptions\(\)\.map/);
  expect(src('components/settings/Connections.jsx')).toMatch(/OWN_SECTION = new Set\(\[[^\]]*'gemini'/);
  expect(src('components/settings/Find.jsx')).toMatch(/gemini agy google/);
  expect(src('components/StyleGuide.jsx')).toContain('<DropdownMenuRadioItem value="gemini">Gemini</DropdownMenuRadioItem>');
  expect(src('components/ContextModal.jsx')).toMatch(/isClaudeEngine\(session\.engine\) && <div[^>]*>\{t\('dialogs\.ctxAutoCompactRestartNote'\)\}/);
});
