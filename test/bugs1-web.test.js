// BUGS1 (QA audit fixes) — web side, pure helpers.
//   B11: `/__host/?session=<id>` (the url create_session returns) must resolve to
//        the same route as `#/session/<id>`; the hash stays authoritative.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseHash, parseLocation, routeFromState, sessionFromSearch } = await import(path.join(ROOT, 'web/src/lib/route.js'));

test('B11: ?session=<id> resolves like #/session/<id>', () => {
  const viaHash = parseHash('#/session/sess_MMfEnwxx9YI');
  const viaQuery = parseLocation({ hash: '', search: '?session=sess_MMfEnwxx9YI' });
  expect(viaHash).toEqual({ view: 'session', id: 'sess_MMfEnwxx9YI' });
  expect(viaQuery).toMatchObject({ view: 'session', id: 'sess_MMfEnwxx9YI', fromQuery: true });
  // bare hashes (`#`, `#/`) still defer to the query
  expect(parseLocation({ hash: '#', search: '?session=sess_a' })).toMatchObject({ view: 'session', id: 'sess_a' });
  expect(parseLocation({ hash: '#/', search: '?session=sess_a' })).toMatchObject({ view: 'session', id: 'sess_a' });
  // encoded ids round-trip
  expect(parseLocation({ hash: '', search: '?session=' + encodeURIComponent('sess_x/y') }).id).toBe('sess_x/y');
  // and the canonical hash we rewrite to is the #/session form
  expect(routeFromState({ selectedId: 'sess_MMfEnwxx9YI' })).toBe('#/session/sess_MMfEnwxx9YI');
});

test('B11: the hash wins over the query; no query → plain hash routing', () => {
  expect(parseLocation({ hash: '#/session/sess_hash', search: '?session=sess_query' })).toEqual({ view: 'session', id: 'sess_hash' });
  expect(parseLocation({ hash: '#/settings/host', search: '?session=sess_query' })).toMatchObject({ view: 'settings', cat: 'host' });
  expect(parseLocation({ hash: '', search: '' })).toEqual({ view: 'home' });
  expect(parseLocation({ hash: '', search: '?foo=bar' })).toEqual({ view: 'home' });
  expect(parseLocation(undefined)).toEqual({ view: 'home' });
  expect(sessionFromSearch('?a=1&session=sess_z')).toBe('sess_z');
  expect(sessionFromSearch('')).toBe('');
});

// ---- B18 / B5 / B26 (components) ------------------------------------------
import fs from 'node:fs';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)
const src = (p) => fs.readFileSync(path.join(ROOT, 'web/src', p), 'utf8');

