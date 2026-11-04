// Voice & phone in the web (docs/VOICE.md): with nothing connected the Connections hub renders no "Voice & phone"
// section and the providers only sit inside the "Add connection" picker; with a connected stub the section renders
// with the kill-switch, usage and caps; the token step renders Twilio's two fields; titles resolve in both locales.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, registry, Connections, VoicePhoneSection, voicePresent, AddConnectionPanel, TokenStep;
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
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  registry = await import(web('components/setup/registry.js'));
  ({ default: Connections } = await import(web('components/settings/Connections.jsx')));
  ({ VoicePhoneSection, voicePresent } = await import(web('components/settings/VoicePhone.jsx')));
  ({ AddConnectionPanel } = await import(web('components/settings/AddConnection.jsx')));
  ({ default: TokenStep } = await import(web('components/setup/TokenStep.jsx')));
});

const cap = (id, title, kinds, extra = {}) => ({ id, title, group: 'voice', provider: 'local', ok: false, detail: `paste a key for ${title}`, data: { hasKey: false, kinds }, manual: { kind: 'token', fields: [{ name: 'token', label: `${title} API key`, secret: true }] }, autoCapable: false, ...extra });
const NONE = [
  cap('voice:openai', 'OpenAI (voice)', ['stt', 'tts', 'realtime']),
  cap('voice:elevenlabs', 'ElevenLabs', ['tts']),
  cap('voice:cartesia', 'Cartesia', ['tts']),
  cap('voice:deepgram', 'Deepgram', ['stt']),
  cap('telephony:twilio', 'Twilio (phone)', ['telephony'], { manual: { kind: 'token', fields: [{ name: 'sid', label: 'Account SID', placeholder: 'AC…' }, { name: 'token', label: 'Auth Token', secret: true }] } }),
];
const CONNECTED = NONE.map((c) => (c.id === 'voice:elevenlabs' ? { ...c, ok: true, detail: 'connected', data: { hasKey: true, kinds: ['tts'] } } : c));
const noop = () => {};

test('nothing connected: the Connections hub has no Voice & phone section; the section component renders nothing', () => {
  for (const lang of ['en', 'he']) {
    prefs.setPrefs({ language: lang });
    const hub = render(h(Connections, {}));
    expect(hub).not.toContain('settings-voice');
    expect(hub).not.toContain('data-voice-row');
    expect(hub).not.toContain(lang === 'he' ? 'קול וטלפון' : 'Voice &amp; phone');
    expect(render(h(VoicePhoneSection, { caps: NONE, budget: null, admin: true, busy: false }))).toBe('');
  }
  expect(voicePresent(NONE)).toEqual([]);
  prefs.setPrefs({ language: 'en' });
});

test('Add connection picker: the five providers sit in a Voice & phone group until one has a key', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(AddConnectionPanel, { mcpCaps: [], composio: { toolkits: [], hasKey: true }, whatsappCap: { id: 'whatsapp', ok: true }, voiceCaps: NONE, busy: false, onPick: noop }));
  expect(html).toContain('Voice &amp; phone');
  for (const c of NONE) expect(html).toContain(`data-add-item="${c.id}"`);
  expect(html).toContain('stt / tts / realtime');
  const after = render(h(AddConnectionPanel, { mcpCaps: [], composio: { toolkits: [], hasKey: true }, whatsappCap: { id: 'whatsapp', ok: true }, voiceCaps: CONNECTED, busy: false, onPick: noop }));
  expect(after).not.toContain('data-add-item="voice:elevenlabs"');
  expect(after).toContain('data-add-item="voice:cartesia"');
  // no voice caps at all (old host): the group is absent, nothing breaks
  expect(render(h(AddConnectionPanel, { mcpCaps: [], composio: { toolkits: [], hasKey: true }, whatsappCap: { id: 'whatsapp', ok: true }, busy: false, onPick: noop }))).not.toContain('Voice &amp; phone');
});

