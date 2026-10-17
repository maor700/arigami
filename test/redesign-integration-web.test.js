// Integration guards for the merged redesign: one source of truth for
// model/effort/permission, DiffCard on the shared diff tokens, accent budget.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(ROOT, 'web/src', p), 'utf8');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'locales') walk(p, out); } else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

test('the header gear shows ONE row for model/effort/permissions while a composer pill is mounted', () => {
  const tc = src('components/TermControls.jsx');
  expect(tc).toContain('useComposerPillMounted');
  expect(tc).toContain('data-term-open-pill');
  expect(tc).toContain('{!pillOwns && <MenuRow label={t(\'rail.model\')}');
  expect(tc).toContain('{!pillOwns && <MenuRow label={t(\'rail.effort\')}');
  expect(src('components/ComposerPill.jsx')).toContain('registerComposerPill');
});

test('composerPill registry counts mounted pills', async () => {
  const m = await import(path.join(ROOT, 'web/src/lib/composerPill.js'));
  expect(m.composerPillMounted()).toBe(false);
  const un = m.registerComposerPill();
  expect(m.composerPillMounted()).toBe(true);
  un();
  expect(m.composerPillMounted()).toBe(false);
});

test('chat DiffCard uses the same diff tokens as the Changes diff', () => {
  const card = src('components/DiffCard.jsx');
  for (const t of ['--diff-add-bg', '--diff-del-bg', '--diff-gap-bg', '--diff-add-mark', '--diff-del-mark']) expect(card).toContain(t);
  expect(card).not.toMatch(/color-mix\(in oklab, var\(--hb-(ok|err)\)/);
  const view = src('components/DiffView.jsx');
  for (const t of ['--diff-add-bg', '--diff-del-bg', '--diff-add-mark', '--diff-del-mark']) expect(view).toContain(t);
});

test('accent budget: no mint fills / text / borders outside logo, wizard logo bars and the style guide', () => {
  const allowed = new Set(['components/Logo.jsx', 'components/Wizard.jsx', 'components/StyleGuide.jsx']);
  const bad = [];
  for (const f of walk(path.join(ROOT, 'web/src'))) {
    const rel = path.relative(path.join(ROOT, 'web/src'), f);
    if (allowed.has(rel) || rel.startsWith('components/ui/')) continue;
    const s = fs.readFileSync(f, 'utf8');
    const m = s.match(/\b(bg|text|border|ring|fill|stroke)-brand\b/g);
    if (m) bad.push(`${rel}: ${m.join(' ')}`);
  }
  expect(bad).toEqual([]);
});

// The composer wears the chat's theme, not the app's: a dark transcript must not sit on a light footer.
test('both chat footers are wrapped in ChatThemeScope, which re-resolves tokens with the session chat theme', () => {
  const sv = src('components/SessionView.jsx');
  expect(sv).toMatch(/function ChatThemeScope[\s\S]*termViewFrom\(prefs, sessionId\)\.theme[\s\S]*data-theme=\{theme\}/);
  const wrapped = sv.match(/<ChatThemeScope sessionId=\{session\.id\}>\s*\{session\.archived \? <ArchivedFooter session=\{session\} \/> : <ChatFooter session=\{session\} \/>\}\s*<\/ChatThemeScope>/g) || [];
  expect(wrapped.length).toBe(2);
  // no bare footer left
  expect(sv.replace(/<ChatThemeScope[\s\S]*?<\/ChatThemeScope>/g, '')).not.toContain('<ChatFooter');
});

// `--color-*` / shadcn tokens are aliases resolved on :root; a nested [data-theme] only re-resolves them if the alias
// lines are re-declared on the scope (verified in a real browser: dark panel inside a light page).
test('index.css re-declares the alias tokens on the chat theme scope', () => {
  const css = src('index.css');
  const scope = css.slice(css.indexOf('[data-chat-theme-scope] {'));
  expect(scope).toContain('--color-panel: var(--hb-panel)');
  expect(scope).toContain('--color-bg: var(--hb-bg)');
  expect(scope).toContain('--background: var(--hb-bg)');
  expect(scope).toContain('[data-chat-theme-scope][data-theme="dark"]');
});

test('the composer text takes the chat theme colour, not the root one', () => {
  const css = src('index.css');
  expect(css.slice(css.indexOf('[data-chat-theme-scope] {'))).toContain('color: var(--hb-fg)');
  expect(src('components/Composer.jsx')).toMatch(/bg-transparent text-foreground \[unicode-bidi:plaintext\]/);
});
