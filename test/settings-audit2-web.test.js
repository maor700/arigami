// AUDIT2 web: the Settings screen is three pages + a collapsed "Advanced"
// drawer. The General page shows theme/language/font size and, only when the
// server reports voiceEnabled, the voice hotkey+mode; everything classified
// ADV/MOVE renders inside a closed <details> (still in the DOM, so deep links
// and these tests can see it). Connections lists what is connected in ONE
// list (native MCP + Composio + WhatsApp + Tailscale) with the route on the
// row, the grids are gone, and "Add connection" is the only way to the
// catalog. Health hides the "reminded you" incident class by default. Legacy
// category ids (voice / automation) resolve onto the General page.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, store, General, Connections, Health, HostPage, SettingsMod, origFetch;
const h = (...a) => React.createElement(...a);

const TOOLKITS = {
  hasKey: true,
  toolkits: [
    { slug: 'gmail', name: 'Gmail', connected: true, description: 'mail' },
    { slug: 'googlecalendar', name: 'Google Calendar', connected: true },
    { slug: 'facebook', name: 'Facebook', connected: true },
    ...Array.from({ length: 150 }, (_, i) => ({ slug: `svc${i}`, name: `Service ${i}`, connected: false, description: 'unrelated' })),
  ],
};
const CAPS = {
  identity: { email: 'me@example.com', provider: 'google', connectedAt: new Date().toISOString() },
  capabilities: [
    { id: 'claude', ok: true, provider: 'local', data: {} },
    { id: 'git', ok: true, detail: 'git credentials present', provider: 'local', data: {} },
    { id: 'desktop', ok: true, detail: 'display :99', provider: 'local', data: {} },
    { id: 'mcp:linear', title: 'Linear', provider: 'native-mcp', ok: true, owner: 'global', data: { name: 'linear', auth: 'oauth', tools: 'mcp__linear__*' } },
    { id: 'mcp:notion', title: 'Notion', provider: 'native-mcp', ok: false, owner: 'global', data: { auth: 'oauth' } },
    { id: 'mcp:asana', title: 'Asana', provider: 'native-mcp', ok: false, owner: 'global', data: { auth: 'oauth-byo-client' } },
    { id: 'whatsapp', ok: true, provider: 'local', data: {} },
  ],
  audit: [{ at: new Date().toISOString(), capability: 'mcp:linear', mode: 'auto', result: 'ok' }],
};

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, getElementById: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test', mediaDevices: { enumerateDevices: async () => [] } };
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/composio/toolkits') ? TOOLKITS
      : u.includes('/setup/capabilities') ? CAPS
        : u.includes('/whatsapp/status') ? { status: 'connected', user: 'Dana' }
          : u.includes('/remote') ? { available: true, loggedIn: true, serving: false, directUrl: 'http://box.ts.net:3099' }
            : u.includes('/agents') ? { agents: [{ slug: 'scout', name: 'Scout', emoji: '🔭' }] }
              : {};
    return { ok: true, status: 200, url: u, json: async () => body, text: async () => JSON.stringify(body) };
  };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  store = await import(web('lib/store.js'));
  ({ default: General } = await import(web('components/settings/Appearance.jsx')));
  ({ default: Connections } = await import(web('components/settings/Connections.jsx')));
  ({ default: Health } = await import(web('components/settings/Health.jsx')));
  ({ default: HostPage } = await import(web('components/settings/Host.jsx')));
  SettingsMod = await import(web('components/Settings.jsx'));
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

// The drawer is a <details>; "closed" = no `open` attribute on it.
const drawerOpen = (html) => /<details[^>]*\sopen(=""|\s|>)/.test(html);
const beforeDrawer = (html) => html.split('<details')[0];

test('the nav is three pages; voice/automation are aliases onto General', () => {
  expect(SettingsMod.SETTINGS_NAV).toEqual(['appearance', 'connections', 'host']);
  expect(SettingsMod.SETTINGS_CATEGORIES).toEqual(expect.arrayContaining(['appearance', 'connections', 'host', 'voice', 'automation']));
  expect(SettingsMod.resolveCategory('voice')).toEqual({ cat: 'appearance', section: 'voice' });
  expect(SettingsMod.resolveCategory('automation')).toEqual({ cat: 'appearance', section: 'heartbeat' });
  expect(SettingsMod.resolveCategory('automation', 'telemetry')).toEqual({ cat: 'appearance', section: 'telemetry' });
  expect(SettingsMod.resolveCategory('host', 'health')).toEqual({ cat: 'host', section: 'health' });
  expect(SettingsMod.resolveCategory('bogus')).toEqual({ cat: 'appearance', section: '' });
});

test('General: 3 fields on the page while voice is off; accent/terminal/voice/heartbeat/telemetry are in the closed drawer', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(General, { voiceEnabled: false, recording: false, setRecording: () => {} }));
  const top = beforeDrawer(html);
  expect(top).toContain('Theme');
  expect(top).toContain('Language');
  expect(top).toContain('Font size');
  expect(top).not.toContain('Accent');
  expect(top).not.toContain('Record hotkey');
  expect(top).not.toContain('Heartbeat');
  expect(drawerOpen(html)).toBe(false);
  expect(html).toContain('Advanced');
  expect(html).toContain('data-voice-off');
  expect(html).toContain('Accent');
  expect(html).toContain('Terminal theme');
  expect(html).toContain('Microphone');
  expect(html).toContain('anonymous usage milestones');
  // The payload preview / anonymous id rows are gone from the UI.
  expect(html).not.toContain('Preview payload');
  expect(html).not.toContain('Reset ID');
});

