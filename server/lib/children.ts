// Child-process supervision: nothing the host spawns may outlive the host.
//
// THE BUG THIS FIXES (Windows). The host's listening socket handle is
// inheritable there, so every spawned child — and every grandchild, i.e. a
// session's MCP servers — gets a copy of it. Meanwhile `child.kill('SIGTERM')`
// on Windows is TerminateProcess against the DIRECT child only, and
// `taskkill /T` walks LIVE parent links: once `claude.exe` is gone its MCP
// servers are unreachable orphans. Each orphan still holds the listen socket,
// so the kernel keeps the port bound to a pid that no longer exists — the host
// can never rebind, and `host stop` cheerfully reports "not running" while
// :PORT stays blocked until reboot. (Seen in the wild: 49 orphaned MCP servers
// pinning :3099 to a dead pid.)
//
// POSIX doesn't have the port half of this — libuv sets FD_CLOEXEC on the
// listening socket, so children never inherit it — but it leaks the same
// orphan processes, which the pidfile sweep below cleans up.
//
// Three layers, most reliable first:
//   1. A Windows job object with KILL_ON_JOB_CLOSE. The kernel kills every
//      member the moment the host's handle closes, HOWEVER the host dies —
//      crash, Task Manager, `taskkill /F`, no handler required. Job membership
//      is inherited, so grandchildren are covered by assigning the child.
//   2. killTree() for deliberate stops, so a stop takes the whole tree at once
//      instead of decapitating it and leaking the children.
//   3. A pidfile sweep at startup, for anything that escaped a previous run
//      (a host from before this fix, the assign race below, a breakaway proc).
import fs from 'node:fs';
import path from 'node:path';
import { isWin, pidAlive } from './platform.js';
import { ARIGAMI_DIR, HOST_PID_FILE, makeHostId } from './instance.js';
import { cfg } from './config.js';

// Instance isolation (T5): the pid list lives under THIS instance's dir, and
// every record names the host that spawned it. The sweep only ever kills a
// record that (a) carries our own hostId and (b) whose host is no longer
// running. A second instance sharing the machine therefore can't reach our
// children even if it somehow read our file — and we can't reach its.
const DIR = ARIGAMI_DIR;
const CHILDREN_FILE = path.join(DIR, 'children.json');

export const HOST_ID: string = makeHostId(ARIGAMI_DIR, cfg.port);
export const HOST_PID: number = process.pid;

export interface ChildRecord {
  pid: number;
  tag: string;
  at: number; // host clock at spawn — the pid-reuse guard for the sweep
  hostId?: string; // absent only on records written before T5
  hostPid?: number;
}

// --- Windows job object ------------------------------------------------------

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectExtendedLimitInformation = 9;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
// x64 sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION); LimitFlags sits at +16.
const EXT_LIMIT_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;

type AssignFn = (pid: number) => boolean;

let assignToJob: AssignFn | null = null;

// The job HANDLE is deliberately never closed and never made inheritable:
// KILL_ON_JOB_CLOSE fires when the last handle to the job goes away, so the
// host process holding it for its whole life IS the kill switch. Letting a
// child inherit the handle would keep the job alive past the host's death and
// defeat the entire mechanism.
function initJob(): void {
  if (!isWin) return;
  try {
    // Sync require (bun:ffi is a Bun builtin, no TLA) — not `await import()` —
    // so this function stays synchronous: bun build --compile refuses to bundle
    // a `require()` of any module that transitively has a top-level await, and
    // supervise() below reads `assignToJob` synchronously right after spawn(),
    // so a Promise-based init here would race every early child on Windows.
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const k32 = dlopen('kernel32.dll', {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    const s = k32.symbols;
    const job = s.CreateJobObjectW(null, null);
    if (!job) throw new Error('CreateJobObject failed');

    const info = new Uint8Array(EXT_LIMIT_SIZE);
    new DataView(info.buffer).setUint32(
      LIMIT_FLAGS_OFFSET,
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      true // x86/x64 are little-endian
    );
    if (!s.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr(info), EXT_LIMIT_SIZE))
      throw new Error('SetInformationJobObject failed');

    assignToJob = (pid: number): boolean => {
      const h = s.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (!h) return false;
      try {
        return !!s.AssignProcessToJobObject(job, h);
      } finally {
        s.CloseHandle(h);
      }
    };
  } catch (e) {
    // No FFI (running under node, a locked-down box, a future Bun change):
    // layers 2 and 3 still apply, so degrade loudly rather than fail to boot.
    console.warn(
      '[children] Windows job object unavailable — orphan cleanup falls back to the startup sweep:',
      e instanceof Error ? e.message : String(e)
    );
  }
}

initJob();

// --- pid records -------------------------------------------------------------

function readRecords(): ChildRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(CHILDREN_FILE, 'utf8'));
    return Array.isArray(raw) ? raw.filter((r) => r && Number.isFinite(r.pid)) : [];
  } catch {
    return []; // absent or corrupt — a sweep with nothing to do
  }
}

