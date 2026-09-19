// Machine resources: what this host is using, and which session is using it.
//
// The point is not a dashboard. It is that a session can ASK before it starts
// something expensive, and can wait instead of making a loaded machine worse —
// so every number here is consumed by an agent, not only by a human, and that
// sets the rules below.
//
// ── The one rule: never invent a number ──────────────────────────────────────
// Every platform is missing something. `os.loadavg()` returns [0,0,0] on
// Windows; `os.freemem()` excludes the page cache on Linux and inactive pages
// on macOS, so it understates available memory by gigabytes. A sampler that
// papers over those gaps produces the worst possible failure for this feature:
// an agent reading "load 0" on a Windows box that is pinned, or "0.5 GB free"
// on a Linux box with 20 GB reclaimable, and deciding wrongly with confidence.
//
// So anything a platform cannot answer is `null`, never 0, and every derived
// number carries the `source` it came from. A consumer that sees `null` knows
// it is blind; a consumer that sees a number knows where it was measured.
//
// ── What is portable and what is not ─────────────────────────────────────────
//   portable   os.cpus() cumulative times → CPU% by differencing two samples.
//              Windows populates user/nice/sys/idle/irq like everyone else, so
//              this — not loadavg — is the primary signal.
//              os.totalmem(), os.uptime(), fs.statfsSync().
//   posix only os.loadavg().
//   per-OS     "available" memory, swap, and the per-process table. Each has
//              its own reader below and each degrades to null on its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARIGAMI_DIR } from './instance.js';

export type Pressure = 'ok' | 'busy' | 'critical';

export interface ProcRow {
  pid: number;
  name: string;
  /** Percent of ONE core, as ps reports it — can exceed 100 on a threaded process. null where unreadable. */
  cpuPct: number | null;
  rssMb: number | null;
  /** The session this process belongs to, from children.ts's `session:<id>` tag. */
  session: string | null;
  tag: string | null;
}

export interface Snapshot {
  at: number;
  platform: NodeJS.Platform;
  cores: number;
  uptimeSec: number;
  cpu: {
    /** 0-100 across all cores, from differencing os.cpus(). null on the very first sample. */
    pct: number | null;
    /** POSIX only — null on Windows, where the OS has no such concept. */
    load1: number | null;
    load5: number | null;
  };
  memory: {
    totalMb: number;
    /** What could actually be handed to a new process. null when no reader worked. */
    availableMb: number | null;
    usedPct: number | null;
    source: 'meminfo' | 'vm_stat' | 'wmic' | 'os.freemem' | null;
  };
  swap: { totalMb: number; usedMb: number } | null;
  disk: { path: string; freeMb: number; totalMb: number; usedPct: number } | null;
  /** Heaviest processes first. Empty when the per-process reader is unavailable. */
  processes: ProcRow[];
  /** Per-session rollup of `processes`, heaviest first. */
  sessions: { session: string; cpuPct: number; rssMb: number; procs: number }[];
  pressure: Pressure;
  /** Why `pressure` is what it is, in words an agent can pass to a human. */
  why: string;
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

type CpuTotals = { idle: number; total: number };

function cpuTotals(): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus() || []) {
    for (const [k, v] of Object.entries(c.times)) {
      total += v as number;
      if (k === 'idle') idle += v as number;
    }
  }
  return { idle, total };
}

// Differencing needs two samples. Keeping the previous one here (rather than
// sleeping inside sample()) means a caller never blocks: the first call after
// boot answers `null` and every later one is a true interval average.
let prevCpu: CpuTotals | null = null;

function cpuPct(): number | null {
  const now = cpuTotals();
  const prev = prevCpu;
  prevCpu = now;
  if (!prev) return null;
  const dTotal = now.total - prev.total;
  const dIdle = now.idle - prev.idle;
  // A zero or negative delta means the clock went backwards or nothing was
  // sampled; 0% would be a lie, so say nothing.
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
}

// ---------------------------------------------------------------------------
// Memory — the number everyone gets wrong
// ---------------------------------------------------------------------------

/**
 * The platform-specific readers below are split into a command call and a PURE
 * parser, and the parsers are exported.
 *
 * The reason is that this host runs on Linux, macOS and Windows, and a
 * developer can only ever execute one of those three. Keeping the parsing pure
 * means all three are covered by tests against real captured output, and the
 * only thing left untested off the current platform is whether the command
 * exists — which fails loudly (null) rather than quietly wrong.
 */