test('B18: diff code rows are forced LTR (the cockpit document is RTL in Hebrew)', async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'rtl' },
    querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'he-IL', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  const { renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js'));
  const prefs = await import(path.join(ROOT, 'web/src/lib/prefs.js'));
  prefs.setPrefs({ language: 'he' });
  const { DiffView } = await import(path.join(ROOT, 'web/src/components/DiffView.jsx'));
  const diff = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1,2 +1,2 @@', '-# audit repo', '+export const a = 1;', ' console.log(a);'].join('\n');
  for (const mode of ['split', 'inline']) {
    const html = render(React.createElement(DiffView, { diff, mode, path: 'a.js' }));
    expect(html).toContain('# audit repo');
    // every code row (and the hunk header) declares its own direction — and
    // the sign sits in the row, so it renders on the LEFT of the code
    const rows = html.match(/<div dir="ltr" class="[^"]*font-mono[^"]*"/g) || [];
    expect(rows.length).toBeGreaterThanOrEqual(4); // hunk + 3 lines (split: 5 cells)
    expect(html).toMatch(/dir="ltr"[^>]*>(?:(?!<\/div>).)*text-fgdim">-<\/span><span class="text-fg"># audit repo/);
    expect(html).not.toMatch(/<div class="[^"]*font-mono text-\[11px\][^"]*"[^>]*style="background/); // no row without dir
  }
});

test('B5: the rail scrolls the selected session row into view', () => {
  const rail = src('components/Rail.jsx');
  expect(rail).toContain('data-session-row={session.id}');
  expect(rail).toMatch(/querySelector\(`\[data-session-row="\$\{selectedId\}"\]`\)/);
  expect(rail).toContain("scrollIntoView({ block: 'nearest' })");
});

test('B26: phone-sized inputs are 16px (no iOS auto-zoom), desktop keeps the compact size', () => {
  const sv = src('components/SessionView.jsx');
  expect(sv).toMatch(/resize-none bg-transparent text-\[16px\][^"]*sm:text-\[11\.5px\]/);
  expect(sv).not.toMatch(/resize-none bg-transparent text-\[11\.5px\]/);
  const rail = src('components/Rail.jsx');
  expect(rail).toMatch(/flex-1 bg-transparent text-\[16px\] outline-none placeholder:text-fgdim sm:text-xs/);
});

// ---- LOW batch ---------------------------------------------------------------
test('B1/B7/B21/B31: known statuses get a locale label, custom ones pass through', async () => {
  const prefs = await import(path.join(ROOT, 'web/src/lib/prefs.js'));
  const { statusLabel } = await import(path.join(ROOT, 'web/src/lib/status.js'));
  prefs.setPrefs({ language: 'he' });
  expect(statusLabel('In Progress')).toBe('בעבודה');
  expect(statusLabel('Done')).toBe('הסתיים');
  expect(statusLabel('Approved')).toBe('מאושר');
  expect(statusLabel('idle')).toBe('ממתין');
  expect(statusLabel('waiting-on-child')).toBe('ממתין לסשן-ילד');
  expect(statusLabel('my custom status')).toBe('my custom status');
  expect(statusLabel('')).toBe('');
  expect(statusLabel(null)).toBe('');
  prefs.setPrefs({ language: 'en' });
  expect(statusLabel('In Progress')).toBe('In progress');
  // every surface that showed the raw string now goes through statusLabel
  expect(src('components/Rail.jsx')).toContain("statusLabel(session.status)");
  expect(src('components/Rail.jsx')).toContain('label={statusLabel(sec.label)}');
  expect(src('components/Rail.jsx')).toContain('[statusLabel(controller.status)');
  expect(src('components/SessionView.jsx')).toContain('statusLabel(session.status || cState)');
});

test('B4/B22: Hebrew gets a gap between number and unit; dates follow the UI language', async () => {
  const prefs = await import(path.join(ROOT, 'web/src/lib/prefs.js'));
  const tm = await import(path.join(ROOT, 'web/src/lib/time.js'));
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  prefs.setPrefs({ language: 'he' });
  expect(tm.relTime(ago(86))).toBe('1 שע');
  expect(tm.relTime(ago(12))).toBe('12 דק');
  expect(tm.untilTime(Date.now() + (86 * 60 + 5) * 1000)).toBe('1 שע 26 דק');
  expect(tm.dateLocale()).toBe('he-IL');
  const d = new Date(2026, 7, 30, 10, 38); // Aug 30 2026 10:38 local
  expect(tm.fmtDateTime(d)).toBe(d.toLocaleString('he-IL'));
  expect(tm.fmtDate(d)).toBe(d.toLocaleDateString('he-IL'));
  expect(tm.fmtDateTime('garbage')).toBe('');
  prefs.setPrefs({ language: 'en' });
  expect(tm.relTime(ago(86))).toBe('1h');
  expect(tm.untilTime(Date.now() + (86 * 60 + 5) * 1000)).toBe('1h 26m');
  expect(tm.fmtDateTime(d)).toBe(d.toLocaleString('en-US'));
  // the raw toLocaleString() calls are gone from the surfaces the audit listed
  for (const f of ['components/BrainView.jsx', 'components/Launcher.jsx', 'components/Rail.jsx', 'components/MergeCard.jsx', 'components/ChangesTab.jsx', 'components/settings/Automation.jsx', 'components/settings/Channels.jsx']) {
    expect(src(f)).not.toMatch(/\.toLocale(?:Date)?String\(\)/);
  }
});

test('B24: the skill page drops the YAML frontmatter before rendering', async () => {
  const { stripFrontmatter } = await import(path.join(ROOT, 'web/src/components/SkillsView.jsx'));
  expect(stripFrontmatter('---\nname: x\ndescription: JIT-setup playbook\ntriggers: a, b\n---\n# Title\nbody')).toBe('# Title\nbody');
  expect(stripFrontmatter('---\r\nname: x\r\n---\r\n# T')).toBe('# T');
  expect(stripFrontmatter('# no frontmatter\n---\nrule')).toBe('# no frontmatter\n---\nrule');
  expect(stripFrontmatter('')).toBe('');
  expect(stripFrontmatter(null)).toBe('');
});

test('B2/B3/B6/B9/B12/B13/B15/B27/B36: wiring', () => {
  expect(src('components/TabBar.jsx')).toContain("tab.title && tab.title !== 'Session' ? tab.title : t('rail.tabSession')");
  expect(src('locales/he/dialogs.js')).not.toContain('ניצול שנוצל');
  expect(src('locales/he/chat.js')).not.toContain('מקומט');
  expect(src('components/Launcher.jsx')).toMatch(/value=\{cwd\}\s+dir="ltr"/);
  expect(src('components/TabBar.jsx')).toMatch(/value=\{url\}\s+dir="ltr"/);
  expect(src('components/SessionView.jsx')).toContain("['he', t('rail.hebrew')]");
  expect(src('locales/he/rail.js')).toContain("'rail.hebrew': 'עברית'");
  expect(src('components/ScreenSidePanel.jsx')).toContain("status !== 'connected' && own !== false");
  expect(src('App.jsx')).toContain("if (ctx.railOpen) { e.preventDefault(); setRailOpen(false); return; }");
  expect(src('App.jsx')).toMatch(/useEffect\(\(\) => \{ setRailOpen\(false\); \}, \[selectedId/);
  expect(src('components/ChangesTab.jsx')).toContain("const noRepo = !loading && data?.emptyReason === 'no-repo';");
  expect(src('components/ChangesTab.jsx')).toContain('{!noRepo && <div className="flex overflow-hidden');
  expect(src('components/ChangesTab.jsx')).toContain('{noRepo ? null : desktop ? (');
  expect(src('components/Rail.jsx')).not.toContain("if (!kids.length) api.del(`/folders/");
  expect(src('components/Rail.jsx')).toContain("setFolderDialog({ type: 'delete', folder, kids: folderKids.get(folder.id) || [] })");
});
