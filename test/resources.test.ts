// Machine resources (server/lib/resources.ts) — the parts an agent acts on.
//
// The sampler itself is platform-dependent and is exercised live; what is
// tested here is the judgement built on top of it, because that is where a
// wrong answer changes what a session DOES: refuse to work, or pile onto a
// machine that is already dying.
import { test, expect } from 'bun:test';
import {
  verdict, judgeHostLoad, wasMeasured, sample, primeCpu,
  parseMemAvailableMb, parseSwap, parseVmStatMb, parsePsTable, parseWinProcCsv,
} from '../server/lib/resources.ts';

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

test('verdict: blindness is not idleness — unknowns never raise pressure', () => {
  // The failure this guards: os.loadavg() is [0,0,0] on Windows and
  // os.freemem() understates by gigabytes on Linux/macOS. If "I could not
  // measure it" leaked through as 0, a session would read a pinned machine as
  // free. Unknown has to mean unknown.
  expect(verdict({ cpuPct: null, memUsedPct: null, diskUsedPct: null }).pressure).toBe('ok');
  // …and the inverse: one unknown must not mask a real signal from another.
  expect(verdict({ cpuPct: 99, memUsedPct: null, diskUsedPct: null }).pressure).toBe('critical');
  expect(verdict({ cpuPct: null, memUsedPct: 99, diskUsedPct: null }).pressure).toBe('critical');
});

test('verdict: the worst signal wins, and every reason is named', () => {
  const v = verdict({ cpuPct: 80, memUsedPct: 95, diskUsedPct: 10 });
  expect(v.pressure).toBe('critical'); // memory is critical even though CPU is only busy
  expect(v.why).toContain('CPU 80%');
  expect(v.why).toContain('memory 95%');
  // The sentence is meant to be repeated to a human, so it has to say what to do.
  expect(v.why).toContain('make it worse');
});

test('verdict: a full disk is critical on its own', () => {
  // Disk is the one that stops work outright rather than slowing it: a build
  // with no room fails, it does not queue.
  expect(verdict({ cpuPct: 5, memUsedPct: 20, diskUsedPct: 97 }).pressure).toBe('critical');
});

// ---------------------------------------------------------------------------
// judgeHostLoad — the pause/resume decision
// ---------------------------------------------------------------------------

const snap = (pressure: 'ok' | 'busy' | 'critical', measured = true) => ({
  pressure,
  why: `p=${pressure}`,
  measured,
});

test('host-load: a one-sample dip does not wake anybody', () => {
  // Load is spiky. Firing on the first sample under the bar wakes the session
  // straight back into the next spike, which is the behaviour this whole
  // listener exists to avoid.
  const t0 = 1_000_000;
  const first = judgeHostLoad({ clearSince: null }, snap('ok'), { forSec: 60 }, t0);
  expect(first.fire).toBe(false);
  expect(first.next.clearSince).toBe(t0);
  expect(first.summary).toContain('0s of 60s');

  const halfway = judgeHostLoad(first.next, snap('ok'), { forSec: 60 }, t0 + 30_000);
  expect(halfway.fire).toBe(false);
  expect(halfway.summary).toContain('30s of 60s');

  const held = judgeHostLoad(halfway.next, snap('ok'), { forSec: 60 }, t0 + 61_000);
  expect(held.fire).toBe(true);
  expect(held.summary).toContain('comfortable for 61s');
});

test('host-load: a miss RESETS the streak, it does not pause it', () => {
  const t0 = 1_000_000;
  const a = judgeHostLoad({ clearSince: null }, snap('ok'), { forSec: 60 }, t0);
  const spike = judgeHostLoad(a.next, snap('critical'), { forSec: 60 }, t0 + 30_000);
  expect(spike.fire).toBe(false);
  expect(spike.next.clearSince).toBe(null); // the 30s already served is forfeited

  // …so the clock starts again from the next clear sample, and the old streak
  // cannot be used to fire early.
  const restart = judgeHostLoad(spike.next, snap('ok'), { forSec: 60 }, t0 + 40_000);
  expect(restart.next.clearSince).toBe(t0 + 40_000);
  expect(judgeHostLoad(restart.next, snap('ok'), { forSec: 60 }, t0 + 70_000).fire).toBe(false);
});

test('host-load: "not-critical" wakes on busy, plain "ok" does not', () => {
  const t0 = 1_000_000;
  const lenient = judgeHostLoad({ clearSince: t0 - 90_000 }, snap('busy'), { until: 'not-critical', forSec: 60 }, t0);
  expect(lenient.fire).toBe(true);

  const strict = judgeHostLoad({ clearSince: t0 - 90_000 }, snap('busy'), { until: 'ok', forSec: 60 }, t0);
  expect(strict.fire).toBe(false);
  expect(strict.next.clearSince).toBe(null);
});

