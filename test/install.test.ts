// Runs the bash smoke suite for install.sh (test/install.test.sh) under
// `bun test` so CI sees it. No root, no network, no packages installed.
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test('install.sh smoke tests (bash test/install.test.sh)', () => {
  const r = spawnSync('bash', [path.join(ROOT, 'test', 'install.test.sh')], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  expect(r.stdout).toContain('all install.sh tests passed');
});
