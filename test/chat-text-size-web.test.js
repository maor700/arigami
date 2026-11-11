// Chat text size: prefs get/set/clamp/migration, the pure shortcut handler,
// the Settings control (SSR) and the wiring that makes it discoverable.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
const read = (p) => fs.readFileSync(web(p), 'utf8');

let React, render, prefs, ct, ChatTextSize, ChatTextPreview;
beforeAll(async () => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  ct = await import(web('lib/chatText.js'));
  ({ default: ChatTextSize, ChatTextPreview } = await import(web('components/settings/ChatTextSize.jsx')));
});

test('prefs: default 15px, set, clamp to 12–20, junk falls back', () => {
  expect(prefs.getPrefs().chatTextSize).toBe(15);
  prefs.setPrefs({ chatTextSize: 18 });
  expect(prefs.getPrefs().chatTextSize).toBe(18);
  prefs.setPrefs({ chatTextSize: 99 });
  expect(prefs.getPrefs().chatTextSize).toBe(20);
  prefs.setPrefs({ chatTextSize: 3 });
  expect(prefs.getPrefs().chatTextSize).toBe(12);
  prefs.setPrefs({ chatTextSize: 'abc' });
  expect(prefs.getPrefs().chatTextSize).toBe(15);
  prefs.setPrefs({ chatTextSize: 15 });
});

test('migration: legacy termFontSize 16 (the old default) → 15, a custom one shifts by the old 1px offset', () => {
  expect(ct.migrateChatText({ termFontSize: 16 })).toBe(15);
  expect(ct.migrateChatText({ termFontSize: 19 })).toBe(18);
  expect(ct.migrateChatText({ termFontSize: 24 })).toBe(20);
  expect(ct.migrateChatText({ chatTextSize: 13, termFontSize: 19 })).toBe(13);
  expect(ct.migrateChatText({})).toBe(15);
});

test('scale is 1 at the default and proportional elsewhere; step/reset are clamped', () => {
  expect(ct.chatScale(15)).toBe(1);
  expect(ct.chatScale(20)).toBeCloseTo(20 / 15);
  expect(ct.stepChatText(15, 'up')).toBe(16);
  expect(ct.stepChatText(20, 'up')).toBe(20);
  expect(ct.stepChatText(12, 'down')).toBe(12);
  expect(ct.stepChatText(19, 'reset')).toBe(15);
});

test('shortcut handler: ⌘/Ctrl + − 0 only while the chat is focused', () => {
  const ev = (key, o = {}) => ({ key, ctrlKey: true, ...o });
  expect(ct.chatTextShortcut(ev('+', { shiftKey: true }), true)).toBe('up');
  expect(ct.chatTextShortcut(ev('='), true)).toBe('up');
  expect(ct.chatTextShortcut(ev('-'), true)).toBe('down');
  expect(ct.chatTextShortcut(ev('0'), true)).toBe('reset');
  expect(ct.chatTextShortcut({ key: '+', metaKey: true }, true)).toBe('up');
  // focus elsewhere → browser zoom keeps working
  expect(ct.chatTextShortcut(ev('+'), false)).toBe(null);
  // no modifier, alt chords, other keys
  expect(ct.chatTextShortcut({ key: '+' }, true)).toBe(null);
  expect(ct.chatTextShortcut(ev('+', { altKey: true }), true)).toBe(null);
  expect(ct.chatTextShortcut(ev('a'), true)).toBe(null);
});

test('settings control renders label, slider bounds, A−/A+, px value and a he+en preview', () => {
  const html = render(React.createElement(ChatTextSize));
  expect(html).toContain('data-chat-text-size');
  expect(html).toContain('type="range"');
  expect(html).toContain('min="12"');
  expect(html).toContain('max="20"');
  expect(html).toContain('15px');
  expect(html).toContain('A−');
  expect(html).toContain('A+');
  expect(html).toContain('data-chat-text-preview');
  expect(html).toMatch(/lang="he"/);
  expect(html).toMatch(/lang="en"/);
  expect(html).not.toContain('settings.fontSize'); // keys resolve
  // reset only shows when off-default
  expect(html).not.toContain('איפוס');
  expect(render(React.createElement(ChatTextPreview, { px: 18 }))).toContain('font-size:18px');
});

test('wiring: --chat-scale on <html>, scaled transcript/composer/menus, header menu item, shortcut installed, help row', () => {
  expect(read('lib/prefs.js')).toContain("--chat-scale");
  const css = read('index.css');
  expect(css).toMatch(/\.term-events\s*{[^}]*zoom: var\(--chat-scale/);
  expect(css).toMatch(/\.chat-scaled-pop\s*{[^}]*92vw/);
  expect(read('components/Composer.jsx')).toContain('chat-scaled');
  expect(read('components/SlashCommands.jsx').match(/chat-scaled-pop/g).length).toBe(2);
  expect(read('components/SessionView.jsx')).toContain('<ChatTextSizeSub />');
  expect(read('main.jsx')).toContain('installChatTextShortcuts()');
  expect(read('components/ShortcutsHelp.jsx')).toContain('scChatTextSize');
  expect(read('components/settings/Appearance.jsx')).toContain('<ChatTextSize />');
});