test('host-load: with nothing measured it keeps waiting instead of firing instantly', () => {
  // verdict() cannot raise pressure on nulls, so an unmeasurable platform
  // reports "ok" by construction. Without this guard, "wait for the machine to
  // calm down" would return immediately — the exact wrong answer, and silently.
  const t0 = 1_000_000;
  const blind = judgeHostLoad({ clearSince: t0 - 600_000 }, snap('ok', false), { forSec: 60 }, t0);
  expect(blind.fire).toBe(false);
  expect(blind.next.clearSince).toBe(null);
});

test('host-load: forSec 0 fires on the first clear sample', () => {
  const t0 = 1_000_000;
  expect(judgeHostLoad({ clearSince: null }, snap('ok'), { forSec: 0 }, t0).fire).toBe(true);
});

// ---------------------------------------------------------------------------
// sample — what this machine can actually answer
// ---------------------------------------------------------------------------

test('sample: answers with real numbers on this platform, and nulls where it cannot', async () => {
  primeCpu();
  await Bun.sleep(250); // cpuPct is a delta; one sample cannot produce a rate
  const s = sample({ topProcesses: 5 });

  expect(s.platform).toBe(process.platform);
  expect(s.cores).toBeGreaterThan(0);
  expect(s.memory.totalMb).toBeGreaterThan(0);
  expect(['ok', 'busy', 'critical']).toContain(s.pressure);

  // Whatever is reported must be in range — a percentage outside 0-100 is the
  // shape of a units bug (kB read as bytes, ticks read as seconds).
  if (s.cpu.pct !== null) expect(s.cpu.pct).toBeGreaterThanOrEqual(0);
  if (s.cpu.pct !== null) expect(s.cpu.pct).toBeLessThanOrEqual(100);
  if (s.memory.usedPct !== null) expect(s.memory.usedPct).toBeLessThanOrEqual(100);

  // loadavg is POSIX. On Windows os.loadavg() is [0,0,0]; reporting that as a
  // number would read as "idle", so it must be null there and a number here.
  if (process.platform === 'win32') expect(s.cpu.load1).toBe(null);
  else expect(typeof s.cpu.load1).toBe('number');

  // The memory number has to say where it came from, so a consumer knows
  // whether it is an "available" reading or the os.freemem() understatement.
  if (s.memory.availableMb !== null) expect(s.memory.source).not.toBe(null);

  expect(wasMeasured(s)).toBe(true); // this platform can measure something
});

test('sample: the process table is attributed and sorted, or honestly empty', () => {
  const s = sample({ topProcesses: 8 });
  expect(Array.isArray(s.processes)).toBe(true);
  if (!s.processes.length) return; // a platform with no reader — allowed, not faked

  const rss = s.processes.map((p) => p.rssMb ?? 0);
  expect([...rss].sort((a, b) => b - a)).toEqual(rss); // heaviest first

  for (const p of s.processes) {
    expect(p.pid).toBeGreaterThan(0);
    expect(p.name.length).toBeGreaterThan(0);
    // Per-process CPU is unreadable on Windows and must be null there rather
    // than 0 — a table of "0%" would look like an idle machine.
    if (process.platform === 'win32') expect(p.cpuPct).toBe(null);
  }

  // Every rolled-up session must come from a process that named it.
  for (const row of s.sessions)
    expect(s.processes.some((p) => p.session === row.session)).toBe(true);
});

// ---------------------------------------------------------------------------
// The platform readers — parsed from REAL captured output
//
// A developer can only execute one of the three platforms. Splitting each
// reader into "run the command" and "parse the output" makes the second half
// testable everywhere, which is where the bugs actually live (units, spaces in
// names, a field that means something else than it looks like).
// ---------------------------------------------------------------------------

const MEMINFO = `MemTotal:        8127048 kB
MemFree:          283416 kB
MemAvailable:    5204932 kB
Buffers:          118904 kB
Cached:          4962180 kB
SwapCached:        18404 kB
SwapTotal:       8388604 kB
SwapFree:        7772668 kB
`;

