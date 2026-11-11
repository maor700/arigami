// Stage 2 web (docs/VOICE.md): the phone panel inside Settings → Voice & phone exists only with Twilio connected; with a view it
// shows the owner number, the PIN state, the two console URLs, the signature test, the lockout line; no raw i18n keys; both locales.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
let React, render, prefs, VoicePhoneSection, PhoneSetup;
const h = (...a) => React.createElement(...a);

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' }, body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), json: async () => ({}), text: async () => '' });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  ({ VoicePhoneSection, PhoneSetup } = await import(web('components/settings/VoicePhone.jsx')));
});

const twilio = (ok) => ({ id: 'telephony:twilio', title: 'Twilio (phone)', ok, detail: ok ? 'connected' : 'paste a key', data: { hasKey: true, kinds: ['telephony'] } });
const budget = { enabled: true, caps: {}, month: '2026-11', usage: {}, providers: { enabled: true, stt: [], tts: [], realtime: ['voice:gemini'], telephony: true } };
const VIEW = { telephony: true, ownerNumber: '+972500000000', pinSet: true, publicUrl: '', base: 'https://h.example', voiceUrl: 'https://h.example/__api/webhooks/twilio/voice', statusUrl: 'https://h.example/__api/webhooks/twilio/status', streamUrl: 'wss://h.example/__api/webhooks/twilio/stream', lockedUntil: 0, live: 0 };
const noop = () => {};

test('the panel mounts only with Twilio connected (a key alone is not enough); before its view loads it renders nothing', () => {
  prefs.setPrefs({ language: 'en' });
  expect(render(h(VoicePhoneSection, { caps: [twilio(false)], budget, admin: true, busy: false, onConnect: noop, onDisconnect: noop, onChanged: noop }))).not.toContain('data-phone-setup');
  const html = render(h(VoicePhoneSection, { caps: [twilio(true)], budget, admin: true, busy: false, onConnect: noop, onDisconnect: noop, onChanged: noop }));
  expect(html).toContain('data-voice-row="telephony:twilio"');
  expect(html).not.toContain('data-phone-setup'); // the view comes from GET /voice/phone in an effect
  expect(render(h(PhoneSetup, { admin: true, tick: 'x' }))).toBe('');
});

test('with a view: number, PIN set, the two URLs, test button; the PIN input is write-only; lockout and live lines; both locales', () => {
  for (const lang of ['en', 'he']) {
    prefs.setPrefs({ language: lang });
    const html = render(h(PhoneSetup, { admin: true, tick: 'x', initial: VIEW }));
    expect(html).toContain('data-phone-setup');
    expect(html).toContain('value="+972500000000"');
    expect(html).toContain(lang === 'he' ? '✓ מוגדר' : '✓ set');
    expect(html).toContain('https://h.example/__api/webhooks/twilio/voice');
    expect(html).toContain('https://h.example/__api/webhooks/twilio/status');
    expect(html).not.toContain('wss://'); // the stream URL is the host's business, not a console field
    expect(html).toContain('data-phone-test');
    expect(html).toContain('type="password"');
    expect(html).toContain(lang === 'he' ? 'A call comes in' : 'A call comes in');
    expect(html).not.toContain('data-phone-locked');
    expect(html).not.toContain('data-phone-no-url');
    expect(html).not.toMatch(/settings\.connections\.phone[a-zA-Z.]*/);
  }
  prefs.setPrefs({ language: 'en' });
  const locked = render(h(PhoneSetup, { admin: true, tick: 'x', initial: { ...VIEW, pinSet: false, lockedUntil: Date.now() + 60_000, live: 1, voiceUrl: '', statusUrl: '' } }));
  expect(locked).toContain('data-phone-locked');
  expect(locked).toContain('data-phone-live');
  expect(locked).toContain('not set');
  expect(locked).toContain('data-phone-no-url');
  expect(locked).not.toContain('data-phone-urls');
  // a non-admin sees the state but cannot change it
  const viewer = render(h(PhoneSetup, { admin: false, tick: 'x', initial: VIEW }));
  expect(viewer).toContain('data-phone-owner');
  expect((viewer.match(/disabled=""/g) || []).length).toBeGreaterThanOrEqual(3);
});
