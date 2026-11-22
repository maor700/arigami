// The host process's own health, one JSON line a minute to <ARIGAMI_DIR>/logs/host-health.log.
//
// Why: the host grew to 8+ GB over a day and nothing on disk showed when or how
// fast. resources.ts answers "how busy is the MACHINE"; this answers "how big is
// the HOST and what is it holding" — RSS, JS heap, open fds, threads, and the
// counts of the per-session things it keeps (claude procs, desktops, chat tails,
// compiled MCP schemas). Once an hour the line also carries the heap's top
// object types (bun:jsc heapStats walks the heap, so not every minute).
//
// Rotation: past MAX_BYTES the file becomes host-health.log.1 (one generation),
// so the log can never fill the disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARIGAMI_DIR } from './instance.js';

export const MAX_BYTES = 5 * 1024 * 1024;
const MB = 1024 * 1024;

export interface HostHealth {
  at: number;
  pid: number;
  uptimeMin: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  /** null where /proc/self is unreadable (not Linux). */
  fds: number | null;
  threads: number | null;
  load1: number | null;
  counts: Record<string, number>;
  /** Hourly: the heap's most numerous object types. */
  topTypes?: [string, number][];
}

function fdCount(): number | null {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}

function threadCount(): number | null {
  try {
    return Number(/^Threads:\s+(\d+)/m.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1]) || null;
  } catch {
    return null;
  }
}

function topTypes(n = 12): [string, number][] | undefined {
  try {
    const { heapStats } = require('bun:jsc') as typeof import('bun:jsc');
    return Object.entries(heapStats().objectTypeCounts as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  } catch {
    return undefined;
  }
}

/** One reading. Cheap (no heap walk) unless `withTypes`. */
export function hostHealth(counts: Record<string, number> = {}, withTypes = false): HostHealth {
  const m = process.memoryUsage();
  const out: HostHealth = {
    at: Date.now(),
    pid: process.pid,
    uptimeMin: Math.round(process.uptime() / 60),
    rssMb: Math.round(m.rss / MB),
    heapUsedMb: Math.round(m.heapUsed / MB),
    heapTotalMb: Math.round(m.heapTotal / MB),
    externalMb: Math.round(m.external / MB),
    fds: fdCount(),
    threads: threadCount(),
    load1: process.platform === 'win32' ? null : Math.round(os.loadavg()[0] * 100) / 100,
    counts,
  };
  if (withTypes) out.topTypes = topTypes();
  return out;
}

/** Append one line; rotate first when the file is past `maxBytes`. */
export function appendHealth(file: string, line: HostHealth, maxBytes = MAX_BYTES): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch (e) {
    console.error('[host-health] write failed:', (e as Error).message);
  }
}

export const HEALTH_LOG = path.join(ARIGAMI_DIR, 'logs', 'host-health.log');

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the minute log. `counts` is read on every tick; a throwing provider logs no counts, never stops the log. */
export function startHealthLog(counts: () => Record<string, number>, { everyMs = 60_000, typesEveryMs = 3_600_000, file = HEALTH_LOG } = {}): void {
  if (timer) return;
  let lastTypes = 0;
  const tick = () => {
    let c: Record<string, number> = {};
    try {
      c = counts();
    } catch {}
    const withTypes = Date.now() - lastTypes >= typesEveryMs;
    if (withTypes) lastTypes = Date.now();
    appendHealth(file, hostHealth(c, withTypes));
  };
  tick();
  timer = setInterval(tick, everyMs);
  timer.unref?.();
}

export function stopHealthLog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
