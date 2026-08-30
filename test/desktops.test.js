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

// B4-lite / spec §7.3: the global :99 desktop autostart decision. Every probe is
// injected, so nothing is spawned; we only assert WHEN it would spawn and that
// the spawn wiring is the Xvfb → x11vnc pair on loopback.
import { ensureGlobalDesktop } from '../server/lib/desktops.ts';

const gd = (over = {}) =>
  ensureGlobalDesktop({
    isDefaultInstance: true,
    enabled: true,
    display: ':99',
    vncPort: 5900,
    vncHost: '127.0.0.1',
    which: (b) => (['Xvfb', 'x11vnc'].includes(b) ? `/usr/bin/${b}` : null),
    displayBusy: () => false,
    portBusy: async () => false,
    env: {},
    ...over,
  });

const linuxOnly = process.platform === 'linux' ? test : test.skip;

linuxOnly('global desktop: skipped for non-default instance, disabled screen, missing binaries, busy display/port, opt-out env', async () => {
  expect((await gd({ isDefaultInstance: false })).reason).toMatch(/non-default/);
  expect((await gd({ enabled: false })).reason).toMatch(/disabled/);
  expect((await gd({ which: () => null })).reason).toMatch(/Xvfb/);
  expect((await gd({ which: (b) => (b === 'Xvfb' ? '/usr/bin/Xvfb' : null) })).reason).toMatch(/x11vnc/);
  expect((await gd({ displayBusy: (n) => n === 99 })).reason).toMatch(/already up/);
  expect((await gd({ portBusy: async (p) => p === 5900 })).reason).toMatch(/in use/);
  expect((await gd({ env: { ARIGAMI_GLOBAL_DESKTOP: '0' } })).reason).toMatch(/ARIGAMI_GLOBAL_DESKTOP/);
  expect((await gd({ vncHost: '10.0.0.5' })).reason).toMatch(/remote/);
});

linuxOnly('global desktop: ARIGAMI_GLOBAL_DESKTOP=1 opts a non-default instance in (Docker: /data/.arigami)', async () => {
  // Past the instance check → the next probe (missing Xvfb) is what stops it.
  expect((await gd({ isDefaultInstance: false, env: { ARIGAMI_GLOBAL_DESKTOP: '1' }, which: () => null })).reason).toMatch(/Xvfb/);
});

linuxOnly('global desktop: when everything is free it spawns Xvfb :99 then x11vnc on loopback', async () => {
  const spawned = [];
  // Fake spawn: record args, and pretend the X socket appears / port opens by
  // pointing the probes at a temp path… the real waiters need a real socket, so
  // we only run the pre-spawn decision here and assert the first spawn.
  const fakeSpawn = (bin, args) => {
    spawned.push([bin, ...args]);
    // Return something that looks enough like a ChildProcess for supervise().
    return { pid: undefined, on: () => {}, stderr: { on() {} } };
  };
  // :987 so a real :99 on the test machine can't make the socket wait succeed.
  const r = await gd({ spawnFn: fakeSpawn, display: ':987', startTimeoutMs: 300 });
  // The X socket never appears (fake spawn) → reported as not started, but the
  // Xvfb invocation itself must be correct.
  expect(r.started).toBe(false);
  expect(r.reason).toMatch(/Xvfb did not come up/);
  expect(spawned[0]).toEqual(['/usr/bin/Xvfb', ':987', '-screen', '0', '1280x800x24', '-nolisten', 'tcp']);
});
