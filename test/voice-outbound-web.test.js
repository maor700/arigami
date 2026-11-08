// Stage 4a web (docs/VOICE.md): Settings → Voice & phone → "Calls & SMS to others" — agent number, default caller ID (owner only once
// verified), the verify button, disclosure, AMD, caps, quiet hours, Shabbat, transfer; nothing before its view loads; both locales.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
let React, render, prefs, OutboundSetup;
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
  ({ OutboundSetup } = await import(web('components/settings/VoicePhone.jsx')));
});

const S = { disclosure: { he: 'שלום, כאן העוזר הדיגיטלי של {owner}.', en: "Hello, this is {owner}'s digital assistant." }, ownerName: 'מאור', callerId: 'agent', amd: 'voicemail', maxMinutes: 10, maxCallsPerDay: 5, maxSmsPerDay: 10, allowTransfer: true, askOwnerSeconds: 60, defaultCountry: '972', quiet: { start: '21:00', end: '08:00', shabbat: true, timezone: 'Asia/Jerusalem', lat: 31.778, lon: 35.235, extraDates: [] } };
const VIEW = { number: '+97233000000', callerIds: [], settings: S, today: { calls: 1, sms: 2 }, optOuts: 0, quietNow: '', live: 0, usdPerMin: 0.088, smsUsd: 0.2575 };

test('before its view loads it renders nothing', () => {
  prefs.setPrefs({ language: 'en' });
  expect(render(h(OutboundSetup, { admin: true, tick: 'x' }))).toBe('');
});

test('with a view: number, caller ID (owner disabled until verified), verify button, disclosure, AMD, caps, quiet hours, toggles; both locales', () => {
  for (const lang of ['en', 'he']) {
    prefs.setPrefs({ language: lang });
    const html = render(h(OutboundSetup, { admin: true, tick: 'x', initial: VIEW }));
    expect(html).toContain('data-outbound-setup');
    expect(html).toContain('value="+97233000000"');
    expect(html).toMatch(/<option value="owner" disabled="">/);
    expect(html).toContain('data-outbound-verify-start');
    expect(html).toContain('value="שלום, כאן העוזר הדיגיטלי של {owner}."');
    expect(html).toContain('value="מאור"');
    expect(html).toContain('data-outbound-amd');
    expect(html).toContain('value="21:00"');
    expect(html).toContain('value="08:00"');
    expect(html).toContain('data-outbound-shabbat="1"');
    expect(html).toContain('data-outbound-transfer="1"');
    expect(html).toContain(lang === 'he' ? 'היום: 1/5 שיחות · 2/10 SMS' : 'Today: 1/5 calls · 2/10 SMS');
    expect(html).not.toContain('data-outbound-quiet=');
    expect(html).not.toMatch(/settings\.connections\.outbound[a-zA-Z.]*/);
  }
});

test('a verified owner number is listed and selectable; quiet-now line shows the reason', () => {
  prefs.setPrefs({ language: 'en' });
  const html = render(h(OutboundSetup, { admin: true, tick: 'x', initial: { ...VIEW, callerIds: [{ number: '+972500000000', verifiedAt: '2026-11-08T00:00:00Z' }], quietNow: 'Shabbat' } }));
  expect(html).toContain('data-outbound-verified="+972500000000"');
  expect(html).toMatch(/<option value="owner">/);
  expect(html).toContain('Not now: Shabbat');
});
