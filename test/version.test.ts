// B4-lite: server/version.ts — parse helpers + a real read against a scratch repo.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseLeftRight, getVersion, invalidateVersion } from '../server/version.ts';

test('parseLeftRight', () => {
  expect(parseLeftRight(null)).toEqual({ behind: null, ahead: null });
  expect(parseLeftRight('garbage')).toEqual({ behind: null, ahead: null });
  expect(parseLeftRight('0\t3')).toEqual({ behind: 0, ahead: 3 });
  expect(parseLeftRight('2 0\n')).toEqual({ behind: 2, ahead: 0 });
});

test('getVersion on a repo with an upstream that is 2 commits ahead', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ver-'));
  const up = path.join(base, 'up');
  const local = path.join(base, 'local');
  const g = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  fs.mkdirSync(up);
  g(up, 'init', '-q', '-b', 'main'); g(up, 'config', 'user.email', 't@example.invalid'); g(up, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(up, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  g(up, 'add', '.'); g(up, 'commit', '-q', '-m', 'one');
  g(base, 'clone', '-q', up, local);
  g(local, 'config', 'user.email', 't@example.invalid'); g(local, 'config', 'user.name', 't');
  for (const n of ['two', 'three']) { fs.writeFileSync(path.join(up, n), n); g(up, 'add', '.'); g(up, 'commit', '-q', '-m', n); }

  invalidateVersion();
  const before = await getVersion({ root: local });
  expect(before.version).toBe('9.8.7');
  expect(before.commit).toBe(g(local, 'rev-parse', '--short', 'HEAD'));
  expect(before.branch).toBe('main');
  expect(before.upstream).toBe('origin/main');
  expect(before.ahead).toBe(0); // not fetched yet
  expect(before.updateAvailable).toBe(false);

  const after = await getVersion({ root: local, refresh: true });
  expect(after.ahead).toBe(2);
  expect(after.behind).toBe(0);
  expect(after.updateAvailable).toBe(true);
  expect(after.fetchedAt).toBeGreaterThan(0);

  // cached: same object within the TTL
  expect(await getVersion({ root: local })).toBe(after);
  invalidateVersion();
});

// VER1: currentVersion (VERSION file wins), compareVersions, and the
// "available" side — the upstream tip's package.json + newest v* tag — plus
// sharedBase=false when the two histories have no merge base (the realign case).
import { currentVersion, compareVersions } from '../server/version.ts';
import { isolate } from './_isolate.js';
isolate(); // restore globalThis/process.env after this file (bun test shares them)

test('currentVersion: VERSION file over package.json; compareVersions', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-cv-'));
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  expect(currentVersion(d)).toBe('1.0.0');
  fs.writeFileSync(path.join(d, 'VERSION'), '1.0.1\n');
  expect(currentVersion(d)).toBe('1.0.1');
  fs.writeFileSync(path.join(d, 'VERSION'), 'garbage\n');
  expect(currentVersion(d)).toBe('1.0.0');
  expect(compareVersions('0.1.0', '0.1.1')).toBe(-1);
  expect(compareVersions('v0.2.0', '0.1.9')).toBe(1);
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(0);
  expect(compareVersions(null, '1.0.0')).toBeNull();
});

test('getVersion: available version/tag from upstream, sharedBase false once the histories diverge without a base', async () => {
  process.env.ARIGAMI_NO_RELEASE_CHECK = '1';
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-ver2-'));
  const up = path.join(base, 'up');
  const local = path.join(base, 'local');
  const g = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  fs.mkdirSync(up);
  g(up, 'init', '-q', '-b', 'main'); g(up, 'config', 'user.email', 't@example.invalid'); g(up, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(up, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  fs.writeFileSync(path.join(up, 'VERSION'), '0.1.0\n');
  g(up, 'add', '.'); g(up, 'commit', '-q', '-m', 'one'); g(up, 'tag', 'v0.1.0');
  g(base, 'clone', '-q', up, local);
  g(local, 'config', 'user.email', 't@example.invalid'); g(local, 'config', 'user.name', 't');
  // upstream releases 0.2.0
  fs.writeFileSync(path.join(up, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  fs.writeFileSync(path.join(up, 'VERSION'), '0.2.0\n');
  g(up, 'add', '.'); g(up, 'commit', '-q', '-m', 'chore(release): v0.2.0'); g(up, 'tag', 'v0.2.0');

  invalidateVersion();
  const before = await getVersion({ root: local });
  expect(before.version).toBe('0.1.0');
  expect(before.tag).toBe('v0.1.0');
  expect(before.available).toEqual({ version: '0.1.0', tag: 'v0.1.0', release: null });
  expect(before.sharedBase).toBe(true);
  expect(before.updateAvailable).toBe(false);

  const after = await getVersion({ root: local, refresh: true });
  expect(after.ahead).toBe(1);
  expect(after.available.version).toBe('0.2.0');
  expect(after.available.tag).toBe('v0.2.0');
  expect(after.updateAvailable).toBe(true);
  expect(after.sharedBase).toBe(true);

  // the realign case: local history rewritten from scratch, still tracking origin/main
  g(local, 'checkout', '-q', '--orphan', 'fresh');
  g(local, 'commit', '-q', '-m', 'rewritten root');
  g(local, 'branch', '-q', '--set-upstream-to=origin/main');
  invalidateVersion();
  const apart = await getVersion({ root: local });
  expect(apart.sharedBase).toBe(false);
  expect(apart.ahead).toBe(2);
  expect(apart.behind).toBe(1);
  invalidateVersion();
});
