// The cockpit must call a session's engine by ITS name.
//
// The rule under test (docs/ENGINES.md, "the rule for UI text"): a string that
// describes the ENGINE — who is working, who wants the screen, whose
// capabilities these are, what you are replying to — follows `session.engine`.
// A string that describes ARIGAMI, or that genuinely describes the Claude Code
// CLI itself (its install, its keychain item, its subscription usage), keeps
// saying Claude. That is why the locales carry `{engine}` placeholders instead
// of having been search-and-replaced.
//
// A Codex session that introduces itself as "claude-code" in its own terminal
// header, or asks the human to "Reply to Claude Code…", is the single most
// visible way the second engine leaks the first one's identity.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, store, engines, SessionView, ChatPane, SlashCommands, origFetch;
const h = (...a) => React.createElement(...a);

const base = (id, engine) => ({
  id,
  title: id,
  color: '#1F9C82',
  cwd: '/tmp',
  ...(engine ? { engine } : {}),
  claude: { state: 'idle' },
  tabs: [{ id: 't1', type: 'session', title: 'Session' }],
  activeTabId: 't1',
});

const SESSIONS = [
  base('sess_claude'), // no `engine` field at all — every pre-existing session
  base('sess_codex', 'codex'),
];

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
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200, url: String(url),
    json: async () => (String(url).includes('/sessions') ? SESSIONS : {}),
    text: async () => '',
  });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  engines = await import(web('lib/engines.js'));
  store = await import(web('lib/store.js'));
  ({ default: SessionView } = await import(web('components/SessionView.jsx')));
  ({ default: ChatPane } = await import(web('components/ChatPane.jsx')));
  SlashCommands = await import(web('components/SlashCommands.jsx'));
  await store.loadSessions();
});

afterAll(() => {
  globalThis.fetch = origFetch;
  prefs.setPrefs({ language: 'en' });
});

const viewOf = (session) =>
  render(h(SessionView, { session, events: [], chatLoading: false, addTabOpen: false, setAddTabOpen() {}, onOpenSession() {} }));

/* ---------- the namers themselves ----------------------------------------- */

test('engineLabel/engineTermName: unknown, empty and missing all mean claude', () => {
  expect(engines.engineLabel('codex')).toBe('Codex');
  expect(engines.engineTermName('codex')).toBe('codex');
  for (const v of ['claude', '', null, undefined, 'gpt']) {
    expect(engines.engineLabel(v)).toBe('Claude Code');
    expect(engines.engineTermName(v)).toBe('claude-code');
  }
});

/* ---------- the terminal header ------------------------------------------- */

test('the terminal header wears the session\'s OWN engine, and a legacy session still says claude-code', () => {
  expect(viewOf(SESSIONS[1])).toContain('>codex<');
  const claude = viewOf(SESSIONS[0]);
  expect(claude).toContain('claude-code');
  expect(viewOf(SESSIONS[1])).not.toContain('claude-code');
});

/* ---------- the composer -------------------------------------------------- */

test('the composer says "Reply to Codex…" on a codex session — in both languages', () => {
  expect(viewOf(SESSIONS[1])).toContain('Reply to Codex');
  expect(viewOf(SESSIONS[0])).toContain('Reply to Claude Code');

  prefs.setPrefs({ language: 'he' });
  expect(viewOf(SESSIONS[1])).toContain('השב ל-Codex');
  expect(viewOf(SESSIONS[0])).toContain('השב ל-Claude Code');
  prefs.setPrefs({ language: 'en' });
});

/* ---------- the request_screen card --------------------------------------- */

test('"<engine> wants you to look at the screen" names the engine that asked', () => {
  const event = { kind: 'screen-request', requestId: 'r1', prompt: 'log in', ts: Date.now() };
  const card = (sessionId) => render(h(ChatPane, { sessionId, events: [event], working: false, loading: false }));
  expect(card('sess_codex')).toContain('Codex wants you to look at the screen');
  expect(card('sess_claude')).toContain('Claude Code wants you to look at the screen');
});

/* ---------- the capabilities panel ---------------------------------------- */

test('the capabilities panel is titled after the engine, and drops the Claude-only usage tab for codex', () => {
  const panel = (session, initialTab = 'commands') =>
    render(h(SlashCommands.CapabilitiesPanel, { capabilities: {}, session, initialTab, onClose() {} }));

  expect(panel(SESSIONS[1])).toContain('Codex capabilities');
  expect(panel(SESSIONS[0])).toContain('Claude Code capabilities');

  // `usage` = Claude subscription meters + which Claude ACCOUNT this session
  // runs on. A codex session has neither, so the tab is not offered…
  expect(panel(SESSIONS[0])).toContain('Usage');
  expect(panel(SESSIONS[1])).not.toContain('Usage');
  // …and `/usage` opening it directly falls back rather than rendering blank.
  expect(panel(SESSIONS[1], 'usage')).toContain('Info');
});

