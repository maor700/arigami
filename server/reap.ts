// Tearing a session down: one fixed procedure, run by the host, every time.
//
// Before this, what a deletion removed depended on three things outside the
// host's control: whether the agent had written `metadata.cleanup` (shell
// commands it composed for itself while provisioning), whether it had written
// them correctly, and whether whoever deleted the session passed
// `run_cleanup`. On a busy shared host that left detached Storybooks and vites
// running for sessions long gone, worktrees from the pr-review launcher that
// nothing had ever recorded, and dozens of stray entries in /tmp.
//
// Now: `reapSession()` is the only teardown, it takes no instructions from
// the agent, and it always runs in this order —
//   1. processes   everything carrying this session's ARIGAMI_SESSION_ID, found
//                  by env marker (session-procs.ts) so a detached dev server is
//                  found too; wait for them to exit
//   2. worktree    the one this session owns, removed only if git proves nothing
//                  in it is unique (worktree-reap.ts); otherwise kept and listed
//                  in kept-worktrees.json with the reason
//   3. scratch     the session's TMPDIR (scratch.ts)
//   4. transcript  the chat log file
// Processes go first because a worktree removed under a still-running dev
// server or typecheck gets written back into.
//
// `sweep()` is the backstop for anything that escaped — a host crash
// mid-delete, or a session deleted before this existed — and runs on a timer
// in the host, not as an agent's judgement call.
import fs from 'node:fs';
import path from 'node:path';
import * as state from './state.js';
import { worktreeInfo } from './git.js';
import * as procs from './lib/session-procs.js';
import * as wt from './lib/worktree-reap.js';
import * as scratch from './lib/scratch.js';
import { ARIGAMI_DIR } from './lib/instance.js';
import { CHROME_SESSIONS_DIR, removeSessionProfile } from './lib/chrome.js';

export const KEPT_FILE = path.join(ARIGAMI_DIR, 'kept-worktrees.json');

export interface KeptWorktree {
  dir: string;
  sessionId: string;
  title: string;
  reasons: string[];
  at: string;
}

export interface ReapReport {
  /** null = this platform can't read process environments (Windows). */
  processes: { found: number; stopped: number; survived: number[] } | null;
  worktree: wt.WorktreeResult | null;
  scratch: boolean;
  transcript: boolean;
}

function git(cwd: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore', timeout: 15_000 });
    return r.success ? new TextDecoder().decode(r.stdout).trim() : null;
  } catch {
    return null;
  }
}

const norm = (p: string) => path.resolve(p).replace(/\/+$/, '');
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

/**
 * The linked worktree this session owns, or null.
 *
 * A dispatch WORKER never owns the worktree it runs in unless the host
 * recorded one for it: a read-only worker runs in its master's checkout, and
 * removing that would destroy a live sibling (a real incident — see
 * cleanupPlan in api.ts, same rule).
 */
export async function ownedWorktree(s: any): Promise<{ dir: string; branch: string | null } | null> {
  const md = s?.metadata || {};
  let dir: string | null = null;
  if (md.role === 'worker') {
    const recorded = Array.isArray(md.cleanup) && md.cleanup.length > 0;
    if (!recorded || !md.worktree) return null;
    dir = state.untildify(md.worktree) || null;
  } else {
    const info = await worktreeInfo(s);
    if (!info.linked || !info.dir) return null;
    dir = info.dir;
  }
  if (!dir) return null;
  // cwd may be a subdirectory of the worktree; the worktree is its toplevel.
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  const root = norm(top || dir);

  // Never take a worktree another live session is working in: a chat session
  // opened inside a ticket's worktree must not remove it when it is deleted.
  for (const o of state.listSessions({ archived: true })) {
    if (o.id === s.id) continue;
    const ow = state.untildify((o.metadata as any)?.worktree) || state.untildify(o.cwd);
    if (ow && inside(norm(ow), root)) return null;
  }
  return { dir: root, branch: git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) };
}

