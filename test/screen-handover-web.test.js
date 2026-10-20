// Screen hand-over UX:
//   · the request_screen card has its own Done (agents say "click Done")
//   · a live view never shows an unexplained black frame: "connecting…" before
//     the first frame, "desktop is idle" while the frame is uniformly dark
//   · the request renders once — the side panel no longer auto-opens with a
//     second copy of the prompt and buttons
//   · a plain machine view opens in Watch, says whose machine it is, and has
//     an explicit Take control / Release
import { test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
const read = (p) => fs.readFileSync(web(p), 'utf8');

let React, render, store, isBlankFrame, ScreenRequestCard, prefs, en, he;
const h = (...a) => React.createElement(...a);

beforeAll(async () => {
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '', search: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.WebSocket = class { close() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  prefs.setPrefs({ language: 'en' });
  store = await import(web('lib/store.js'));
  ({ isBlankFrame } = await import(web('components/ScreenView.jsx')));
  ({ default: ScreenRequestCard } = await import(web('components/ScreenRequestCard.jsx')));
  en = { ...(await import(web('locales/en/chat.js'))).strings, ...(await import(web('locales/en/rail.js'))).strings };
  he = { ...(await import(web('locales/he/chat.js'))).strings, ...(await import(web('locales/he/rail.js'))).strings };
});

const rgba = (pixels) => Uint8ClampedArray.from(pixels.flatMap(([r, g, b]) => [r, g, b, 255]));

test('isBlankFrame: a uniformly dark frame is idle; any content, or a lit uniform frame, is not', () => {
  expect(isBlankFrame(rgba(Array(640).fill([0, 0, 0])))).toBe(true);
  expect(isBlankFrame(rgba(Array(640).fill([8, 8, 10])))).toBe(true);
  expect(isBlankFrame(new Uint8ClampedArray(0))).toBe(true); // no frame yet
  const withWindow = Array(640).fill([0, 0, 0]);
  withWindow[300] = [230, 230, 230];
  expect(isBlankFrame(rgba(withWindow))).toBe(false);
  expect(isBlankFrame(rgba(Array(640).fill([40, 90, 160])))).toBe(false); // a wallpaper is content
  const dimGradient = Array.from({ length: 640 }, (_, i) => [i % 20, i % 20, i % 20]);
  expect(isBlankFrame(rgba(dimGradient))).toBe(false); // dark but not uniform (a dark theme window)
});

test('the request renders once: an open request does not open the side panel; only the human does', () => {
  const s = {
    sessions: [{ id: 's1', claude: { screenRequest: { requestId: 'r1' } } }],
    chats: { s1: [{ kind: 'screen-request', requestId: 'r1', prompt: 'log in' }] },
    screen: { controlRequestId: null, panel: null, modal: false },
  };
  expect(store.openScreenRequest(s, 's1')).toBeTruthy();
  expect(store.screenPanelOpen(s, 's1')).toBe(false);
  expect(store.screenPanelOpen({ ...s, screen: { ...s.screen, panel: true } }, 's1')).toBe(true);
  // and the panel has no second copy of the prompt / Cancel / Take over buttons
  const panel = read('components/ScreenSidePanel.jsx');
  expect(panel).not.toContain('cancelScreenRequest');
  expect(panel).not.toContain('req.prompt');
  expect(panel).toContain("t('screen.requestInChat')");
});

test('the card: Done, Take over and Cancel while open; Done is the primary action', () => {
  const html = render(h(ScreenRequestCard, { sessionId: 's1', event: { kind: 'screen-request', requestId: 'r1', prompt: 'log in', hint: 'click Done' } }));
  expect(html).toContain('data-screen-done');
  expect(html).toMatch(/data-variant="primary"[^>]*data-screen-done/);
  expect(html).toContain('>Done<');
  expect(html).toContain('Take over');
  expect(html).toContain('Cancel');
  // the live view starts with a "connecting" overlay, never a bare black box
  expect(html).toContain('data-screen-overlay="idle"');
  expect(html).toContain('Connecting…');
});

test('a plain machine view opens in Watch with an owner badge and an explicit Take control / Release', () => {
  const modal = read('components/ScreenModal.jsx');
  expect(modal).toContain('useState(!!context?.control)');
  expect(modal).toContain('viewOnly={!interactive}');
  expect(modal).toContain('data-screen-owner');
  expect(modal).toContain('data-screen-control-toggle');
  expect(modal).toContain("t('screen.takeControl')");
  expect(modal).toContain("t('screen.release')");
  // typing into the desktop is a control action — not offered while watching
  expect(modal).toContain('context?.sessionId && interactive &&');
  // "My browser" is opened in order to drive it — it opens already in control
  expect(read('components/Rail.jsx')).toContain('setScreenModal({ control: true })');
  expect(store.setScreenModal).toBeTypeOf('function');
});

test('every new string exists in English and Hebrew', () => {
  const keys = [
    'rail.screenIdle', 'rail.screenIdleDetail', 'screen.cardDoneHint', 'screen.requestInChat', 'screen.modeControl',
    'screen.takeControl', 'screen.takeControlHint', 'screen.release', 'screen.releaseHint', 'screen.ownerShared', 'screen.ownerSession',
  ];
  for (const k of keys) {
    expect(typeof en[k]).toBe('string');
    expect(typeof he[k]).toBe('string');
    expect(he[k]).not.toBe(en[k]);
  }
  expect(en['screen.ownerSession']).toContain('{title}');
  expect(he['screen.ownerSession']).toContain('{title}');
});
