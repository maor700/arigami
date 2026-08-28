// T8 per-session desktops: the pure port→display allocator.
// desktops.ts imports state.js (side effects) → isolate in a child, same as
// screenshots.test.js.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function alloc(usedArr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-desktops-'));
  const r = runInChild(
    "const {allocatePort}=await import('./server/lib/desktops.ts');" +
      `emit(allocatePort(new Set(${JSON.stringify(usedArr)})));`,
    { ARIGAMI_DIR: dir }
  );
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}

test('allocatePort picks the first free port in range and derives the display from its offset', () => {
  expect(alloc([])).toEqual({ display: ':100', vncPort: 5901 });
  expect(alloc([5901])).toEqual({ display: ':101', vncPort: 5902 });
  expect(alloc([5901, 5902, 5904])).toEqual({ display: ':102', vncPort: 5903 });
});

test('allocatePort throws when the whole range is taken', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-desktops-'));
  const used = Array.from({ length: 50 }, (_, i) => 5901 + i); // full default range
  const r = runInChild(
    "const {allocatePort}=await import('./server/lib/desktops.ts');" +
      `emit(allocatePort(new Set(${JSON.stringify(used)})));`,
    { ARIGAMI_DIR: dir }
  );
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/exhausted/);
});