function writeRecords(records: ChildRecord[]): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CHILDREN_FILE, JSON.stringify(records));
  } catch (e) {
    console.error('[children] could not persist the pid list:', (e as Error)?.message);
  }
}

function remember(pid: number, tag: string): void {
  const records = readRecords().filter((r) => r.pid !== pid);
  records.push({ pid, tag, at: Date.now(), hostId: HOST_ID, hostPid: HOST_PID });
  writeRecords(records);
}

function forget(pid: number): void {
  const records = readRecords();
  const left = records.filter((r) => r.pid !== pid);
  if (left.length !== records.length) writeRecords(left);
}

// --- kill --------------------------------------------------------------------

/**
 * Stop `pid` AND its descendants.
 *
 * Windows gets `taskkill /T /F`, which walks the live tree in one shot — the
 * only way to reach a session's MCP servers, since killing `claude.exe` first
 * would orphan them beyond reach. POSIX keeps the SIGTERM→SIGKILL escalation
 * (no process-group kill: these children aren't spawned detached, so a negative
 * pid would signal the HOST's own group).
 */
export function killTree(pid: number | undefined | null): void {
  if (!pid || !pidAlive(pid)) return;
  if (isWin) {
    try {
      Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already gone
  }
  const t = setTimeout(() => {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* raced us */
      }
    }
  }, 1500);
  t.unref?.();
}

/**
 * Put a freshly spawned child under supervision: job object (so it dies with
 * the host no matter how the host dies) plus a pid record (so the next run can
 * sweep it if this one is killed before its own cleanup runs).
 *
 * Race note: a child can spawn its own children in the window between spawn and
 * assignToJob. Those grandchildren miss the job; the startup sweep is what
 * catches them. Bun has no spawn-suspended option to close the window.
 */
export function supervise<T extends { pid?: number; on?: Function }>(child: T, tag: string): T {
  const pid = child?.pid;
  if (!pid) return child;
  if (assignToJob && !assignToJob(pid))
    console.warn(`[children] could not add ${tag} (pid ${pid}) to the job object`);
  remember(pid, tag);
  child.on?.('close', () => forget(pid));
  child.on?.('error', () => forget(pid));
  return child;
}

// --- startup sweep -----------------------------------------------------------

/** BSD `ps -o etime` → seconds. Accepts `mm:ss`, `hh:mm:ss`, `dd-hh:mm:ss`. */
function parseEtime(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(mm) * 60 + Number(ss);
}

/** pid → process start time (ms since epoch), for the pids we still care about. */
function startTimes(pids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!pids.length) return out;
  try {
    if (isWin) {
      // One CIM query for the batch. `tasklist` can't report start time, and
      // this only runs at boot when leftovers exist.
      const filter = pids.map((p) => `ProcessId=${p}`).join(' or ');
      const r = Bun.spawnSync(
        [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
            `ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`,
        ],
        { stdout: 'pipe', stderr: 'ignore' }
      );
      for (const line of new TextDecoder().decode(r.stdout).split(/\r?\n/)) {
        const [pid, ms] = line.trim().split(/\s+/).map(Number);
        if (pid && Number.isFinite(ms)) out.set(pid, ms);
      }
      return out;
    }
    // POSIX: elapsed time is far easier to parse than lstart. `etimes` (seconds)
    // is procps-only, so fall back to BSD/macOS `etime` ([[dd-]hh:]mm:ss).
    const now = Date.now();
    const run = (fmt: string): string => {
      const r = Bun.spawnSync(['ps', '-o', `pid=,${fmt}=`, '-p', pids.join(',')], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      return new TextDecoder().decode(r.stdout);
    };
    for (const line of run('etimes').split('\n')) {
      const [pid, etimes] = line.trim().split(/\s+/).map(Number);
      if (pid && Number.isFinite(etimes)) out.set(pid, now - etimes * 1000);
    }
    if (out.size) return out;
    for (const line of run('etime').split('\n')) {
      const [pid, etime] = line.trim().split(/\s+/);
      const secs = parseEtime(etime);
      if (Number(pid) && secs !== null) out.set(Number(pid), now - secs * 1000);
    }
  } catch {
    /* no probe available — the caller treats "unknown" as "don't kill" */
  }
  return out;
}

