// Temp dirs in tests go through test/_tmp.js, nowhere else.
//
// The leak this pins: each test file made its own
// fs.mkdtempSync(path.join(os.tmpdir(), …)) and almost none removed it, so a
// session's TMPDIR collected thousands of dirs (9,482 / 5.3 GB on one host).
// The fix is structural — the preload points TMPDIR at a per-run root that is
// deleted at exit — and this keeps new tests on the helper, so a temp dir
// always has an owner.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir, tmpPath } from './_tmp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED = new Set(['_tmp.js', '_preload.ts', 'tmp-guard.test.ts']);
const BANNED = [/\bmkdtemp(?:Sync)?\s*\(/, /\btmpdir\s*\(\s*\)/];

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'fixtures') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no test creates a temp dir outside test/_tmp.js', () => {
  const offenders: string[] = [];
  for (const f of testFiles(HERE)) {
    if (ALLOWED.has(path.basename(f))) continue;
    fs.readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (BANNED.some((re) => re.test(line))) offenders.push(`${path.relative(HERE, f)}:${i + 1}: ${line.trim()}`);
      });
  }
  // Use tmpDir(prefix) / tmpPath(name) from './_tmp.js' instead.
  expect(offenders).toEqual([]);
});

test('the run has its own temp root, and the helper stays inside it', () => {
  const root = os.tmpdir();
  expect(path.basename(root)).toMatch(/^arigami-testrun-\d+-/);
  expect(process.env.TMPDIR).toBe(root);
  const d = tmpDir('guard-');
  expect(path.dirname(d)).toBe(root);
  expect(fs.readdirSync(d)).toEqual([]);
  expect(path.dirname(tmpPath('x'))).toBe(root);
});