function readKept(): KeptWorktree[] {
  try {
    const v = JSON.parse(fs.readFileSync(KEPT_FILE, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeKept(rows: KeptWorktree[]): void {
  fs.mkdirSync(path.dirname(KEPT_FILE), { recursive: true });
  fs.writeFileSync(KEPT_FILE, JSON.stringify(rows, null, 2));
}

/** Worktrees a deletion refused to remove, still on disk. */
export function keptWorktrees(): KeptWorktree[] {
  const rows = readKept();
  const alive = rows.filter((r) => fs.existsSync(r.dir));
  if (alive.length !== rows.length) writeKept(alive);
  return alive;
}

function chatFiles(sessionId: string): string[] {
  try {
    return fs
      .readdirSync(state.CHAT_DIR)
      .filter((n) => n === `${sessionId}.jsonl` || n.startsWith(`${sessionId}.`))
      .map((n) => path.join(state.CHAT_DIR, n));
  } catch {
    return [];
  }
}

/**
 * The teardown. Which parts run is fixed per caller, not chosen by an agent:
 *
 *   delete    reapSession(s, ALL)
 *   archive   reapSession(s, { processes: true })            — work and history stay,
 *             plus { worktree: true } when the operator ticks "remove worktree"
 *   merge     reapSession(s, { worktree: true })             — the session lives on
 */
export const ALL = { processes: true, worktree: true, ephemera: true } as const;

export async function reapSession(
  s: any,
  { processes = false, worktree = false, ephemera = false }: { processes?: boolean; worktree?: boolean; ephemera?: boolean }
): Promise<ReapReport> {
  const report: ReapReport = { processes: null, worktree: null, scratch: false, transcript: false };

  if (processes) {
    const rows = procs.list();
    if (rows) {
      const mine = procs.ofSession(rows, s.id, procs.HOST_MARK);
      const r = await procs.stop(mine.map((m) => m.pid));
      report.processes = { found: mine.length, stopped: r.stopped.length, survived: r.survived };
    }
  }

  if (worktree) {
    const owned = await ownedWorktree(s);
    if (owned) {
      report.worktree = wt.reap(owned.dir);
      if (report.worktree.outcome === 'kept') {
        const rows = readKept().filter((r) => r.dir !== owned.dir);
        rows.push({
          dir: owned.dir,
          sessionId: s.id,
          title: String(s.title || s.id),
          reasons: report.worktree.reasons || [],
          at: new Date().toISOString(),
        });
        writeKept(rows);
      }
    }
  }

  if (ephemera) {
    report.scratch = scratch.remove(s.id);
    for (const f of chatFiles(s.id)) {
      try {
        fs.rmSync(f, { force: true });
        report.transcript = true;
      } catch {
        /* best effort — a log file is not worth failing a delete over */
      }
    }
  }
  return report;
}

/** What a delete WOULD do — for the confirmation dialog. Changes nothing. */
export async function preview(s: any): Promise<{
  processes: { pid: number }[] | null;
  worktree: (ReturnType<typeof wt.inspect> & { dir: string }) | null;
  scratch: string | null;
}> {
  const rows = procs.list();
  const owned = await ownedWorktree(s);
  let scratchDir: string | null = null;
  try {
    const d = scratch.dirFor(s.id);
    if (fs.existsSync(d)) scratchDir = d;
  } catch {
    /* unsafe id — nothing to show */
  }
  return {
    processes: rows ? procs.ofSession(rows, s.id, procs.HOST_MARK).map((r) => ({ pid: r.pid })) : null,
    worktree: owned ? wt.inspect(owned.dir) : null,
    scratch: scratchDir,
  };
}

export interface SweepReport {
  processes: number;
  scratch: number;
  chrome: number;
  transcripts: number;
  /** Kept worktrees of deleted sessions that are clean now and were removed. */
  worktrees: number;
}

/**
 * Remove what belongs to sessions that no longer exist. Archived sessions are
 * alive for this purpose — their files are kept on purpose so unarchiving
 * resumes where it left off.
 */
export async function sweep(): Promise<SweepReport> {
  const live = new Set(state.listSessions({ archived: true }).map((s) => s.id));
  const out: SweepReport = { processes: 0, scratch: 0, chrome: 0, transcripts: 0, worktrees: 0 };

  const rows = procs.list();
  if (rows) {
    const orphans = procs.orphans(rows, live, procs.HOST_MARK);
    if (orphans.length) out.processes = (await procs.stop(orphans.map((o) => o.pid))).stopped.length;
  }
  for (const id of scratch.ids()) if (!live.has(id) && scratch.remove(id)) out.scratch++;
  try {
    for (const id of fs.readdirSync(CHROME_SESSIONS_DIR)) {
      if (!/^sess_[A-Za-z0-9_-]+$/.test(id) || live.has(id)) continue;
      removeSessionProfile(id);
      out.chrome++;
    }
  } catch {
    /* no profiles dir */
  }
  try {
    for (const n of fs.readdirSync(state.CHAT_DIR)) {
      const id = /^(sess_[A-Za-z0-9_-]+)\./.exec(n)?.[1];
      if (!id || live.has(id)) continue;
      fs.rmSync(path.join(state.CHAT_DIR, n), { force: true });
      out.transcripts++;
    }
  } catch {
    /* no chat dir */
  }
  // A worktree a delete refused to remove may have become safe since (committed
  // and pushed, or its stray edit dropped): ask the same conservative rule again.
  const rows2 = readKept();
  if (rows2.length) {
    const left = rows2.filter((r) => {
      if (live.has(r.sessionId)) return true;
      const res = wt.reap(r.dir);
      if (res.outcome === 'kept' || res.outcome === 'failed') return true;
      if (res.outcome === 'removed') out.worktrees++;
      return false;
    });
    if (left.length !== rows2.length) writeKept(left);
  }
  return out;
}

const SWEEP_EVERY_MS = 10 * 60_000;

/** Start the periodic sweep. The first pass waits so sessions can respawn. */
export function startSweeper(log: (m: string) => void = console.log): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await sweep();
      const n = r.processes + r.scratch + r.chrome + r.transcripts + r.worktrees;
      if (n)
        log(
          `[reap] swept leftovers of deleted sessions: ${r.processes} processes, ${r.scratch} scratch dirs, ` +
            `${r.chrome} browser profiles, ${r.transcripts} transcripts, ${r.worktrees} worktrees`
        );
    } catch (e) {
      log(`[reap] sweep failed: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(tick, 90_000);
  const every = setInterval(tick, SWEEP_EVERY_MS);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
