// F3 #5: every t('…') key used by the cockpit must exist in BOTH locales —
// a missing key renders raw (e.g. "SETTINGS.PUSHTITLE" under uppercase CSS).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'web/src');

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}
async function dict(lang) {
  const core = (await import(path.join(SRC, `locales/${lang}.js`)))[lang];
  let d = { ...core };
  for (const f of fs.readdirSync(path.join(SRC, `locales/${lang}`))) d = { ...d, ...(await import(path.join(SRC, `locales/${lang}`, f))).strings };
  return d;
}

test('every static t() key in web/src exists in en and he', async () => {
  const files = walk(SRC).filter((f) => /\.(jsx?|tsx?)$/.test(f) && !f.includes(`${path.sep}locales${path.sep}`) && !f.endsWith('lib/i18n.js'));
  const used = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1]);
  expect(used.size).toBeGreaterThan(500);
  const en = await dict('en');
  const he = await dict('he');
  const missing = [...used].filter((k) => !(k in en) || !(k in he)).sort();
  expect(missing).toEqual([]);
});
