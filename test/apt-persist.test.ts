// docker/apt-persist.sh: apt-installed packages survive a container restart (cache on the volume, replay at start).
// Uses the real dpkg-deb/dpkg-query of the test machine (Debian/Ubuntu); apt-get is a stub that records its args.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './_tmp.js';

const SCRIPT = path.resolve(import.meta.dir, '../docker/apt-persist.sh');
const hasDpkg = spawnSync('sh', ['-c', 'command -v dpkg-deb && command -v dpkg-query && dpkg-query -W bash']).status === 0;
const t = hasDpkg ? test : test.skip;
const arch = hasDpkg ? spawnSync('dpkg', ['--print-architecture'], { encoding: 'utf8' }).stdout.trim() : 'amd64';

function makeDeb(dir: string, pkg: string, a = 'all'): string {
  const root = path.join(dir, `build-${pkg}`);
  fs.mkdirSync(path.join(root, 'DEBIAN'), { recursive: true });
  fs.writeFileSync(path.join(root, 'DEBIAN', 'control'), `Package: ${pkg}\nVersion: 1.0\nArchitecture: ${a}\nMaintainer: t <t@example.invalid>\nDescription: t\n`);
  const out = path.join(dir, `${pkg}_1.0_${a}.deb`);
  spawnSync('dpkg-deb', ['--build', root, out], { stdio: 'ignore' });
  return out;
}

function setup() {
  const dir = tmpDir('arigami-apt-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'apt-get'), `#!/bin/sh\necho "$*" >> "${dir}/apt.log"\n[ -f "${dir}/apt.fail" ] && [ "$1" = install ] && { rm -f "${dir}/apt.fail"; exit 100; }\nexit 0\n`, { mode: 0o755 });
  const run = (mode: string, stdin = '') =>
    spawnSync('sh', [SCRIPT, mode], { input: stdin, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARIGAMI_APT_DIR: path.join(dir, 'apt') } });
  const debs = () => (fs.existsSync(path.join(dir, 'apt', 'debs')) ? fs.readdirSync(path.join(dir, 'apt', 'debs')).sort() : []);
  const aptLog = () => (fs.existsSync(path.join(dir, 'apt.log')) ? fs.readFileSync(path.join(dir, 'apt.log'), 'utf8').trim().split('\n') : []);
  return { dir, run, debs, aptLog };
}

t('cache keeps one deb per package+arch from the hook stdin; junk lines are ignored and never fail apt', () => {
  const { dir, run, debs } = setup();
  const a = makeDeb(dir, 'arigami-test-tool');
  const r = run('cache', `${a}\n/nonexistent.deb\n\n${a}\n`);
  expect(r.status).toBe(0);
  expect(debs()).toEqual(['arigami-test-tool_all.deb']);
});

t('prune drops debs whose package is not installed, keeps installed ones', () => {
  const { dir, run, debs } = setup();
  fs.mkdirSync(path.join(dir, 'apt', 'debs'), { recursive: true });
  for (const f of [`bash_${arch}.deb`, 'arigami-not-installed_all.deb']) fs.writeFileSync(path.join(dir, 'apt', 'debs', f), '');
  expect(run('prune').status).toBe(0);
  expect(debs()).toEqual([`bash_${arch}.deb`]);
});

t('replay installs only the missing packages, retries once after apt-get update, no-op on an empty cache', () => {
  const { dir, run, aptLog } = setup();
  expect(run('replay').stdout).toMatch(/nothing to reinstall/);
  const d = path.join(dir, 'apt', 'debs');
  fs.mkdirSync(d, { recursive: true });
  for (const f of [`bash_${arch}.deb`, 'arigami-missing_all.deb']) fs.writeFileSync(path.join(d, f), '');
  fs.writeFileSync(path.join(dir, 'apt.fail'), '');
  const r = run('replay');
  expect(r.status).toBe(0);
  expect(aptLog()).toEqual([`install -y --no-install-recommends ${d}/arigami-missing_all.deb`, 'update', `install -y --no-install-recommends ${d}/arigami-missing_all.deb`]);
});
