// Redesign foundation: the shadcn token bridge (every variable the ui/ kit
// reads is defined in light AND dark), the Direction provider wiring, and the
// ui/ Button + menu components (SSR).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from './_isolate.js';
isolate();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => path.join(ROOT, 'web/src', p);
const css = fs.readFileSync(web('index.css'), 'utf8');

// the declarations of every rule whose selector is exactly `sel`
const decls = (sel) => {
  let out = '';
  const re = new RegExp(`(^|\\n)${sel.replace(/[[\]().*+?^$|]/g, '\\$&')}\\s*\\{`, 'g');
  for (const m of css.matchAll(re)) {
    const start = m.index + m[0].length;
    out += css.slice(start, css.indexOf('\n}', start)) + '\n';
  }
  return out;
};
const defines = (body, name) => new RegExp(`${name.replace(/[-]/g, '\\-')}\\s*:`).test(body);

const SHADCN = [
  '--background', '--foreground', '--card', '--card-foreground', '--popover', '--popover-foreground', '--primary',
  '--primary-foreground', '--secondary', '--secondary-foreground', '--muted', '--muted-foreground', '--accent',
  '--accent-foreground', '--destructive', '--border', '--input', '--ring', '--radius',
];
// values that must be re-declared per theme (the rest are aliases that flip through them)
const THEMED = ['--hb-bg', '--hb-panel', '--hb-fg', '--hb-fgdim', '--hb-hair', '--hb-border', '--hb-hover', '--hb-ok', '--hb-warn', '--hb-err', '--hb-info'];

test('token bridge: every shadcn variable is defined for light (:root)', () => {
  const root = decls(':root');
  for (const v of SHADCN) expect({ v, ok: defines(root, v) }).toEqual({ v, ok: true });
});

test('token bridge: every shadcn variable resolves in dark (aliases flip through re-declared --hb-*)', () => {
  const root = decls(':root');
  const dark = decls('[data-theme="dark"]');
  for (const v of SHADCN) {
    // each alias must point at a --hb-* / token that dark redefines, or itself be redefined for dark
    const m = root.match(new RegExp(`${v}:\\s*var\\((--[\\w-]+)\\)`));
    if (v === '--radius') continue; // geometry, theme-independent
    expect({ v, ok: defines(dark, v) || (m && (defines(dark, m[1]) || ['--accent-fill', '--color-brand', '--on-accent'].includes(m[1]))) }).toEqual({ v, ok: true });
  }
  for (const v of THEMED) expect({ v, light: defines(root, v), dark: defines(dark, v) }).toEqual({ v, light: true, dark: true });
});

test('token bridge: legacy names keep working (--hb-*, --color-* utilities, --term-*)', () => {
  for (const n of ['bg', 'panel', 'fg', 'fgdim', 'border', 'rail', 'hair', 'chip', 'fg2', 'sel', 'ok-bg', 'warn-line', 'err', 'info-bg', 'violet-line', 'suggest', 'suggest-label'])
    expect({ n, ok: css.includes(`--hb-${n}:`) }).toEqual({ n, ok: true });
  for (const n of ['brand', 'ink', 'chip', 'hair', 'bg', 'panel', 'fg', 'fgdim', 'border', 'fg2', 'sel', 'rail', 'danger', 'ok', 'err-bg', 'term', 'diffadd', 'diffdel'])
    expect({ n, ok: css.includes(`--color-${n}:`) }).toEqual({ n, ok: true });
  expect(css).toContain('--color-brand: #6eceb7'); // default accent stays mint; prefs.accent overrides it
  for (const n of ['bg', 'fg', 'dim', 'border', 'userbg', 'codebg', 'hover', 'accent-bg']) expect(css).toContain(`--term-${n}:`);
});

test('type scale, radii and the legacy neutralisers exist', () => {
  for (const n of ['2xs', 'xs', 'sm', 'base', 'lg', 'xl']) expect(css).toContain(`--text-${n}:`);
  for (const n of ['sm', 'md', 'lg', 'xl']) expect(css).toContain(`--radius-${n}:`);
  expect(css).toContain('prefers-reduced-motion: reduce');
  expect(css).toMatch(/\.border-2,/);
  expect(css).toContain('[class*="px_0_"]');
});

let React, render, prefs, ui;
const h = (...a) => React.createElement(...a);

