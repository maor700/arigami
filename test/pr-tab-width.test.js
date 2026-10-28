// The PR tab (/__pr, server/pages.js + card.jsx) read edge to edge: the content
// filled the tab at every width. An unmerged 1280px cap (fix/pr-tab-width) could
// not help — the tab is the viewport minus the rail (1176px at 1440), so it never
// engaged. On a phone the stacked conversation column sized itself to its widest
// unbreakable line (540px in a 342px column) and ran off the screen.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const pages = fs.readFileSync(path.resolve(import.meta.dir, '../server/pages.js'), 'utf8');
const css = pages.slice(pages.indexOf('const TICKET_CSS = `'), pages.indexOf('`;', pages.indexOf('const TICKET_CSS = `')));

test('the PR page is a centred, readable column (GitHub container-lg), symmetric in LTR and RTL', () => {
  expect(css).toContain('.ghscroll>.gh{max-width:1012px;margin-inline:auto}');
});

test('stacked (≤900px) the conversation fills the column, long words and comment headers wrap', () => {
  expect(css).toMatch(/@media \(max-width:900px\)\{\.ghcols\{flex-direction:column-reverse;align-items:stretch\}/);
  expect(css).toMatch(/\.ghboxh\{display:flex;flex-wrap:wrap;/);
  expect(css).toMatch(/\.ghbody\{[^}]*overflow-wrap:break-word/);
  expect(css).toMatch(/\.ghtab\{[^}]*white-space:nowrap/);
});

test('phones (≤600px) get tighter padding and a smaller title', () => {
  expect(css).toMatch(/@media \(max-width:600px\)\{\.ghscroll\{padding:14px 12px 32px\}\.ghtitle\{font-size:20px\}\.ghtabs\{gap:0;overflow-x:auto/);
});

test('a url tab address is isolated LTR inside a Hebrew cockpit', () => {
  const sv = fs.readFileSync(path.resolve(import.meta.dir, '../web/src/components/SessionView.jsx'), 'utf8');
  expect(sv).toContain('<span dir="ltr">{tab.url}</span>');
});
