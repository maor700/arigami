// The host-health minute log: one parseable line per tick with the host's own numbers, rotated past its size cap.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { hostHealth, appendHealth } from '../server/lib/host-health.ts';
import { tmpDir } from './_tmp.js';

test('a reading carries the process numbers and the caller counts', () => {
  const h = hostHealth({ sessions: 3 }, true);
  expect(h.pid).toBe(process.pid);
  expect(h.rssMb).toBeGreaterThan(0);
  expect(h.heapUsedMb).toBeGreaterThanOrEqual(0);
  expect(h.counts).toEqual({ sessions: 3 });
  if (process.platform === 'linux') expect(h.fds).toBeGreaterThan(0);
  expect(h.topTypes?.length).toBeGreaterThan(0);
  expect(hostHealth().topTypes).toBeUndefined(); // the heap walk is opt-in
});

test('appendHealth writes JSON lines and keeps one rotated generation', () => {
  const file = path.join(tmpDir('host-health-'), 'logs', 'host-health.log');
  const max = 600;
  for (let i = 0; i < 12; i++) appendHealth(file, hostHealth({ i }), max);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  expect(lines.every((l) => typeof JSON.parse(l).rssMb === 'number')).toBe(true);
  expect(fs.statSync(file).size).toBeLessThan(max * 2);
  expect(fs.existsSync(file + '.1')).toBe(true);
  expect(fs.existsSync(file + '.2')).toBe(false);
});