test('a connected provider: the section renders with the kill-switch, the row, this month\'s usage and the cap input', () => {
  const budget = { enabled: true, caps: { 'voice:elevenlabs': 5 }, month: '2026-11', usage: { 'voice:elevenlabs': { seconds: 0, chars: 25000, usd: 1, calls: 3, capUsd: 5, state: 'ok' } }, providers: { enabled: true, stt: [], tts: ['voice:elevenlabs'], realtime: [], telephony: false } };
  prefs.setPrefs({ language: 'en' });
  const html = render(h(VoicePhoneSection, { caps: CONNECTED, budget, admin: true, busy: false, onConnect: noop, onDisconnect: noop, onChanged: noop }));
  expect(html).toContain('id="settings-voice"');
  expect(html).toContain('Voice &amp; phone');
  expect(html).toContain('data-voice-enabled="1"');
  expect(html).toContain('data-voice-row="voice:elevenlabs"');
  expect(html).not.toContain('data-voice-row="voice:openai"'); // no key → not in the section
  expect(html).toContain('$1.00 this month');
  expect(html).toContain('/ $5.00');
  expect(html).toContain('value="5"');
  expect(html).toContain('Disconnect');
  expect(html).not.toMatch(/settings\.connections\.voice[a-zA-Z.]*/); // no raw i18n keys
  // soft-stopped + switched off read as such; a non-admin gets no cap input
  const stopped = { ...budget, enabled: false, usage: { 'voice:elevenlabs': { ...budget.usage['voice:elevenlabs'], usd: 5, state: 'soft-stopped' } } };
  const off = render(h(VoicePhoneSection, { caps: CONNECTED, budget: stopped, admin: false, busy: false }));
  expect(off).toContain('data-voice-enabled="0"');
  expect(off).toContain('cap reached');
  expect(off).not.toContain('type="number"');
  // a stored-but-rejected key still shows (so it can be replaced), with the server's reason
  const rejected = CONNECTED.map((c) => (c.id === 'voice:elevenlabs' ? { ...c, ok: false, detail: 'ElevenLabs rejected the key (401)', data: { hasKey: true, rejected: true, kinds: ['tts'] } } : c));
  expect(render(h(VoicePhoneSection, { caps: rejected, budget: null, admin: true, busy: false }))).toContain('data-voice-row="voice:elevenlabs"');
  prefs.setPrefs({ language: 'he' });
  expect(render(h(VoicePhoneSection, { caps: CONNECTED, budget, admin: true, busy: false }))).toContain('קול וטלפון');
  prefs.setPrefs({ language: 'en' });
});

test('TokenStep: Twilio renders Account SID + Auth Token; a one-field provider stays a single password box', () => {
  prefs.setPrefs({ language: 'en' });
  const tw = render(h(TokenStep, { capability: 'telephony:twilio', manual: NONE[4].manual }));
  expect(tw).toContain('data-token-field="sid"');
  expect(tw).toContain('aria-label="Account SID"');
  expect(tw).toContain('placeholder="AC…"');
  expect(tw).toContain('aria-label="Auth Token"');
  expect((tw.match(/<input/g) || []).length).toBe(2);
  const el = render(h(TokenStep, { capability: 'voice:elevenlabs', manual: { kind: 'token', fields: [{ name: 'token', label: 'ElevenLabs API key', secret: true, placeholder: 'xi-…' }] } }));
  expect((el.match(/<input/g) || []).length).toBe(1);
  expect(el).toContain('placeholder="xi-…"');
  expect(el).toContain('type="password"');
  // untouched: the GitHub token step keeps its family placeholder
  expect(render(h(TokenStep, { capability: 'git', manual: { kind: 'token', fields: [{ name: 'token', label: 'GitHub token', secret: true, placeholder: 'ghp_…' }] } }))).toContain('ghp_… / github_pat_…');
});

test('registry: voice ids have a token family and human titles in both locales', () => {
  expect(registry.manualFor('voice:openai').manual.kind).toBe('token');
  expect(registry.manualFor('telephony:twilio').autoCapable).toBe(false);
  expect(registry.isVoiceFamily('voice:cartesia')).toBe(true);
  expect(registry.isVoiceFamily('composio:gmail')).toBe(false);
  const i18n = require(web('lib/i18n.js'));
  prefs.setPrefs({ language: 'en' });
  expect(registry.capTitle(i18n.t, 'voice:openai')).toBe('OpenAI (voice)');
  expect(registry.capTitle(i18n.t, 'telephony:twilio')).toBe('Twilio (phone)');
  prefs.setPrefs({ language: 'he' });
  expect(registry.capTitle(i18n.t, 'voice:elevenlabs')).toContain('ElevenLabs');
  expect(registry.capTitle(i18n.t, 'voice:elevenlabs')).toContain('(קול)');
  prefs.setPrefs({ language: 'en' });
});
