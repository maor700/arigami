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