/** `/proc/meminfo` → MemAvailable in MB. */
export function parseMemAvailableMb(text: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

/** `/proc/meminfo` → swap, or null when the machine has none. */
export function parseSwap(text: string): { totalMb: number; usedMb: number } | null {
  const kb = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)\\s+kB$`, 'm').exec(text)?.[1] ?? NaN);
  const total = kb('SwapTotal');
  const free = kb('SwapFree');
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
  return { totalMb: Math.round(total / 1024), usedMb: Math.round((total - free) / 1024) };
}

/**
 * `vm_stat` → available MB.
 *
 * free + inactive + speculative + purgeable, which is what the macOS VM system
 * would hand over under pressure. "Pages free" alone is the number Activity
 * Monitor does NOT show you and is wrong by gigabytes on any machine that has
 * been up for a while.
 */
export function parseVmStatMb(text: string): number | null {
  if (!text) return null;
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] || 4096);
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1] || 0);
  const free = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
  return free > 0 ? Math.round((free * pageSize) / 1024 / 1024) : null;
}

/** POSIX `ps -eo pid=,pcpu=,rss=,comm=` → rows. rss is kB. */
export function parsePsTable(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      // basename: `comm` is a full path on Linux and a bare name on macOS.
      name: path.basename(m[4].trim()),
      cpuPct: Number(m[2]),
      rssMb: Math.round(Number(m[3]) / 1024),
      session: null,
      tag: null,
    });
  }
  return rows;
}

/**
 * Windows `ConvertTo-Csv` of ProcessId,Name,WorkingSetSize → rows.
 *
 * CSV and not the default table: process names contain spaces ("Google Chrome
 * Helper"), and splitting a table on whitespace silently truncates them.
 * cpuPct stays null — Win32_Process exposes cumulative CPU time, not a rate,
 * and a made-up 0 would read as an idle process.
 */
export function parseWinProcCsv(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const m = /^"?(\d+)"?,"?(.*?)"?,"?(\d+)"?$/.exec(line.trim());
    if (!m) continue;
    rows.push({ pid: Number(m[1]), name: m[2], cpuPct: null, rssMb: Math.round(Number(m[3]) / 1024 / 1024), session: null, tag: null });
  }
  return rows;
}

function availableMemory(): { mb: number | null; source: Snapshot['memory']['source'] } {
  // Linux: MemAvailable is the kernel's own estimate of what a new workload
  // could get WITHOUT swapping — it counts reclaimable page cache, which
  // os.freemem() does not. On a busy build box the two differ by an order of
  // magnitude, and free-vs-available is the difference between "pause" and
  // "carry on".
  if (process.platform === 'linux') {
    try {
      const mb = parseMemAvailableMb(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (mb != null) return { mb, source: 'meminfo' };
    } catch {
      /* fall through */
    }
  }
  // macOS: vm_stat pages. "Available" = free + inactive + speculative +
  // purgeable, i.e. what the VM system would hand over under pressure.
  if (process.platform === 'darwin') {
    const mb = parseVmStatMb(run('vm_stat', [], 4000) || '');
    if (mb != null) return { mb, source: 'vm_stat' };
  }
  // Windows: FreePhysicalMemory from CIM, in kB. There is no "available"
  // distinct from "free" exposed here, so this is the honest ceiling.
  if (process.platform === 'win32') {
    const out = run(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'],
      8000
    );
    const kb = Number(String(out || '').trim());
    if (Number.isFinite(kb) && kb > 0) return { mb: Math.round(kb / 1024), source: 'wmic' };
  }
  // Last resort. Named as such so a consumer knows it is an UNDERSTATEMENT on
  // Linux and macOS, not a measurement of what is obtainable.
  const free = os.freemem();
  return free > 0 ? { mb: Math.round(free / 1024 / 1024), source: 'os.freemem' } : { mb: null, source: null };
}

function swap(): Snapshot['swap'] {
  if (process.platform === 'linux') {
    try {
      return parseSwap(fs.readFileSync('/proc/meminfo', 'utf8'));
    } catch {
      /* no swap info */
    }
  }
  // macOS keeps it in a sysctl; Windows calls it a page file and reports it
  // differently again. Both are left null rather than guessed — swap matters
  // most on the Linux VM, which is where the reader above works.
  return null;
}

// ---------------------------------------------------------------------------
// Disk — where the instance actually writes
// ---------------------------------------------------------------------------

function disk(): Snapshot['disk'] {
  const target = ARIGAMI_DIR;
  try {
    const st = (fs as unknown as { statfsSync: (p: string) => { bsize: number; blocks: number; bavail: number } }).statfsSync(target);
    // bavail, not bfree: bfree counts blocks reserved for root, which this
    // process cannot use.
    const freeMb = Math.round((st.bsize * st.bavail) / 1024 / 1024);
    const totalMb = Math.round((st.bsize * st.blocks) / 1024 / 1024);
    if (totalMb <= 0) return null;
    return { path: target, freeMb, totalMb, usedPct: Math.round(((totalMb - freeMb) / totalMb) * 100) };
  } catch {
    return null; // statfsSync is recent; an older runtime just has no disk row
  }
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], timeoutMs: number): string | null {
  try {
    const p = Bun.spawnSync([cmd, ...args], { stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs });
    if (!p.success) return null;
    return new TextDecoder().decode(p.stdout);
  } catch {
    return null;
  }
}

/** pid → `session:<id>` tag, from the supervised-children record. */
function tagsByPid(): Map<number, string> {
  const out = new Map<number, string>();
  try {
    const file = path.join(ARIGAMI_DIR, 'run', 'children.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) for (const r of raw) if (r && Number.isFinite(r.pid)) out.set(r.pid, String(r.tag || ''));
  } catch {
    /* no records yet */
  }
  return out;
}

function processes(limit: number): ProcRow[] {
  const tags = tagsByPid();
  const rows: ProcRow[] = [];

  if (process.platform === 'win32') {
    // CSV rather than the default table: process names contain spaces, and a
    // column-split on whitespace loses them.
    const out = run(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,WorkingSetSize | ConvertTo-Csv -NoTypeInformation",
      ],
      12_000
    );
    if (!out) return [];
    rows.push(...parseWinProcCsv(out));
  } else {
    // POSIX. `comm` (not `args`) keeps the line short and splittable; rss is kB.
    const out = run('ps', ['-eo', 'pid=,pcpu=,rss=,comm='], 8000);
    if (!out) return [];
    rows.push(...parsePsTable(out));
  }

  for (const r of rows) {
    const tag = tags.get(r.pid);
    if (!tag) continue;
    r.tag = tag;
    r.session = tag.startsWith('session:') ? tag.slice('session:'.length) : null;
  }

  // Heaviest by memory: it is the resource that actually stops work on these
  // boxes (an OOM kill), where CPU only slows it down.
  rows.sort((a, b) => (b.rssMb ?? 0) - (a.rssMb ?? 0));
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** Thresholds are overridable so a big build box and a 2-core VM can disagree. */
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const THRESHOLDS = {
  cpuBusy: () => num(process.env.ARIGAMI_CPU_BUSY, 75),
  cpuCritical: () => num(process.env.ARIGAMI_CPU_CRITICAL, 92),
  memBusyPct: () => num(process.env.ARIGAMI_MEM_BUSY, 80),
  memCriticalPct: () => num(process.env.ARIGAMI_MEM_CRITICAL, 92),
  diskCriticalPct: () => num(process.env.ARIGAMI_DISK_CRITICAL, 95),
};

/**
 * Pure, and exported for tests: given the measured parts, what should a session
 * do? Unknown inputs never raise the verdict — being blind is not being loaded,
 * and a session must not refuse to work because a platform is missing a reader.
 */
export function verdict(m: {
  cpuPct: number | null;
  memUsedPct: number | null;
  diskUsedPct: number | null;
}): { pressure: Pressure; why: string } {
  const reasons: string[] = [];
  let pressure: Pressure = 'ok';
  const raise = (p: Pressure) => {
    if (p === 'critical' || (p === 'busy' && pressure === 'ok')) pressure = p;
  };

  if (m.cpuPct != null) {
    if (m.cpuPct >= THRESHOLDS.cpuCritical()) { raise('critical'); reasons.push(`CPU ${m.cpuPct}%`); }
    else if (m.cpuPct >= THRESHOLDS.cpuBusy()) { raise('busy'); reasons.push(`CPU ${m.cpuPct}%`); }
  }
  if (m.memUsedPct != null) {
    if (m.memUsedPct >= THRESHOLDS.memCriticalPct()) { raise('critical'); reasons.push(`memory ${m.memUsedPct}% used`); }
    else if (m.memUsedPct >= THRESHOLDS.memBusyPct()) { raise('busy'); reasons.push(`memory ${m.memUsedPct}% used`); }
  }
  if (m.diskUsedPct != null && m.diskUsedPct >= THRESHOLDS.diskCriticalPct()) {
    raise('critical');
    reasons.push(`disk ${m.diskUsedPct}% full`);
  }

  if (pressure === 'ok')
    return {
      pressure,
      why: reasons.length ? `Comfortable (${reasons.join(', ')}).` : 'Comfortable.',
    };
  return {
    pressure,
    why:
      pressure === 'critical'
        ? `Under real pressure: ${reasons.join(', ')}. Starting more work now will make it worse.`
        : `Getting busy: ${reasons.join(', ')}.`,
  };
}

/** One snapshot. Cheap enough to call per request; nothing here blocks on I/O for long. */
export function sample({ topProcesses = 12 }: { topProcesses?: number } = {}): Snapshot {
  const cores = os.cpus()?.length || 1;
  const pct = cpuPct();
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const avail = availableMemory();
  const memUsedPct = avail.mb != null && totalMb > 0 ? Math.round(((totalMb - avail.mb) / totalMb) * 100) : null;
  const d = disk();
  const procs = processes(topProcesses);

  const bySession = new Map<string, { session: string; cpuPct: number; rssMb: number; procs: number }>();
  for (const p of procs) {
    if (!p.session) continue;
    const e = bySession.get(p.session) || { session: p.session, cpuPct: 0, rssMb: 0, procs: 0 };
    e.cpuPct += p.cpuPct ?? 0;
    e.rssMb += p.rssMb ?? 0;
    e.procs += 1;
    bySession.set(p.session, e);
  }

  const v = verdict({ cpuPct: pct, memUsedPct, diskUsedPct: d?.usedPct ?? null });
  // loadavg is POSIX; on Windows it is [0,0,0], which would read as "idle".
  const load = process.platform === 'win32' ? [null, null] : os.loadavg();

  return {
    at: Date.now(),
    platform: process.platform,
    cores,
    uptimeSec: Math.round(os.uptime()),
    cpu: { pct, load1: (load[0] as number | null) ?? null, load5: (load[1] as number | null) ?? null },
    memory: { totalMb, availableMb: avail.mb, usedPct: memUsedPct, source: avail.source },
    swap: swap(),
    disk: d,
    processes: procs,
    sessions: [...bySession.values()].sort((a, b) => b.rssMb - a.rssMb),
    ...v,
  };
}

/**
 * Prime the CPU differencer so the first real caller gets a number instead of
 * null. Called once at boot; harmless to call again.
 */
export function primeCpu(): void {
  prevCpu = cpuTotals();
}

// ---------------------------------------------------------------------------
// "wake me when it clears" — the decision half
// ---------------------------------------------------------------------------

export interface HostLoadArgs {
  /** 'ok' = wait for comfortable (default). 'not-critical' = busy is good enough. */
  until?: 'ok' | 'not-critical';
  /** How long the bar must HOLD before firing. Default 60s. */
  forSec?: number;
}

export interface HostLoadWatermark {
  /** When the bar was first met in the current streak; null while it is not met. */
  clearSince: number | null;
}

/**
 * Pure: should a waiting session be woken yet?
 *
 * Hysteresis is the whole point. Load is spiky — a build finishes, CPU dips for
 * one sample, and firing on that dip wakes the session straight back into the
 * next spike. The bar has to HOLD for `forSec`, and any sample that misses it
 * resets the streak rather than decaying it.
 *
 * Blindness never fires. If the platform could not measure the thing being
 * waited on, `pressure` is 'ok' by construction (verdict() cannot raise on
 * nulls) — which would make "wait for the machine to calm down" return
 * instantly on Windows, where CPU% is readable but loadavg is not. So the
 * caller passes `measured`: with nothing measured we keep waiting rather than
 * pretend the machine is idle.
 */
export function judgeHostLoad(
  prev: HostLoadWatermark,
  snap: Pick<Snapshot, 'pressure' | 'why'> & { measured: boolean },
  args: HostLoadArgs,
  now: number
): { fire: boolean; summary: string; next: HostLoadWatermark } {
  const forMs = Math.max(0, (args.forSec ?? 60) * 1000);
  const bar = args.until === 'not-critical' ? snap.pressure !== 'critical' : snap.pressure === 'ok';
  const met = bar && snap.measured;

  if (!met) return { fire: false, summary: snap.why, next: { clearSince: null } };

  const since = prev.clearSince ?? now;
  const held = now - since;
  if (held < forMs)
    return {
      fire: false,
      summary: `${snap.why} Held for ${Math.round(held / 1000)}s of ${Math.round(forMs / 1000)}s.`,
      next: { clearSince: since },
    };

  return {
    fire: true,
    summary: `The machine has been ${args.until === 'not-critical' ? 'out of the red' : 'comfortable'} for ${Math.round(held / 1000)}s. ${snap.why}`,
    next: { clearSince: since },
  };
}

/** True when at least one of the things `verdict()` judges was actually measured. */
export function wasMeasured(s: Snapshot): boolean {
  return s.cpu.pct != null || s.memory.usedPct != null || s.disk != null;
}