// A pid the OS handed to somebody else since we recorded it must never be
// killed. A survivor's start time is ~when we spawned it; a recycled pid
// belongs to a process that started later, after the original died.
const REUSE_TOLERANCE_MS = 60_000;

export interface SweepPlan {
  kill: ChildRecord[]; // ours, host dead, pid verified → kill
  keep: ChildRecord[]; // records to write back untouched (other hosts, live hosts)
}

/**
 * Pure: decide which records the sweep may kill. Exported for tests.
 *
 *  - `hostId` differs from ours → NOT ours. Never touched, kept in the file
 *    (it belongs to whoever wrote it, dead or alive).
 *  - `hostId` is ours but `hostPid` is a live process that isn't us → a host
 *    with our identity is still running. Left alone (startup should have
 *    refused to boot in that case; this is the belt to that suspender).
 *  - no `hostId` (pre-T5 record) → treated as ours ONLY if `legacyHostAlive`
 *    is false, i.e. the pidfile from before the upgrade points at a dead pid.
 *  - otherwise: ours and orphaned → killable, subject to the pid-reuse check
 *    the caller does with real start times.
 */
export function planSweep(
  records: ChildRecord[],
  me: { hostId: string; hostPid: number },
  isAlive: (pid: number) => boolean,
  legacyHostAlive: boolean
): SweepPlan {
  const plan: SweepPlan = { kill: [], keep: [] };
  for (const r of records) {
    if (r.hostId === undefined) {
      if (legacyHostAlive) plan.keep.push(r);
      else if (isAlive(r.pid)) plan.kill.push(r);
      continue;
    }
    if (r.hostId !== me.hostId) {
      plan.keep.push(r);
      continue;
    }
    if (r.hostPid && r.hostPid !== me.hostPid && isAlive(r.hostPid)) {
      plan.keep.push(r);
      continue;
    }
    if (isAlive(r.pid)) plan.kill.push(r);
    // dead + ours → dropped from the file
  }
  return plan;
}

/** The pid in a pre-T5 pidfile (plain integer), if it names a live process. */
function legacyHostAlive(): boolean {
  try {
    const pid = Number(fs.readFileSync(HOST_PID_FILE, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 && pid !== process.pid && pidAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Kill anything left over from a previous run OF THIS HOST IDENTITY. Call
 * BEFORE binding the port: an orphan holding the inherited listen socket is
 * exactly what keeps the port bound to a dead pid, so sweeping first is what
 * makes the next start succeed instead of failing with EADDRINUSE forever.
 *
 * Records of other hosts (a different ARIGAMI_DIR/port) are never touched and
 * are written back as-is. Returns the number of process trees killed.
 */
export function sweepOrphans(): number {
  const records = readRecords();
  if (!records.length) return 0;
  const plan = planSweep(records, { hostId: HOST_ID, hostPid: HOST_PID }, pidAlive, legacyHostAlive());
  const started = startTimes(plan.kill.map((r) => r.pid));
  let killed = 0;
  for (const r of plan.kill) {
    const t = started.get(r.pid);
    if (t === undefined) continue; // couldn't verify identity — leave it alone
    if (t > r.at + REUSE_TOLERANCE_MS) continue; // pid was recycled; not ours
    console.log(`[children] sweeping orphan ${r.tag} (pid ${r.pid}) from a previous run`);
    killTree(r.pid);
    killed++;
  }
  writeRecords(plan.keep);
  return killed;
}
