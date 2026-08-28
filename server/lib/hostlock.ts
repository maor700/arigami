// Host lock (T5 §5): one running host per identity (ARIGAMI_DIR + port).
//
// Startup order matters: this check runs BEFORE sweepOrphans() — the sweep
// kills processes, and the one thing it must never do is run inside a second
// copy of an already-live host (that's the bug that took down every session
// on the machine). Two independent signals, either one refuses the boot:
//   1. run/host.json names a live pid on the same port  → same instance twice.
//   2. the port is already bound (pm2/systemd hosts write no pidfile at all)
//      → somebody is serving this identity; we are not it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pidAlive } from './platform.js';
import { ARIGAMI_DIR, RUN_DIR, HOST_PID_FILE, HOST_INFO_FILE, makeHostId } from './instance.js';

export interface HostInfo {
  pid: number;
  port: number;
  hostId: string;
  dir: string;
  startedAt: number;
}

export function readHostInfo(file = HOST_INFO_FILE): HostInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && Number.isFinite(raw.pid) ? (raw as HostInfo) : null;
  } catch {
    return null;
  }
}

/** Pure: given the recorded host (if any), decide whether this boot may proceed. Exported for tests. */
export function judgeHostInfo(
  prev: HostInfo | null,
  me: { pid: number; port: number },
  isAlive: (pid: number) => boolean
): { ok: true; warn?: string } | { ok: false; reason: string } {
  if (!prev || prev.pid === me.pid || !isAlive(prev.pid)) return { ok: true };
  if (prev.port === me.port)
    return {
      ok: false,
      reason: `another arigami host (pid ${prev.pid}) is already running for ${ARIGAMI_DIR} on :${prev.port} — the same instance can't run twice. Stop it first, or start a separate instance with its own ARIGAMI_DIR and ARIGAMI_PORT.`,
    };
  return {
    ok: true,
    warn: `host pid ${prev.pid} is already running on :${prev.port} with the SAME ARIGAMI_DIR (${ARIGAMI_DIR}); two hosts sharing one dir share state.json/chat and is unsupported — use a separate ARIGAMI_DIR.`,
  };
}

/** True when nothing can bind `port` on any local address right now. */
export function portFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * Refuse to boot if this identity is already served; otherwise record
 * ourselves. Throws with a human message on refusal — the caller exits.
 */
export async function claimHost(port: number): Promise<void> {
  const me = { pid: process.pid, port };
  const verdict = judgeHostInfo(readHostInfo(), me, pidAlive);
  if (!verdict.ok) throw new Error(verdict.reason);
  if (verdict.warn) console.warn('[host] ' + verdict.warn);
  if (!(await portFree(port)))
    throw new Error(
      `:${port} is already in use. If that's another arigami host with ARIGAMI_DIR=${ARIGAMI_DIR}, this is the same instance started twice — nothing was touched. ` +
        `To run a second, isolated instance set a different ARIGAMI_DIR and ARIGAMI_PORT.`
    );
  const info: HostInfo = { pid: me.pid, port, hostId: makeHostId(ARIGAMI_DIR, port), dir: ARIGAMI_DIR, startedAt: Date.now() };
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(HOST_INFO_FILE, JSON.stringify(info, null, 2) + '\n');
  fs.writeFileSync(HOST_PID_FILE, String(me.pid) + '\n');
}

/** Drop our host record (only if it's still ours). */
export function releaseHost(): void {
  try {
    const cur = readHostInfo();
    if (cur && cur.pid !== process.pid) return;
    fs.rmSync(HOST_INFO_FILE, { force: true });
    fs.rmSync(HOST_PID_FILE, { force: true });
  } catch {}
}

export const hostLockPaths = { runDir: RUN_DIR, pid: HOST_PID_FILE, info: HOST_INFO_FILE, dir: path.dirname(RUN_DIR) };