beforeAll(async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.window = globalThis;
  globalThis.location = { origin: 'http://host.test', port: '', pathname: '/', hash: '' };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {} }, dir: 'ltr' },
    body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  globalThis.navigator = { language: 'en-US', userAgent: 'test' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  React = (await import(path.join(ROOT, 'web/node_modules/react/index.js'))).default;
  ({ renderToStaticMarkup: render } = await import(path.join(ROOT, 'web/node_modules/react-dom/server.js')));
  prefs = await import(web('lib/prefs.js'));
  ui = {
    ...(await import(web('components/ui/button.jsx'))),
    ...(await import(web('components/ui/direction.jsx'))),
    ...(await import(web('components/ui/dropdown-menu.jsx'))),
    ...(await import(web('components/ui/badge.jsx'))),
    ...(await import(web('components/ui/tooltip.jsx'))),
    ...(await import(web('components/ui.jsx'))),
  };
});
afterAll(() => {});

test('Direction provider is fed by the app language (set explicitly: he → rtl, en → ltr)', () => {
  const Probe = () => h('span', { 'data-dir': ui.useDirection() });
  prefs.setPrefs({ language: 'he' });
  expect(render(h(ui.AppDirection, null, h(Probe)))).toContain('data-dir="rtl"');
  prefs.setPrefs({ language: 'en' });
  expect(render(h(ui.AppDirection, null, h(Probe)))).toContain('data-dir="ltr"');
  // an explicit dir wins (style guide / tests)
  expect(render(h(ui.AppDirection, { dir: 'rtl' }, h(Probe)))).toContain('data-dir="rtl"');
  // UiProvider mounts the same provider plus tooltips
  prefs.setPrefs({ language: 'he' });
  expect(render(h(ui.UiProvider, null, h(Probe)))).toContain('data-dir="rtl"');
  prefs.setPrefs({ language: 'en' });
});

test('Button: neutral default, accent only for variant=primary, 44px touch sizes, type=button', () => {
  const def = render(h(ui.Button, null, 'Save'));
  expect(def).toContain('type="button"');
  expect(def).toContain('bg-card');
  expect(def).not.toContain('bg-primary');
  const prim = render(h(ui.Button, { variant: 'primary' }, 'Go'));
  expect(prim).toContain('bg-primary');
  expect(prim).toContain('data-variant="primary"');
  for (const size of ['default', 'sm', 'icon', 'icon-sm']) expect(render(h(ui.Button, { size }, 'x'))).toContain('coarse:min-h-11');
  expect(render(h(ui.Button, { size: 'touch' }, 'x'))).toContain('h-11');
  expect(render(h(ui.Button, { size: 'icon-touch' }, 'x'))).toContain('size-11');
  // className wins over the variant (tailwind-merge)
  expect(render(h(ui.Button, { className: 'px-9' }, 'x'))).toContain('px-9');
  expect(render(h(ui.Button, { className: 'px-9' }, 'x'))).not.toContain('px-3');
});

test('legacy YellowButton / GhostButton are thin wrappers over ui/Button', () => {
  const y = render(h(ui.YellowButton, { onClick() {} }, 'Start'));
  expect(y).toContain('data-slot="button"');
  expect(y).toContain('data-variant="primary"');
  expect(y).not.toContain('border-ink');
  expect(y).not.toContain('shadow-[2px');
  expect(render(h(ui.GhostButton, null, 'Cancel'))).toContain('data-variant="outline"');
});

test('Badge: neutral chip, colour only in the dot', () => {
  const b = render(h(ui.Badge, { status: 'warn' }, 'Needs you'));
  expect(b).toContain('bg-muted');
  expect(b).toContain('bg-warn');
  expect(b).toContain('Needs you');
  expect(render(h(ui.Badge, null, 'Plain'))).not.toContain('data-slot="status-dot"');
});

test('DropdownMenu: renders its trigger with RTL-aware, 44px-touch item classes available', () => {
  const html = render(h(ui.UiProvider, { dir: 'rtl' }, h(ui.DropdownMenu, null, h(ui.DropdownMenuTrigger, { asChild: true }, h(ui.Button, { variant: 'ghost', size: 'icon-sm', 'aria-label': 'More' }, '…')), h(ui.DropdownMenuContent, null, h(ui.DropdownMenuItem, null, 'Rename')))));
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('aria-label="More"');
  expect(html).toContain('data-slot="dropdown-menu-trigger"');
  // menu surface/item styles carry the touch + RTL rules (they render in a portal when open)
  const src = fs.readFileSync(web('components/ui/_menu.jsx'), 'utf8');
  expect(src).toContain('coarse:min-h-11');
  expect(src).toContain('rtl:rotate-180');
  expect(src).toContain('ps-8');
});

test('every ui/ file wraps its parts with forwardRef (React 18 + Radix asChild)', () => {
  const dir = web('components/ui');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsx') && !['direction.jsx', 'toast.jsx'].includes(x))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // no React-19 style `function X({ ref })` components
    expect({ f, ref19: /function \w+\([^)]*\bref\b[^)]*\)\s*\{/.test(src.replace(/forwardRef\(function/g, '')) }).toEqual({ f, ref19: false });
  }
});