/* ---------- what a codex session is NOT asked ----------------------------- */

test('codex compacts only on app-server — exec hides auto-compact and compact-now', async () => {
  engines.setCodexTransport('exec');
  expect(engines.supportsCompaction('codex')).toBe(false);
  for (const v of ['claude', '', null, undefined]) expect(engines.supportsCompaction(v)).toBe(true);
  engines.setCodexTransport('app-server');
  expect(engines.supportsCompaction('codex')).toBe(true);
});

test('codex exec has no permission MODES — told, not asked; app-server offers ask vs bypass', async () => {
  // exec spawns with --dangerously-bypass-approvals-and-sandbox whatever is stored.
  engines.setCodexTransport('exec');
  expect(engines.hasPermissionModes('codex')).toBe(false);
  expect(engines.permissionModesFor('codex')).toEqual([]);
  for (const v of ['claude', '', null, undefined]) expect(engines.hasPermissionModes(v)).toBe(true);
  engines.setCodexTransport('app-server');
  expect(engines.hasPermissionModes('codex')).toBe(true);
  expect(engines.permissionModesFor('codex')).toEqual(['default', 'bypassPermissions']);
  engines.setCodexTransport('exec');

  const { default: TermControls } = await import(web('components/TermControls.jsx'));
  const withMode = (s, permissionMode) => ({ ...s, claude: { state: 'idle', permissionMode } });
  // Both render without throwing; the codex one carries the standing fact in
  // its own string rather than whatever mode happened to be stored.
  expect(render(h(TermControls, { session: withMode(SESSIONS[1], 'plan') }))).toBeString();
  expect(render(h(TermControls, { session: withMode(SESSIONS[0], 'plan') }))).toBeString();

  const i18n = await import(web('lib/i18n.js'));
  expect(i18n.t('rail.noPermissionModes', { engine: 'Codex' })).toContain('Codex');
  expect(i18n.t('rail.noPermissionModes', { engine: 'Codex' })).not.toContain('{engine}');
  engines.setCodexTransport('app-server');
  expect(render(h(TermControls, { session: withMode(SESSIONS[1], 'default') }))).toBeString();
});

/* ---------- restart / clear dialogs + MCP hint (P1-8) --------------------- */

test('restart/clear dialogs and the MCP reconnect hint name the engine in both locales', async () => {
  const keys = ['rail.restartConfirmBody', 'rail.clearConfirmBody', 'launcher.mcp.statusHint'];
  const i18n = await import(web('lib/i18n.js'));
  for (const lang of ['en', 'he']) {
    prefs.setPrefs({ language: lang });
    for (const k of keys) {
      const s = i18n.t(k, { engine: 'Codex', name: 'x' });
      expect(s).toContain('Codex');
      expect(s).not.toContain('{engine}');
      expect(s.toLowerCase()).not.toContain('claude');
    }
    for (const k of ['rail.restartConfirmTitle', 'rail.restartConfirm', 'rail.restartFailed', 'rail.clearConfirmTitle', 'rail.clearConfirm', 'rail.clearFailed'])
      expect(i18n.t(k)).not.toBe(k);
  }
  prefs.setPrefs({ language: 'en' });
});

/* ---------- /info on codex + GPT model names (P4-2, P4-3) ----------------- */

test('/info on a codex session that ran is not "not started" and drops claude-only rows; GPT ids get the catalog name', async () => {
  const ran = { ...SESSIONS[1], claude: { state: 'idle', sessionId: 'thread-1', modelChoice: 'gpt-5.6-terra' } };
  const info = render(h(SlashCommands.CapabilitiesPanel, { capabilities: {}, session: ran, initialTab: 'info', onClose() {} }));
  const i18n = await import(web('lib/i18n.js'));
  expect(info).not.toContain(i18n.t('dialogs.claudeCodeNotStarted', { engine: 'Codex' }));
  const dt = (k) => `<dt class="text-fgdim">${i18n.t(k)}</dt>`;
  expect(info).not.toContain(dt('dialogs.infoOrganization'));
  expect(info).not.toContain(dt('dialogs.infoCommands'));
  expect(info).toContain('bypassPermissions');
  expect(info).toContain('gpt-5.6-terra');
  const claudeInfo = render(h(SlashCommands.CapabilitiesPanel, { capabilities: {}, session: SESSIONS[0], initialTab: 'info', onClose() {} }));
  expect(claudeInfo).toContain(dt('dialogs.infoOrganization'));

  const ladder = await import(web('components/LadderBadge.jsx'));
  expect(ladder.configuredName('gpt-5.6-terra')).toBe('GPT-5.6-Terra');
  expect(ladder.runningName('gpt-5.6-luna', i18n.t)).toBe('GPT-5.6-Luna');
  expect(ladder.configuredName('claude-opus-4-8')).toBe('Opus');
});
