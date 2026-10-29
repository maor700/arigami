// SysV shared memory left behind by desktops (Linux only).
//
// x11vnc polls its display through MIT-SHM: ~42 SysV segments per desktop, removed on a clean exit (SIGTERM, ~50ms).
// A SIGKILL — the OOM killer, a wedged x11vnc escalated by killTree — leaves all of them in the kernel: segments outlive
// processes, a host restart frees none. Once the user holds kernel.shmmni of them (4096) every new x11vnc fails at
// `shmget: No space left on device`, exits, and each new desktop dies as "timed out waiting for VNC" — seen for 19 hours.
//
// Two layers here: a sweep of the dead ones, and a headroom check spawnDesktop runs before x11vnc (which, when the
// table is still near full, starts x11vnc with -noshm: slower polling, but a desktop instead of none).
import fs from 'node:fs';

export interface ShmSegment { key: number; id: number; cpid: number; nattch: number; uid: number; ctime: number }

/** /proc/sysvipc/shm → segments. Empty off Linux or when it can't be read. */
export function readSegments(text?: string): ShmSegment[] {
  let raw = text;
  if (raw === undefined) {
    try { raw = fs.readFileSync('/proc/sysvipc/shm', 'utf8'); } catch { return []; }
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const head = (lines.shift() || '').trim().split(/\s+/);
  const col = (n: string) => head.indexOf(n);
  const at = { key: col('key'), id: col('shmid'), cpid: col('cpid'), nattch: col('nattch'), uid: col('uid'), ctime: col('ctime') };
  if (Object.values(at).some((i) => i < 0)) return [];
  return lines.map((l) => {
    const f = l.trim().split(/\s+/).map(Number);
    return { key: f[at.key], id: f[at.id], cpid: f[at.cpid], nattch: f[at.nattch], uid: f[at.uid], ctime: f[at.ctime] };
  });
}

/**
 * Which segments are garbage: ours (uid), private (key 0 — nobody can find them by key), attached by no one, their
 * creator gone, and older than minAgeSec (a segment between shmget and shmat is briefly unattached). A segment anyone
 * still has attached is never touched.
 */
export function orphanSegments(segs: ShmSegment[], o: { uid: number; nowSec: number; minAgeSec: number; alive: (pid: number) => boolean }): ShmSegment[] {
  return segs.filter((s) => s.uid === o.uid && s.key === 0 && s.nattch === 0 && o.nowSec - s.ctime >= o.minAgeSec && !o.alive(s.cpid));
}

const pidAlive = (pid: number) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Remove our orphaned segments. Returns how many went. */
export function sweepShm(minAgeSec = 600): number {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return 0;
  const dead = orphanSegments(readSegments(), { uid: process.getuid(), nowSec: Math.floor(Date.now() / 1000), minAgeSec, alive: pidAlive });
  if (!dead.length) return 0;
  // ipcrm takes many ids at once (one already gone fails only itself); chunks keep the argv small
  for (let i = 0; i < dead.length; i += 200) {
    try {
      Bun.spawnSync(['ipcrm', ...dead.slice(i, i + 200).flatMap((s) => ['-m', String(s.id)])], { stdout: 'ignore', stderr: 'ignore' });
    } catch {
      break; // no ipcrm on this box
    }
  }
  const left = new Set(readSegments().map((s) => s.id));
  const removed = dead.filter((s) => !left.has(s.id)).length;
  if (removed) console.log(`[desktops] removed ${removed} orphaned shared-memory segment(s) left by killed desktops`);
  return removed;
}

/** Segments the system still allows (kernel.shmmni minus what exists), or null when unknown. */
export function shmHeadroom(): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const max = Number(fs.readFileSync('/proc/sys/kernel/shmmni', 'utf8').trim());
    return Number.isFinite(max) ? max - readSegments().length : null;
  } catch {
    return null;
  }
}

/** x11vnc's polling needs ~42 segments; below this much headroom a desktop starts with -noshm instead. */
export const X11VNC_SHM_NEED = 64;
