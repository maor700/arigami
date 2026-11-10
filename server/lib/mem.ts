// MEM1: what THIS process holds — the number the cockpit's resources view
// cannot give (lib/resources.ts samples `ps`, per process, from outside).
//
// Two tiers, because the costs differ by orders of magnitude:
//   * sample()   — process.memoryUsage() only. O(1); safe to log on a timer.
//   * heap()     — bun:jsc heapStats(): walks the whole heap to count objects
//                  by type. Seconds on a multi-GB heap, so on demand only
//                  (GET /__api/host/mem?heap=1), never on the timer.
//   * snapshot() — Bun.generateHeapSnapshot() written to $ARIGAMI_DIR/diag.
//                  Loadable in Safari's Web Inspector (Timelines → JavaScript
//                  Allocations → import). Costs about as much memory as the heap
//                  it describes while it runs — POST /__api/host/heap-snapshot
//                  with the confirm header, and only when there is headroom.
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './instance.js';

export interface MemSample {
  ts: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  uptimeSec: number;
}

const mb = (n: number): number => Math.round((n / 1024 / 1024) * 10) / 10;

export function sample(): MemSample {
  const m = process.memoryUsage();
  return {
    ts: Date.now(),
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
    externalMb: mb(m.external),
    arrayBuffersMb: mb(m.arrayBuffers ?? 0),
    uptimeSec: Math.round(process.uptime()),
  };
}

export interface HeapStats {
  heapSizeMb: number;
  heapCapacityMb: number;
  extraMemoryMb: number;
  objectCount: number;
  protectedObjectCount: number;
  /** top object types by count, descending */
  topTypes: [string, number][];
  protectedTopTypes: [string, number][];
}

export function heap(top = 15): HeapStats | { error: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsc = require('bun:jsc') as { heapStats: () => any };
    const h = jsc.heapStats();
    const sorted = (o: Record<string, number>) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, top) as [string, number][];
    return {
      heapSizeMb: mb(h.heapSize),
      heapCapacityMb: mb(h.heapCapacity),
      extraMemoryMb: mb(h.extraMemorySize),
      objectCount: h.objectCount,
      protectedObjectCount: h.protectedObjectCount,
      topTypes: sorted(h.objectTypeCounts),
      protectedTopTypes: sorted(h.protectedObjectTypeCounts),
    };
  } catch (e) {
    return { error: (e as Error)?.message || String(e) };
  }
}

export const DIAG_DIR = path.join(ARIGAMI_DIR, 'diag');

export function snapshot(): { file: string; bytes: number; ms: number } {
  const gen = (globalThis as any).Bun?.generateHeapSnapshot;
  if (typeof gen !== 'function') throw new Error('heap snapshots need Bun');
  const t0 = Date.now();
  const snap = gen();
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  const file = path.join(DIAG_DIR, `heap-${new Date(t0).toISOString().replace(/[:.]/g, '-')}.json`);
  const body = JSON.stringify(snap);
  fs.writeFileSync(file, body);
  return { file, bytes: body.length, ms: Date.now() - t0 };
}

/** One log line for the periodic `[mem]` heartbeat (index.ts). */
export function formatSample(s: MemSample, extra: Record<string, unknown> = {}): string {
  const parts = [`rss=${s.rssMb}MB`, `heapUsed=${s.heapUsedMb}MB`, `external=${s.externalMb}MB`, `up=${s.uptimeSec}s`];
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${typeof v === 'number' && v > 4096 ? `${mb(v)}MB` : String(v)}`);
  return `[mem] ${parts.join(' ')}`;
}
