// QA round 1 (astra reports) — the behaviours the web side owns: named fields +
// radio-group keyboard, GitHub picker recovery, merge pill after "request
// changes", bidi isolation of code, list markers, settings find, contrast
// tokens, lazy chunks, reading controls in the gear. SSR renders with the
// language set explicitly; the rest is pure.
import { test, expect, beforeAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
const read = (p) => fs.readFileSync(web(p), 'utf8');

let React, render, prefs, shared, Picker, MergeCard, Md, Find, repoStatus, SetupMod;
const h = (...a) => React.createElement(...a);

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, getElementById: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  prefs.setPrefs({ language: 'en' });
  shared = await import(web('components/settings/shared.jsx'));
  Picker = await import(web('components/setup/RepoPicker.jsx'));
  MergeCard = await import(web('components/MergeCard.jsx'));
  Md = await import(web('components/Md.jsx'));
  Find = await import(web('components/settings/Find.jsx'));
  repoStatus = await import(web('lib/repo-status.js'));
  SetupMod = await import(web('components/Setup.jsx'));
});

// ---- accessible names / radio group ------------------------------------------------

test('Field names its control: <label for> around a native select, aria-labelledby for switches and segmented groups', () => {
  const html = render(h(shared.Field, { label: 'Language' }, h('select', null, h('option', null, 'English'))));
  const id = html.match(/<select id="([^"]+)"/)[1];
  expect(html).toContain(`<label id="`);
  expect(html).toContain(`for="${id}"`);

  const seg = render(h(shared.Field, { label: 'Theme' }, h(shared.Segmented, { value: 'dark', onChange() {}, options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] })));
  const labelId = seg.match(/<div id="([^"]+)" class="text-sm font-medium text-fg">Theme/)[1];
  expect(seg).toContain(`role="radiogroup" aria-labelledby="${labelId}"`);

  const sw = render(h(shared.Field, { label: 'Notify me' }, h(shared.Toggle, { on: true, onChange() {} })));
  const swLabel = sw.match(/<div id="([^"]+)" class="text-sm font-medium text-fg">Notify me/)[1];
  expect(sw).toContain(`aria-labelledby="${swLabel}"`);
});

test('Segmented is one tab stop (the selected option) with radio semantics; arrows are wired', () => {
  const html = render(h(shared.Segmented, { label: 'Size', value: 'b', onChange() {}, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] }));
  expect(html).toContain('aria-label="Size"');
  expect((html.match(/tabindex="0"/g) || []).length).toBe(1);
  expect((html.match(/tabindex="-1"/g) || []).length).toBe(2);
  expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>B</);
  const src = read('components/settings/shared.jsx');
  expect(src).toContain("'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'");
  expect(src).toContain("direction === 'rtl'");
});

test('named controls: palette search, composer, agent form labels', () => {
  expect(read('components/QuickSwitcher.jsx')).toContain("aria-label={t('rail.searchSessionsCommands')}");
  expect(read('components/Composer.jsx')).toMatch(/data-composer\s+aria-label=/);
  for (const f of ['components/AgentView.jsx', 'components/AgentCard.jsx']) {
    const src = read(f);
    expect(src).toContain('useId()');
    expect(src).toMatch(/htmlFor=\{`\$\{uid\}-name`\}/);
    expect(src).toMatch(/id=\{`\$\{uid\}-name`\}/);
  }
});

test('composer popover: named dialog, radio groups with arrow keys, focus returns to the pill', () => {
  const src = read('components/ComposerPill.jsx');
  expect(src).toContain("aria-label={`${t('rail.model')} · ${t('rail.effort')} · ${t('rail.permissionMode')}`}");
  expect(src).toContain('role="radiogroup"');
  expect(src).toContain('role="radio"');
  expect(src).not.toContain('menuitemradio');
  expect(src).toContain("['ArrowDown', 'ArrowUp', 'Home', 'End']");
  expect(src).toContain('onCloseAutoFocus');
  expect(src).toContain('triggerRef');
});

// ---- GitHub picker recovery ------------------------------------------------------------