test('linux: MemAvailable is used, not MemFree — they differ by 4.7 GB here', () => {
  expect(parseMemAvailableMb(MEMINFO)).toBe(5083);
  // MemFree would be 276 MB. On the 8 GB VM that is the difference between
  // "critical, stop everything" and "half the machine is free".
  expect(parseMemAvailableMb(MEMINFO)!).toBeGreaterThan(Math.round(283416 / 1024) * 10);
  expect(parseMemAvailableMb('MemTotal: 100 kB\n')).toBe(null);
});

test('linux: swap is used-vs-total, and absent swap is null not zero', () => {
  expect(parseSwap(MEMINFO)).toEqual({ totalMb: 8192, usedMb: 602 });
  expect(parseSwap('SwapTotal:             0 kB\nSwapFree:              0 kB\n')).toBe(null);
  expect(parseSwap('MemTotal: 100 kB\n')).toBe(null);
});

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              123456.
Pages active:                            900000.
Pages inactive:                          400000.
Pages speculative:                        20000.
Pages throttled:                              0.
Pages wired down:                        300000.
Pages purgeable:                          10000.
`;

test('macOS: available counts inactive and purgeable, not just free', () => {
  // (123456 + 400000 + 20000 + 10000) pages * 16384 B = 8648 MB
  expect(parseVmStatMb(VM_STAT)).toBe(8648);
  // "Pages free" alone would be 1929 MB — the number that makes a Mac look
  // out of memory when it is not.
  expect(parseVmStatMb(VM_STAT)!).toBeGreaterThan(4000);
  // A non-default page size must be honoured, or every Apple Silicon Mac
  // (16 KB pages) is reported at a quarter of its real memory.
  expect(parseVmStatMb(VM_STAT.replace('16384', '4096'))).toBe(2162);
  expect(parseVmStatMb('')).toBe(null);
});

test('posix: ps rows parse, rss converts kB→MB, and comm is basenamed', () => {
  const rows = parsePsTable(
    [
      '    1   0.0   12345 /sbin/launchd',
      '  902  15.5 1048576 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ' 1337   0.0    2048 bun',
      'garbage line',
      '',
    ].join('\n')
  );
  expect(rows.length).toBe(3);
  expect(rows[0]).toMatchObject({ pid: 1, name: 'launchd', cpuPct: 0, rssMb: 12 });
  // rss is kB: 1048576 kB is 1 GB, not 1 MB and not 1 TB.
  expect(rows[1].rssMb).toBe(1024);
  // A path with spaces must survive — Linux `comm` is a full path.
  expect(rows[1].name).toBe('Google Chrome');
  expect(rows[1].cpuPct).toBe(15.5);
});

test('windows: CSV keeps names with spaces, bytes convert to MB, cpu stays null', () => {
  const rows = parseWinProcCsv(
    [
      '"ProcessId","Name","WorkingSetSize"',
      '"4","System","139264"',
      '"9012","Google Chrome Helper (Renderer).exe","943718400"',
      '"1","",""',
      '',
    ].join('\r\n')
  );
  expect(rows.length).toBe(2);
  expect(rows[0]).toMatchObject({ pid: 4, name: 'System', rssMb: 0 });
  // WorkingSetSize is BYTES here (not kB as in ps) — 900 MB.
  expect(rows[1].rssMb).toBe(900);
  // The name is the reason this is CSV and not a whitespace table.
  expect(rows[1].name).toBe('Google Chrome Helper (Renderer).exe');
  // Cumulative CPU time is not a rate; null beats a fabricated 0%.
  expect(rows[1].cpuPct).toBe(null);
});

// ---------------------------------------------------------------------------
// shutdown: killAll() — found while verifying the host-load listener
// ---------------------------------------------------------------------------

test('killAll() does not throw — shutdown() runs to the end', async () => {
  // This threw `ReferenceError: headless is not defined`: claude.js reached for
  // a module-level binding that was never declared. killAll() is called from
  // shutdown(), so EVERY graceful stop (SIGTERM, bin/host restart) aborted at
  // that line — the WhatsApp bridge stayed up, releaseHost() never ran and the
  // process hung "alive but not responding" instead of exiting. It surfaced as
  // a listener that polled exactly once and then never again, because the host
  // being restarted under it was still half-alive.
  //
  // Subprocess, because claude.js captures instance paths at import time.
  const p = Bun.spawnSync(
    [
      'bun',
      '-e',
      "const c = await import('./server/claude.js');" +
        "try { c.killAll(); process.stdout.write('OK'); }" +
        "catch (e) { process.stdout.write('THREW:' + (e && e.message)); }",
    ],
    {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, NODE_ENV: 'test', ARIGAMI_DIR: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  expect(new TextDecoder().decode(p.stdout)).toContain('OK');
});
