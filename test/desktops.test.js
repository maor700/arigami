// T8 per-session desktops: the pure port→display allocator, plus the T5
// real-occupancy probes (display lock / busy port) and the non-default
// instance shift. desktops.ts imports state.js (side effects) → isolate in a
// child, same as screenshots.test.js.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInChild } from './_child.js';

function inChild(body, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arigami-desktops-'));
  return runInChild("const {allocatePort}=await import('./server/lib/desktops.ts');" + body, {
    ARIGAMI_DIR: dir,
    ARIGAMI_PORT: '',
    ...env,
  });
}
function alloc(usedArr, opts = '{}') {
  const r = inChild(`emit(allocatePort(new Set(${JSON.stringify(usedArr)}), ${opts}));`);
  if (!r.ok) throw new Error(r.error);
  return r.out[0];
}
// A tmp ARIGAMI_DIR is a NON-default instance → default ranges are shifted
// (+1000 ports, +100 displays). The explicit-range form pins the classic values.
const CLASSIC = '{range:[5901,5950],displayBase:100,displayBusy:()=>false}';

test('allocatePort picks the first free port in range and derives the display from its offset', () => {
  expect(alloc([], CLASSIC)).toEqual({ display: ':100', vncPort: 5901 });
  expect(alloc([5901], CLASSIC)).toEqual({ display: ':101', vncPort: 5902 });
  expect(alloc([5901, 5902, 5904], CLASSIC)).toEqual({ display: ':102', vncPort: 5903 });
});

test('a non-default ARIGAMI_DIR shifts the default range to 6901+/:200+ (T5 §3)', () => {
  expect(alloc([], '{displayBusy:()=>false}')).toEqual({ display: ':200', vncPort: 6901 });
});

test('a display with an X lock, or a port a probe reports busy, is skipped even if unclaimed by us', () => {
  expect(alloc([], '{range:[5901,5950],displayBase:100,displayBusy:(n)=>n===100}')).toEqual({ display: ':101', vncPort: 5902 });
  expect(alloc([], '{range:[5901,5950],displayBase:100,displayBusy:()=>false,portBusy:(p)=>p<5904}')).toEqual({ display: ':103', vncPort: 5904 });
});

test('displayLocked reads /tmp/.X<n>-lock', () => {
  const r = inChild(
    "const {displayLocked}=await import('./server/lib/desktops.ts');" +
      'emit({free:displayLocked(63999), locked:displayLocked(0) || require("node:fs").existsSync("/tmp/.X0-lock")===false});'
  );
  expect(r.ok).toBe(true);
  expect(r.out[0].free).toBe(false);
});

test('allocatePort throws when the whole range is taken', () => {
  const used = Array.from({ length: 50 }, (_, i) => 5901 + i); // full classic range
  const r = inChild(`emit(allocatePort(new Set(${JSON.stringify(used)}), ${CLASSIC}));`);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/exhausted/);
});
