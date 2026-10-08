// Dark-theme cards: a box that hardcodes a pastel fill (bg-[#FBF3E0], bg-white)
// stays cream in the dark theme while its headings follow text-fg — near-white
// on cream, 1.09:1, the "Connect an engine" card in the setup hero. Status
// boxes use the themed tone tokens in index.css (ok / warn / err / info /
// violet, each with -bg and -line) instead; these checks keep it that way.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'web/src');
const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

const sources = (dir = SRC) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return sources(p);
    return /\.(jsx?|tsx?)$/.test(d.name) ? [p] : [];
  });

const luminance = (hex) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// The block a selector opens, e.g. `:root {` or `[data-theme="dark"] {`.
const block = (selector) => {
  const i = css.indexOf(`${selector} {`);
  return css.slice(i, css.indexOf('}', i));
};
const tokenIn = (body, name) => body.match(new RegExp(`--hb-${name}:\\s*(#[0-9a-fA-F]{3,6})`))?.[1];

test('no light hardcoded background in any className (it stays light in the dark theme)', () => {
  const offenders = [];
  for (const file of sources()) {
    const rel = path.relative(SRC, file);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(?<![\w-])(?:hover:)?bg-\[(#[0-9a-fA-F]{3,6})\](?:\/(\d+))?/g)) {
        const alpha = m[2] ? Number(m[2]) / 100 : 1;
        if (alpha > 0.5 && luminance(m[1]) > 0.5) offenders.push(`${rel}:${i + 1} ${m[0]}`);
      }
      // bg-white is fine where white is the content's own canvas: logos, the QR
      // code, iframes of foreign documents, and toggle knobs.
      if (/(?<![\w-:])bg-white(?![\w/-])/.test(line) && !/<img|object-contain|border-0 bg-white|rounded-full[^'"`]*bg-white|bg-white[^'"`]*rounded-full/.test(line))
        offenders.push(`${rel}:${i + 1} bg-white`);
    });
  }
  expect(offenders).toEqual([]);
});

test('mint buttons carry dark ink, not text-fg (near-white on mint in the dark theme)', () => {
  const offenders = [];
  for (const file of sources()) {
    const rel = path.relative(SRC, file);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const cls of line.match(/(['"`])[^'"`]*\1/g) || []) {
        if (/(?<![\w:-])bg-brand(?![\w/-])/.test(cls) && /(?<![\w:-])text-fg(?![\w-])/.test(cls)) offenders.push(`${rel}:${i + 1}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});

test('the setup hero and its engine cards use theme tokens only', () => {
  const src = fs.readFileSync(path.join(SRC, 'components/Setup.jsx'), 'utf8');
  const hero = src.slice(src.indexOf('function EngineCard'), src.indexOf('export default function Setup'));
  // (text-[#1a1a1a] is the fixed dark ink every mint button uses)
  expect(hero.replaceAll('text-[#1a1a1a]', '')).not.toMatch(/\[#[0-9a-fA-F]{3,6}\]/);
  expect(hero).toContain('bg-warn-bg');
  expect(hero).toContain('bg-ok-bg');
});

test('every tone token flips under the dark theme and stays readable in both', () => {
  const light = block(':root');
  const dark = block('[data-theme="dark"]');
  const panel = { light: tokenIn(light, 'panel'), dark: tokenIn(dark, 'panel') };
  for (const tone of ['ok', 'warn', 'err', 'info', 'violet']) {
    for (const [name, body] of [['light', light], ['dark', dark]]) {
      const fg = tokenIn(body, tone), bg = tokenIn(body, `${tone}-bg`), line = tokenIn(body, `${tone}-line`);
      expect([tone, name, !!fg, !!bg, !!line]).toEqual([tone, name, true, true, true]);
      // tone text is used both on its own tinted fill and on the plain panel
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fg, panel[name])).toBeGreaterThanOrEqual(4.5);
      // body text (text-fg) on the tinted fill — the bug this file is about
      expect(contrast(tokenIn(body, 'fg'), bg)).toBeGreaterThanOrEqual(7);
    }
    expect(css).toContain(`--color-${tone}-bg: var(--hb-${tone}-bg)`);
  }
});
