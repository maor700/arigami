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
const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8').replaceAll(':root,\n[data-theme="light"] {', ':root {'); // the light blocks also open a light chat-theme scope

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
// Tokens are oklch / color-mix(in oklab) expressions now: resolve them to sRGB hex.
// Scope = :root declarations, overridden by the [data-theme="dark"] block when dark.
const declsOf = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const oklabToRgb = ([L, a, b]) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.07674 * l - 3.30771 * m + 0.23097 * s, -1.26844 * l + 2.60976 * m - 0.34132 * s, -0.0042 * l - 0.70342 * m + 1.70761 * s];
  return lin.map((c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))));
};
const hexToRgb = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const toOklab = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [f(r), f(g), f(b)];
  const l = Math.cbrt(0.41222 * R + 0.53633 * G + 0.05145 * B), m = Math.cbrt(0.2119 * R + 0.6807 * G + 0.1074 * B), s = Math.cbrt(0.0883 * R + 0.28172 * G + 0.62998 * B);
  return [0.21045 * l + 0.79362 * m - 0.00407 * s, 1.978 * l - 2.42859 * m + 0.45059 * s, 0.0259 * l + 0.78277 * m - 0.80868 * s];
};
const resolveColor = (expr, scope) => {
  expr = expr.trim();
  let m;
  if ((m = expr.match(/^var\((--[\w-]+)\)$/))) return resolveColor(scope[m[1]], scope);
  if (expr.startsWith('#')) return hexToRgb(expr);
  if ((m = expr.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)/))) { const [L, C, H] = m.slice(1).map(Number); return oklabToRgb([L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)]); }
  if ((m = expr.match(/^color-mix\(in oklab,\s*(.+?)\s+(\d+)%,\s*(.+)\)$/))) {
    const p = Number(m[2]) / 100, A = toOklab(resolveColor(m[1], scope)), B = toOklab(resolveColor(m[3], scope));
    return oklabToRgb(A.map((v, i) => v * p + B[i] * (1 - p)));
  }
  throw new Error(`cannot resolve ${expr}`);
};
const hex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
const tokenIn = (body, name) => {
  const dark = body.includes('[data-theme') || /dark/.test(body.slice(0, 30));
  const scope = { ...declsOf(block(':root')), ...(dark ? declsOf(block('[data-theme="dark"]')) : {}) };
  return hex(resolveColor(`var(--hb-${name})`, scope));
};

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
  const hero = src.slice(src.indexOf('function MinimalHero'), src.indexOf('export default function Setup'))
    + fs.readFileSync(path.join(SRC, 'components/setup/EngineConnect.jsx'), 'utf8');
  // (text-[#1a1a1a] is the fixed dark ink every mint button uses)
  expect(hero.replaceAll('text-[#1a1a1a]', '')).not.toMatch(/\[#[0-9a-fA-F]{3,6}\]/);
  expect(hero).toContain('bg-ok');
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