test('General: voiceEnabled puts hotkey + mode on the page; a deep link into the drawer opens it', () => {
  const on = render(h(General, { voiceEnabled: true, recording: false, setRecording: () => {} }));
  const top = beforeDrawer(on);
  expect(top).toContain('Record hotkey');
  expect(top).toContain('Hold to talk');
  expect(on).not.toContain('data-voice-off');
  const deep = render(h(General, { section: 'heartbeat', voiceEnabled: false, recording: false, setRecording: () => {} }));
  expect(drawerOpen(deep)).toBe(true);
  const voiceDeep = render(h(General, { section: 'voice', voiceEnabled: false, recording: false, setRecording: () => {} }));
  expect(drawerOpen(voiceDeep)).toBe(true);
});

test('Connections: one connected list (native + Composio + WhatsApp + Tailscale) with the route on the row, no grids, one Add button', async () => {
  await store.loadAgents?.().catch(() => {});
  // First paint is before the GETs resolve; render once, then let effects settle by re-rendering with the data through the fetch stub.
  const html = render(h(Connections, {}));
  expect(html).toContain('data-add-connection-btn');
  expect(html).toContain('data-connected-list');
  // The old section headings are gone from the page.
  expect(html).not.toContain('Direct connections (MCP)');
  expect(html).not.toContain('More, via Composio');
  expect(html).not.toContain('Search integrations');
  // Drawer closed, owner filter + audit inside it.
  expect(drawerOpen(html)).toBe(false);
  expect(html).toContain('data-connections-owner');
  expect(html).toContain('Recent connections');
  // Deep-linking to the old catalog sections opens the picker instead.
  const picker = render(h(Connections, { section: 'mcp' }));
  expect(picker).toContain('data-add-connection');
  expect(picker).toContain('Search services');
});

test('Connections rows: provider is a hover title, not a heading', async () => {
  const { default: AddConnection } = await import(web('components/settings/AddConnection.jsx'));
  // The picker: unconnected native rows + FEATURED Composio only (not the 150-card catalog) until you type.
  const html = render(h(AddConnection, { mcpCaps: CAPS.capabilities.filter((c) => c.provider === 'native-mcp'), composio: TOOLKITS, whatsappCap: { id: 'whatsapp', ok: false }, onPick: () => {}, onClose: () => {} }));
  expect(html).toContain('data-add-item="mcp:notion"');
  expect(html).not.toContain('data-add-item="mcp:linear"'); // connected → not offered
  expect(html).toContain('data-add-item="mcp:asana"'); // BYO listed but disabled
  expect(html).toMatch(/data-add-item="mcp:asana"[^>]*disabled/);
  expect(html).not.toContain('Service 7'); // catalog only by search
  expect((html.match(/data-add-item="composio:/g) || []).length).toBeLessThanOrEqual(6);
  expect(html).toContain('153 services');
});

test('Health: "reminded you" incidents are hidden by default, with an opt-in checkbox that says how many', async () => {
  const INC = {
    hours: 24, count: 4,
    incidents: [
      { ts: new Date().toISOString(), sessionId: 's1', action: 'notify-human', reason: 'review-requested', outcome: 'ok' },
      { ts: new Date().toISOString(), sessionId: 's1', action: 'notify-human', reason: 'action-card', outcome: 'ok' },
      { ts: new Date().toISOString(), sessionId: 's1', action: 'notify-human', reason: 'merge', outcome: 'ok' },
      { ts: new Date().toISOString(), sessionId: 's1', action: 'model-down', reason: 'accounts-exhausted', outcome: 'ok' },
    ],
  };
  const { filterIncidents, REMINDER_ACTIONS } = await import(web('components/settings/Health.jsx'));
  expect(REMINDER_ACTIONS.has('notify-human')).toBe(true);
  expect(filterIncidents(INC.incidents, false).map((i) => i.action)).toEqual(['model-down']);
  expect(filterIncidents(INC.incidents, true)).toHaveLength(4);
  const html = render(h(Health));
  expect(html).toContain('Incidents (24h)');
});

test('Host page: version/CLI/restart/upgrade/backup + who-am-i on the page; manager, budgets, health, VNC, danger zone in the closed drawer', () => {
  const html = render(h(HostPage, {}));
  const top = beforeDrawer(html);
  expect(top).toContain('Version');
  expect(top).toContain('Claude CLI');
  expect(top).toContain('Restart');
  expect(top).toContain('Upgrade');
  expect(top).toContain('Export / Import');
  expect(top).not.toContain('Supervisor');
  expect(top).not.toContain('Budgets');
  expect(top).not.toContain('Incidents (24h)');
  expect(top).not.toContain('VNC');
  expect(top).not.toContain('Auto-update');
  expect(drawerOpen(html)).toBe(false);
  expect(html).toContain('Supervisor');
  expect(html).toContain('Budgets');
  expect(html).toContain('Incidents (24h)');
  expect(html).toContain('Danger zone');
  // Sign-out left the danger zone (it is in the rail's profile menu now).
  expect(html).not.toContain('Sign out');
  const deep = render(h(HostPage, { section: 'health' }));
  expect(drawerOpen(deep)).toBe(true);
});

test('Hebrew: the three page labels and the drawer', () => {
  prefs.setPrefs({ language: 'he' });
  try {
    const html = render(h(General, { voiceEnabled: false, recording: false, setRecording: () => {} }));
    expect(html).toContain('מתקדם');
    expect(html).toContain('ערכת נושא');
    const conn = render(h(Connections, {}));
    expect(conn).toContain('הוסף חיבור');
    expect(conn).toContain('מחוברים');
  } finally {
    prefs.setPrefs({ language: 'en' });
  }
});
