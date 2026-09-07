// BRAND (dispatch/branding-font): the app wears the landing page's brand by
// default — the folded-star mark, orange accent, dark chrome — and the mark
// shows in the rail header, the pairing screen, the Settings header and the
// empty (no session) screen. Type defaults: chat output 16px; a separate
// small/medium/large UI size drives --ui-scale on <html> (rem), so the rail
// and chrome are measured in rem, not px.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);

let React, render, prefs, logos, Logo, Login, FirstRun, SettingsMod;
const h = (...a) => React.createElement(...a);

beforeAll(async () => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  logos = await import(web('lib/logos.js'));
  ({ Logo } = await import(web('components/Logo.jsx')));
  Login = (await import(web('components/Login.jsx'))).default;
  FirstRun = (await import(web('components/FirstRun.jsx'))).default;
  SettingsMod = await import(web('components/Settings.jsx'));
});

test('defaults: landing-page orange accent, dark chrome, 16px chat font, medium UI size, star mark', () => {
  expect(logos.DEFAULT_ACCENT).toBe('#f97316');
  expect(logos.DEFAULT_LOGO).toBe('star');
  const p = prefs.getPrefs();
  expect(p.theme).toBe('dark');
  expect(p.termFontSize).toBe(16);
  expect(p.uiScale).toBe('medium');
  expect(p.logo).toBe('star');
  expect(prefs.PREF_LIMITS.font).toEqual([10, 24]);
});

test('sanitize: uiScale accepts only small/medium/large; font size clamps into the new range', () => {
  prefs.setPrefs({ uiScale: 'huge' });
  expect(prefs.getPrefs().uiScale).toBe('medium');
  prefs.setPrefs({ uiScale: 'large' });
  expect(prefs.getPrefs().uiScale).toBe('large');
  expect(prefs.UI_SCALES.large).toBeGreaterThan(prefs.UI_SCALES.medium);
  expect(prefs.UI_SCALES.small).toBeLessThan(prefs.UI_SCALES.medium);
  prefs.setPrefs({ termFontSize: 99 });
  expect(prefs.getPrefs().termFontSize).toBe(24);
  prefs.setPrefs({ uiScale: 'medium', termFontSize: 16 });
});

test('favicon svg: orange facets shaded darker (no translucent facets), star by default', () => {
  const svg = logos.logoSvg(undefined, undefined);
  expect(svg).toContain('viewBox="0 0 64 64"');
  expect(svg).toContain('fill="#f97316"');
  expect(svg).not.toContain('fill-opacity');
  expect(svg).not.toContain('12a594');
  // the shadow facet is a darker orange, still orange-ish (r > g > b)
  const shade = logos.facetColor('#f97316', 0.62);
  expect(shade).not.toBe('#f97316');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(shade.slice(i, i + 2), 16));
  expect(r).toBeGreaterThan(g);
  expect(g).toBeGreaterThan(b);
  expect(r).toBeLessThan(0xf9);
});

test('Logo component: the star preset in currentColor, shadow facets via color-mix, sized in rem', () => {
  const out = render(h(Logo, { size: '2rem' }));
  expect(out).toContain('data-logo="star"');
  expect(out).toContain('viewBox="0 0 64 64"');
  expect((out.match(/<path /g) || []).length).toBe(8);
  expect(out).toContain('fill="currentColor"');
  expect(out).toContain('color-mix(in srgb, currentColor');
  expect(out).toContain('width:2rem');
  expect(out).toContain('text-brand');
});

test('the mark is on the pairing screen, the empty screen and the Settings header (Wave = the mark now)', () => {
  const login = render(h(Login, { info: { hasAdmin: true } }));
  expect(login).toContain('data-logo="star"');
  expect(login).not.toContain('items-end gap-0.5'); // the old four-bar glyph is gone
  const first = render(h(FirstRun, { config: {}, sessions: [], onCreated() {}, onOpenLauncher() {} }));
  expect(first).toContain('data-logo="star"');
  expect(first).not.toContain('items-end gap-0.5');
  const settings = render(h(SettingsMod.default, { category: 'appearance', onCategory() {}, onClose() {} }));
  expect(settings).toContain('data-logo="star"');
});

test('rail header row: the mark + wordmark; rail/login/settings chrome measured in rem, not px text sizes', () => {
  const rail = fs.readFileSync(web('components/Rail.jsx'), 'utf8');
  expect(rail).toContain('<Logo size="1.25rem" />');
  expect(rail).toContain('>Arigami</span>');
  for (const f of ['components/Rail.jsx', 'components/Login.jsx', 'components/FirstRun.jsx', 'components/TabBar.jsx', 'components/Settings.jsx', 'components/settings/shared.jsx', 'components/settings/Appearance.jsx']) {
    const src = fs.readFileSync(web(f), 'utf8');
    const px = (src.match(/text-\[\d+(?:\.\d+)?px\]/g) || []).filter((m) => m !== 'text-[16px]'); // 16px inputs stay px (iOS zoom guard)
    expect({ f, px }).toEqual({ f, px: [] });
  }
  const css = fs.readFileSync(web('index.css'), 'utf8');
  expect(css).toMatch(/html \{\s*font-size: calc\(100% \* var\(--ui-scale, 1\)\);/);
  expect(css).toContain('--color-brand: #f97316');
  expect(fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8')).toContain('theme-color" content="#f97316"');
  expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public/manifest.json'), 'utf8')).theme_color).toBe('#f97316');
});