test('disconnected GitHub picker keeps its place with a Connect GitHub action (en + he)', () => {
  let html = render(h(Picker.GithubDisconnected));
  expect(html).toContain('data-repo-picker-disconnected');
  expect(html).toContain('Connect GitHub');
  expect(html).toContain('href="#/settings/connections/integrations"');
  prefs.setPrefs({ language: 'he' });
  html = render(h(Picker.GithubDisconnected));
  expect(html).toContain('התחברות ל־GitHub');
  prefs.setPrefs({ language: 'en' });
  // the picker returns it for no_token / bad_token instead of null
  expect(read('components/setup/RepoPicker.jsx')).toContain("problem?.code === 'no_token' || problem?.code === 'bad_token'");
});

// ---- request changes → pill ---------------------------------------------------------------

test('MergePill shows "Changes requested" once an approval was withdrawn, nothing after merge', () => {
  const s = (md) => ({ metadata: { branch: 'b', ...md } });
  expect(render(h(MergeCard.MergePill, { session: s({ review: { state: 'changes-requested' } }) }))).toContain('Changes requested');
  expect(render(h(MergeCard.MergePill, { session: s({ review: { state: 'approved' } }) }))).toContain('Approved');
  expect(render(h(MergeCard.MergePill, { session: s({ review: { state: 'changes-requested' }, merged: { sha: 'abc1234', base: 'main' } }) }))).not.toContain('Changes requested');
  expect(render(h(MergeCard.MergePill, { session: { metadata: { review: { state: 'changes-requested' } } } }))).toBe('');
});

// ---- bidi / markdown ------------------------------------------------------------------------

test('isolateRtlRuns: each Hebrew run is its own isolate, syntax stays outside', () => {
  const parts = Md.isolateRtlRuns('const label = "שלום 123"; // בדיקת קוד');
  expect(parts).toEqual(['const label = "', { rtl: 'שלום 123' }, '"; // ', { rtl: 'בדיקת קוד' }]);
  expect(Md.isolateRtlRuns('plain ascii')).toEqual(['plain ascii']);
  const html = render(h(Md.default, null, '```js\nconst a = "שלום"; // הערה\n```'));
  expect(html).toContain('<bdi>שלום</bdi>');
  expect(html).toContain('<bdi>הערה</bdi>');
});

