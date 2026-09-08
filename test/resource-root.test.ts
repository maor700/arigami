// resourceRoot()'s three-way priority: ARIGAMI_ROOT env > compiled binary >
// dev fallback (fileURLToPath computation every call site used before this
// module existed). The module caches its result after the first call, so
// each branch runs in its own fresh process — see test/_child.js.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInChild } from './_child.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCE_ROOT_TS = path.join(ROOT, 'server', 'lib', 'resource-root.ts');

test('ARIGAMI_ROOT env wins over everything', () => {
  const r = runInChild(
    "const {resourceRoot}=await import('./server/lib/resource-root.ts');emit({root:resourceRoot()});",
    { ARIGAMI_ROOT: '/tmp/fake-resource-root' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].root).toBe('/tmp/fake-resource-root');
});

test('dev fallback resolves to the repo root — identical to the pre-refactor per-file computation', () => {
  const r = runInChild(
    "const {resourceRoot}=await import('./server/lib/resource-root.ts');emit({root:resourceRoot()});",
    { ARIGAMI_ROOT: '' }
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.out[0].root).toBe(ROOT);
  expect(fs.existsSync(path.join(r.out[0].root, 'package.json'))).toBe(true);
  expect(fs.existsSync(path.join(r.out[0].root, 'server'))).toBe(true);
});

test('inside a bun build --compile binary, resourceRoot() is <execDir>/resources', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-resource-root-'));
  try {
    const entry = path.join(tmp, 'entry.ts');
    fs.writeFileSync(
      entry,
      `import { resourceRoot } from ${JSON.stringify(RESOURCE_ROOT_TS)};\nconsole.log(resourceRoot());\n`
    );
    const outfile = path.join(tmp, 'testbin');
    const build = spawnSync('bun', ['build', '--compile', entry, '--outfile', outfile], {
      encoding: 'utf8',
      timeout: 60000,
    });
    if (build.status !== 0) throw new Error(`bun build --compile failed: ${build.stderr}`);

    const run = spawnSync(outfile, [], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, ARIGAMI_ROOT: '' },
    });
    if (run.status !== 0) throw new Error(`compiled binary failed: ${run.stderr}`);
    expect(run.stdout.trim()).toBe(path.join(tmp, 'resources'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
