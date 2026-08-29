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