test('skill/content markdown keeps list markers and tables sit on their own start edge', () => {
  const css = read('index.css');
  expect(css).toMatch(/\.md-light ul \{\s*list-style: disc;/);
  expect(css).toMatch(/\.md-light ol \{\s*list-style: decimal;/);
  expect(css).toMatch(/\.md-light table \{[^}]*margin-inline-end: auto;/);
});

test('artifact / screenshot metadata units and clock are isolated; context ratio is an LTR unit', () => {
  const art = read('components/ArtifactCard.jsx');
  expect(art).toContain('<bdi dir="ltr">v{event.version}</bdi>');
  expect(art).toContain('<bdi dir="ltr" className="text-xs text-[var(--term-faint)]">{clock(event.ts)}</bdi>');
  expect(read('components/ContextModal.jsx')).toContain('<bdi dir="ltr">{fmtTokens(used)} / {fmtTokens(win)}</bdi>');
  expect(read('components/settings/ChatTextSize.jsx')).toContain('<span dir="ltr">A+</span>');
});

test('card shell follows the UI direction, not the conversation', () => {
  const src = read('openui/primitives.jsx');
  expect(src).toContain('langDir(usePrefs().language)');
  expect(src).toMatch(/<div ref=\{ref\} dir=\{uiDir\}/);
});

// ---- settings find ------------------------------------------------------------------------------

test('findSettings: translated name or keyword, page + section, empty query → nothing', () => {
  const t = (k) => ({ 'settings.theme': 'Theme', 'settings.accent': 'Accent color', 'settings.pushTitle': 'Notifications' }[k] || k);
  expect(Find.findSettings('', t)).toEqual([]);
  const r = Find.findSettings('notif', t);
  expect(r[0]).toMatchObject({ cat: 'connections', section: 'notifications' });
  expect(Find.findSettings('dark', t).map((x) => x.key)).toContain('settings.theme');
  expect(Find.findSettings('zzzz', t)).toEqual([]);
  // every target section really exists on its page
  for (const [, cat, section] of Find.SETTINGS_INDEX) {
    const pages = { appearance: ['Appearance', 'MemoryLearning', 'Automation', 'Voice'], connections: ['Connections', 'Integrations', 'Channels', 'Accounts'], host: ['Host'], extensions: ['Extensions'] }[cat];
    const hit = pages.some((f) => fs.readFileSync(web(`components/settings/${f}.jsx`), 'utf8').match(new RegExp(`id=["{']${section}["}']`)));
    expect(hit).toBe(true);
  }
  const html = render(h(Find.default));
  expect(html).toContain('aria-label="Find a setting"');
});

test('General page: System/Light/Dark theme, chat theme "Follow app", accent in the main block', () => {
  const src = read('components/settings/Appearance.jsx');
  expect(src).toContain("value: 'system'");
  expect(src).toContain("settings.chatTheme.auto");
  const main = src.slice(0, src.indexOf('<Advanced'));
  expect(main).toContain("t('settings.accent')");
  expect(main).toContain('<ChatTextSize />');
  expect(src).toContain("GENERAL_ADVANCED_IDS = ['terminal'");
});

// ---- repo add wording -------------------------------------------------------------------------------

test('local sources say "copying", GitHub ones "downloading"; optional steps are not "blocked" noise', () => {
  expect(repoStatus.isLocalSource('/Users/me/app')).toBe(true);
  expect(repoStatus.isLocalSource('~/app')).toBe(true);
  expect(repoStatus.isLocalSource('C:\\src\\app')).toBe(true);
  expect(repoStatus.isLocalSource('acme/web')).toBe(false);
  expect(repoStatus.isLocalSource('https://github.com/acme/web')).toBe(false);
  expect(repoStatus.addOutcome({}, '/srv/app')).toBe('added-local');
  expect(repoStatus.addOutcome({}, 'acme/web')).toBe('added');
  expect(repoStatus.addOutcome({ existing: true, state: 'cloned' }, '/srv/app')).toBe('already');
  const t = (k) => ({ 'launcher.setup.detail.envNone': 'no env files needed', 'launcher.setup.detail.noInstall': 'nothing to install' }[k]);
  expect(SetupMod.stepDetail('envSource: none', t)).toBe('no env files needed');
  expect(SetupMod.stepDetail('no install step', t)).toBe('nothing to install');
  expect(SetupMod.stepDetail('pnpm install', t)).toBe('pnpm install');
  const src = read('components/Setup.jsx');
  expect(src).not.toMatch(/\+ \{t\('launcher\.setup\.addRepo'\)\}/);
});

// ---- contrast ---------------------------------------------------------------------------------------------

function oklch(L, C, hue) {
  const a = C * Math.cos((hue * Math.PI) / 180), b = C * Math.sin((hue * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((v) => Math.min(1, Math.max(0, v)));
}
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const tok = (css, block, name) => {
  const m = block.exec(css)[0].match(new RegExp(`${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`));
  return oklch(+m[1], +m[2], +m[3]);
};

test('muted/faint chat text reaches 4.5:1 on the chat and card surfaces in both themes; light focus ring ≥3:1', () => {
  const css = read('index.css');
  const dark = /\.term \{[^}]*\}/, light = /\.term-light \{[^}]*\}/;
  for (const name of ['term-faint', 'term-dim', 'term-accent-dim']) {
    expect(ratio(tok(css, dark, `--${name}`), tok(css, dark, '--term-bg'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tok(css, light, `--${name}`), tok(css, light, '--term-bg'))).toBeGreaterThanOrEqual(4.5);
  }
  // text on the "you" bubble / accent card (dark) and the tinted light surfaces
  expect(ratio(tok(css, dark, '--term-faint'), tok(css, dark, '--term-userbg'))).toBeGreaterThanOrEqual(4.5);
  expect(ratio(tok(css, light, '--term-faint'), tok(css, light, '--term-hover'))).toBeGreaterThanOrEqual(4.5);
  // light ring: the default mint #6eceb7 mixed 70/30 with black in oklab (L, a, b all scale by 0.7)
  const lin = [0x6e, 0xce, 0xb7].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const [r, g, bl] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl), s2 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
  const lab = [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s2, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s2, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s2].map((v) => v * 0.7);
  const [L, A, B] = lab;
  const l2 = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m2 = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s3 = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const ring = [4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s3, -1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s3, -0.0041960863 * l2 - 0.7034186147 * m2 + 1.707614701 * s3];
  expect(ratio(ring, [1, 1, 1])).toBeGreaterThanOrEqual(3);
  expect(ratio(lin, [1, 1, 1])).toBeLessThan(3); // the raw accent is what failed (1.9:1)
  expect(css).toMatch(/\[data-theme="dark"\] \{[^}]*--ring: var\(--color-brand\);/s);
});

test('diff line numbers use the muted text token, not the decorative faint one', () => {
  expect(read('components/DiffView.jsx')).toMatch(/text-end text-muted-foreground tabular-nums/);
});

// ---- phone targets -----------------------------------------------------------------------------------------------

test('44px hit areas: switch/checkbox pseudo-areas, text buttons get a coarse min width, refresh link', () => {
  expect(read('components/ui/switch.jsx')).toContain('after:-inset-x-[7px] after:-inset-y-[14px]');
  expect(read('components/ui/checkbox.jsx')).toContain('after:-inset-[15px]');
  const btn = read('components/ui/button.jsx');
  expect((btn.match(/coarse:min-w-11/g) || []).length).toBeGreaterThanOrEqual(8);
  expect(read('components/settings/shared.jsx')).toContain('coarse:min-h-11 coarse:min-w-11 coarse:justify-center');
  expect(read('components/ui/tabs.jsx')).toContain('coarse:h-11 coarse:min-w-11');
});

test('settings rows wrap on a phone and the composer row can shrink its pill (Send never clips)', () => {
  expect(read('components/settings/shared.jsx')).toMatch(/last:border-b-0 max-sm:flex-wrap \$\{/);
  expect(read('components/ComposerPill.jsx')).toContain('min-w-0 shrink gap-1.5');
  expect(read('components/Composer.jsx')).toContain('ms-auto flex shrink-0 items-center');
});

// ---- lazy chunks ----------------------------------------------------------------------------------------------------

test('heavy, rarely used parts are code-split: noVNC, highlighter, settings, launcher, skills, brain, agents, palette', () => {
  const app = read('App.jsx');
  for (const f of ['Settings', 'SkillsView', 'BrainView', 'AgentView', 'Setup', 'Wizard', 'Launcher', 'QuickSwitcher', 'ShortcutsHelp', 'ScreenModal']) {
    expect(app).not.toMatch(new RegExp(`^import ${f}\\b`, 'm'));
    expect(app).toMatch(new RegExp(`const ${f} = lazy\\(\\(\\) => import\\('./components/${f}.jsx'\\)\\)`));
  }
  expect(app).toContain('<Suspense fallback={<ViewFallback />}>{main}</Suspense>');
  expect(read('lib/useScreenConnection.js')).not.toMatch(/^import RFB/m);
  expect(read('lib/useScreenConnection.js')).toContain("import('@novnc/novnc')");
  expect(read('components/DiffView.jsx')).not.toMatch(/^import \{ highlightDiff \}/m);
  expect(read('components/DiffView.jsx')).toContain("import('../lib/highlight.js')");
});

// ---- reading controls ------------------------------------------------------------------------------------------------

test('the terminal gear carries the reading group: chat view, text size, direction, chat theme (values translated)', () => {
  const src = read('components/TermControls.jsx');
  expect(src).toContain('<ChatModeItems');
  expect(src).toContain('<ChatTextSizeSub />');
  expect(src).toContain("value={t(`common.${view.dir}`)}");
  expect(src).toContain("value={t(`common.${view.theme}`)}");
  expect(read('components/SessionView.jsx')).toContain('<ChatTextSizeSub />'); // still in the header "…" menu
});

test('Triggers and New agent show a visible label; Open in VS Code is a visible Changes button', () => {
  const rail = read('components/Rail.jsx');
  expect(rail).toContain("<Zap /> <span className=\"capitalize\">{t('rail.triggers')}</span>");
  expect(rail).toMatch(/<Plus \/> <span className="truncate">\{t\('rail\.teamNewAgent'\)/);
  expect(read('components/ChangesTab.jsx')).toContain('data-action="open-editor"');
});
