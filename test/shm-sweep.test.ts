// Desktops and SysV shared memory (server/lib/shm-sweep.ts): an x11vnc killed with SIGKILL leaves its ~42 segments in
// the kernel, and at kernel.shmmni no new desktop starts. The sweep removes only segments that are certainly garbage.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readSegments, orphanSegments } from '../server/lib/shm-sweep.ts';

const PROC = `       key      shmid perms                  size  cpid  lpid nattch   uid   gid  cuid  cgid      atime      dtime      ctime                   rss                  swap
         0     819284   600                  5120 2743460 2743453      2 1000 1000 1000 1000 1793259984          0 1793259984                  8192                     0
         0     819285   600               4096000 111 2743453      0 1000 1000 1000 1000 1793259984          0 1793250000               4096000                     0
  12345678     819286   600               4096000 111 2743453      0 1000 1000 1000 1000 1793259984          0 1793250000               4096000                     0
         0     819287   600               4096000 111 2743453      0 2000 2000 2000 2000 1793259984          0 1793250000               4096000                     0
         0     819288   600               4096000 222 2743453      0 1000 1000 1000 1000 1793259984          0 1793250000               4096000                     0
         0     819289   600               4096000 111 2743453      0 1000 1000 1000 1000 1793259984          0 1793259990               4096000                     0
`;

test('/proc/sysvipc/shm parses by its header', () => {
  const s = readSegments(PROC);
  expect(s.length).toBe(6);
  expect(s[0]).toEqual({ key: 0, id: 819284, cpid: 2743460, nattch: 2, uid: 1000, ctime: 1793259984 });
  expect(s[2].key).toBe(12345678);
  expect(readSegments('garbage\n1 2 3')).toEqual([]);
});

test('only ours, private, unattached, creator dead and old enough — never one in use', () => {
  const dead = orphanSegments(readSegments(PROC), { uid: 1000, nowSec: 1793260000, minAgeSec: 600, alive: (pid) => pid === 222 });
  // 819284 attached · 819286 has a key (someone may look it up) · 819287 another user's · 819288 creator alive · 819289 too new
  expect(dead.map((s) => s.id)).toEqual([819285]);
});

test('spawnDesktop checks the headroom first, retries without MIT-SHM when x11vnc found none, and says so', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dir, '../server/lib/desktops.ts'), 'utf8');
  expect(src).toContain('let shm = vncShmArgs();');
  expect(src).toMatch(/SHM_FAILED\.test\(tail\(\)\)[\s\S]{0,200}shm = \['-noshm'\]/);
  expect(src).toContain('throw vncFailure(e as Error, tail());');
  expect(src).toContain("x11vnc.on('exit', () => reapShmOf(x11vnc.pid));");
  expect(fs.readFileSync(path.resolve(import.meta.dir, '../server/index.ts'), 'utf8')).toContain('m.startShmSweeper()');
});
