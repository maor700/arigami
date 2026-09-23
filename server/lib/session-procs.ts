// Which processes belong to which session — found by the env marker, not by
// the process tree.
//
// THE BUG THIS FIXES. Killing a session used to mean killing its agent's
// process tree. Agents start dev servers and Storybook as `cmd & sleep 2`, and
// the backgrounded process is reparented to init the moment its shell exits —
// it is no longer in anybody's tree. Measured on the cloud host: three
// Storybooks (4.5 GB between them) and a vite were children of PID 1, and two
// of the Storybooks belonged to sessions that were still open but had started
// them twice. Nothing could reach them, so nothing ever stopped them.
//
// What does survive detaching is the environment. Every session is spawned
// with ARIGAMI_SESSION_ID (and, from this change, ARIGAMI_HOST_ID), and every
// process it starts inherits both — through `&`, `nohup`, `setsid`, a codex
// app-server, anything short of an explicit `env -i`. So the marker, not the
// tree, is the ownership record.
//
// Reading another process's environment:
//   linux   /proc/<pid>/environ — only our own user's processes are readable,
//           which is exactly the set we are allowed to kill anyway
//   darwin  `ps eww` appends the environment to the command line for our own
//           processes — except Apple's own SIP-protected binaries (/bin/sh,
//           /bin/sleep, zsh), whose environment macOS hides even from their
//           owner. Measured: a detached `bun` shows its marker, a detached
//           `/bin/sleep` does not. What leaks on a dev box is node/bun/Chrome,
//           which are visible; a bare shell wrapper exits once its child dies.
//   win32   not readable without a debugger handle. `list()` returns null
//           ("could not look") rather than [] ("found nothing"), and callers
//           fall back to the supervised-children record.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pidAlive } from './platform.js';
import { HOST_ID } from './children.js';

/**
 * This host's marker, as it appears in ARIGAMI_HOST_ID. HOST_ID itself is
 * `<dir>#<port>` — a path, which may hold spaces and would not survive being
 * read back out of `ps eww` output — so the env carries a short hash of it.
 */
export const HOST_MARK: string = crypto.createHash('sha1').update(HOST_ID).digest('hex').slice(0, 16);

export interface Marked {
  pid: number;
  session: string;
  /** Absent on processes a host started before ARIGAMI_HOST_ID existed. */
  host: string | null;
}

const SESSION_RE = /(?:^|[\s\0])ARIGAMI_SESSION_ID=([A-Za-z0-9_-]+)/;
const HOST_RE = /(?:^|[\s\0])ARIGAMI_HOST_ID=([A-Za-z0-9]+)/;

/** Pull the two markers out of an environment dump (NUL- or space-separated). */
export function parseMarkers(env: string): { session: string | null; host: string | null } {
  return {
    session: SESSION_RE.exec(env)?.[1] ?? null,
    host: HOST_RE.exec(env)?.[1] ?? null,
  };
}

/** `ps eww -Ao pid=,command=` → marked rows. Exported for tests. */
export function parsePsEww(out: string): Marked[] {
  const rows: Marked[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const { session, host } = parseMarkers(' ' + m[2]);
    if (session) rows.push({ pid: Number(m[1]), session, host });
  }
  return rows;
}

function listLinux(): Marked[] {
  const rows: Marked[] = [];
  let pids: string[];
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return rows;
  }
  for (const p of pids) {
    let env: string;
    try {
      env = fs.readFileSync(`/proc/${p}/environ`, 'latin1');
    } catch {
      continue; // another user's process, or it exited while we looked
    }
    const { session, host } = parseMarkers(env);
    if (session) rows.push({ pid: Number(p), session, host });
  }
  return rows;
}

function listPs(): Marked[] | null {
  try {
    const r = Bun.spawnSync(['ps', 'eww', '-Ao', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore', timeout: 8000 });
    if (!r.success) return null;
    return parsePsEww(new TextDecoder().decode(r.stdout));
  } catch {
    return null;
  }
}

/** Every process carrying a session marker. null = this platform can't tell. */
export function list(): Marked[] | null {
  if (process.platform === 'win32') return null;
  const rows = process.platform === 'linux' ? listLinux() : listPs();
  if (!rows) return null;
  // Never ourselves: a host started from inside a session's shell (a test host,
  // a manual `bun server/index.ts`) inherits that session's marker, and
  // deleting the session must not take the host down with it.
  return rows.filter((r) => r.pid !== process.pid && r.pid !== process.ppid);
}

/**
 * The processes to stop for `sessionId`. A marker from ANOTHER host is left
 * alone — two instances on one machine (a laptop host and a test sandbox) can't
 * reach each other's sessions. An unmarked-host process is ours if the session
 * id matches: session ids are random and only this host hands out its own.
 */
export function ofSession(rows: Marked[], sessionId: string, hostId: string): Marked[] {
  return rows.filter((r) => r.session === sessionId && (r.host === null || r.host === hostId));
}

/**
 * Processes whose session no longer exists. Only ones that carry OUR host id:
 * a legacy process with no host marker could belong to another instance on the
 * same machine, and "we don't know whose this is" is not a reason to kill it.
 */
export function orphans(rows: Marked[], liveSessionIds: Set<string>, hostId: string): Marked[] {
  return rows.filter((r) => r.host === hostId && !liveSessionIds.has(r.session));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * SIGTERM everything, wait for it to exit, SIGKILL what is left. Waiting is the
 * point: a worktree removed while its dev server or typecheck is still running
 * gets written back into — that is how an empty `abc-21033/` holding only a
 * fresh tsconfig.tsbuildinfo outlived its session.
 */
export async function stop(pids: number[], graceMs = 4000): Promise<{ stopped: number[]; survived: number[] }> {
  const targets = [...new Set(pids)].filter((p) => p > 1 && p !== process.pid);
  for (const p of targets) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && targets.some(pidAlive)) await sleep(100);
  for (const p of targets.filter(pidAlive)) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* raced us */
    }
  }
  const hard = Date.now() + 1500;
  while (Date.now() < hard && targets.some(pidAlive)) await sleep(50);
  return { stopped: targets.filter((p) => !pidAlive(p)), survived: targets.filter(pidAlive) };
}
