// Ticket sessions: the workspace the launcher's plan panel promises, made by the
// host itself — a worktree on a ticket branch in a ready repo, plus a dev-server
// port from the pool. The panel shows `planTicket()`'s answer, which reserves the
// port it displays, and the create path calls `provisionTicket()` with that same
// reservation, so what was shown is what the session gets. Nothing here depends
// on which skill (if any) the session runs.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as state from './state.js';
import { cfg, nano, untildify } from './state.js';
import { addWorktree } from './git.js';

// ---- naming --------------------------------------------------------------

export function ticketSlug(title: string | null | undefined): string {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/, '');
}

/** `feat/<id>-<title slug>` — the ticket id first, so tools that key on it find it. */
export function ticketBranch(ticket: string, title?: string | null): string {
  const id = String(ticket).toLowerCase().replace(/[^a-z0-9-]/g, '');
  // A pasted ticket's title is often just its id — don't repeat it.
  let s = ticketSlug(title);
  if (s === id) s = '';
  else if (s.startsWith(`${id}-`)) s = s.slice(id.length + 1);
  return `feat/${s ? `${id}-${s}` : id}`;
}

/** `<reposDir>/<repo>-wt-<id>` — beside the repo, like every other host worktree. */
export function ticketWorktreeDir(reposDir: string, repo: string, ticket: string): string {
  const id = String(ticket).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return path.join(untildify(reposDir) as string, `${repo}-wt-${id}`);
}

// ---- ports ---------------------------------------------------------------

// A reservation holds a port between "shown in the plan panel" and "session
// created". Short-lived: a launcher left open doesn't hold the pool forever.
const RESERVATION_TTL_MS = 15 * 60_000;
const reservations = new Map<string, { port: number; ticket: string; expires: number }>();

function sweep(now = Date.now()): void {
  for (const [k, r] of reservations) if (r.expires <= now) reservations.delete(k);
}

/** Ports promised to a launcher but not yet claimed by a session. */
export function reservedPorts(): Set<number> {
  sweep();
  return new Set([...reservations.values()].map((r) => r.port));
}

/** Ports live sessions already own (metadata.port). */
function sessionPorts(): Set<number> {
  return new Set(
    state
      .listSessions()
      .filter((s: any) => !s.archived)
      .map((s: any) => Number(s.metadata?.port))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
}

/** Is anything listening on this port right now? (bind test on all interfaces) */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** First port in [lo, hi] that no session owns, nobody reserved and nothing listens on. */
export async function pickFreePort(
  range: [number, number],
  taken: Set<number>,
  probe: (p: number) => Promise<boolean> = portFree
): Promise<number | null> {
  const [lo, hi] = range;
  for (let p = lo; p <= hi; p++) {
    if (taken.has(p)) continue;
    if (await probe(p)) return p;
  }
  return null;
}

const poolRange = (): [number, number] => cfg.dispatcher.portRange;
const takenPorts = (): Set<number> => new Set([...sessionPorts(), ...reservedPorts()]);

/**
 * Reserve a port for a ticket's plan. Passing the previous reservation back
 * (the panel re-plans on a repo change) keeps the same port while it's still free.
 */
export async function reservePort(
  ticket: string,
  prev?: string | null,
  probe: (p: number) => Promise<boolean> = portFree
): Promise<{ port: number; reservation: string } | null> {
  sweep();
  const old = prev ? reservations.get(prev) : undefined;
  if (old && old.ticket === ticket && !sessionPorts().has(old.port) && (await probe(old.port))) {
    old.expires = Date.now() + RESERVATION_TTL_MS;
    return { port: old.port, reservation: prev! };
  }
  if (prev) reservations.delete(prev);
  const port = await pickFreePort(poolRange(), takenPorts(), probe);
  if (port == null) return null;
  const reservation = 'rsv_' + nano();
  reservations.set(reservation, { port, ticket, expires: Date.now() + RESERVATION_TTL_MS });
  return { port, reservation };
}

/**
 * Turn a reservation into the session's port. The reserved port when it's still
 * free; otherwise the next free one, with a note saying why it changed.
 */
export async function claimPort(
  ticket: string,
  reservation?: string | null,
  probe: (p: number) => Promise<boolean> = portFree
): Promise<{ port: number | null; note?: string }> {
  sweep();
  const r = reservation ? reservations.get(reservation) : undefined;
  if (reservation) reservations.delete(reservation);
  if (r && r.ticket === ticket && !sessionPorts().has(r.port) && (await probe(r.port))) return { port: r.port };
  const port = await pickFreePort(poolRange(), takenPorts(), probe);
  if (r && port != null) return { port, note: `port ${r.port} was taken meanwhile` };
  return port == null ? { port: null, note: 'the port pool is exhausted' } : { port };
}

// ---- repos ---------------------------------------------------------------

/** Names of the repos onboarding reports as ready (cloned + installed). */
export async function readyRepoNames(): Promise<string[]> {
  const ob = await import('./onboarding.js');
  return ob.readyRepos();
}

async function repoPath(name: string): Promise<string> {
  const ob = await import('./onboarding.js');
  const stored = ob.listRepos().find((r) => r.name === name);
  return stored ? ob.repoDir(stored) : path.join(untildify(cfg.reposDir) as string, name);
}

async function run(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: code === 0 ? out : err.trim() || out };
}

/** The worktree that already has `branch` checked out, if any (a ticket relaunched while its old worktree was kept). */
async function worktreeOnBranch(repoDir: string, branch: string): Promise<string | null> {
  const r = await run(repoDir, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return null;
  let dir: string | null = null;
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice(9).trim();
    else if (line.trim() === `branch refs/heads/${branch}` && dir) return dir;
  }
  return null;
}

async function baseBranch(repoDir: string, name: string): Promise<string> {
  const ob = await import('./onboarding.js');
  const stored = ob.listRepos().find((r) => r.name === name);
  const configured = stored ? ob.resolveRepo(stored).branch : undefined;
  if (configured) return configured;
  const head = await run(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const b = head.code === 0 ? head.out.trim() : '';
  return b && b !== 'HEAD' ? b : 'main';
}

// ---- plan + provision ----------------------------------------------------

/** Seams for tests: where ready repos, repo paths and the port probe come from. */
export interface ProvisionDeps {
  repos: () => Promise<string[]>;
  repoDir: (name: string) => Promise<string>;
  probe: (port: number) => Promise<boolean>;
}
const DEPS: ProvisionDeps = { repos: readyRepoNames, repoDir: repoPath, probe: portFree };

export interface TicketPlan {
  ticket: string;
  repos: string[];
  repo: string | null;
  dir: string | null;
  branch: string;
  base: string | null;
  reuse: boolean; // the branch already has a worktree — it's reused, not re-made
  port: number | null;
  reservation: string | null;
  error?: string;
}

/** What `provisionTicket` will do for this ticket — and the port it holds for it. */
export async function planTicket(o: {
  ticket: string;
  title?: string | null;
  repo?: string | null;
  reservation?: string | null;
}, deps: Partial<ProvisionDeps> = {}): Promise<TicketPlan> {
  const d = { ...DEPS, ...deps };
  const ticket = String(o.ticket).toUpperCase();
  const repos = await d.repos();
  const repo = o.repo && repos.includes(o.repo) ? o.repo : repos[0] || null;
  const branch = ticketBranch(ticket, o.title);
  const held = await reservePort(ticket, o.reservation, d.probe);
  const base = { ticket, repos, repo, branch, port: held?.port ?? null, reservation: held?.reservation ?? null };
  if (!repo) return { ...base, dir: null, base: null, reuse: false, error: 'no ready repo' };
  const repoDir = await d.repoDir(repo);
  const existing = await worktreeOnBranch(repoDir, branch);
  let dir = existing || ticketWorktreeDir(cfg.reposDir, repo, ticket);
  if (!existing && fs.existsSync(dir)) dir = `${dir}-${nano().slice(0, 4).toLowerCase()}`;
  return { ...base, dir, base: await baseBranch(repoDir, repo), reuse: !!existing };
}

export interface TicketProvision {
  ok: boolean; // the worktree exists and the session runs in it
  repo: string | null;
  dir: string | null;
  branch: string;
  base: string | null;
  reused: boolean;
  port: number | null;
  error?: string; // why there is no worktree
  notes: string[]; // anything that changed from the plan, or half-worked
}

/** Make the worktree + claim the port. Never throws: a failure is reported, and the session starts anyway. */
export async function provisionTicket(o: {
  ticket: string;
  title?: string | null;
  repo?: string | null;
  reservation?: string | null;
}, deps: Partial<ProvisionDeps> = {}): Promise<TicketProvision> {
  const d = { ...DEPS, ...deps };
  const ticket = String(o.ticket).toUpperCase();
  const notes: string[] = [];
  const { port, note } = await claimPort(ticket, o.reservation, d.probe);
  if (note) notes.push(note);
  const branch = ticketBranch(ticket, o.title);
  const fail = (error: string, extra: Partial<TicketProvision> = {}): TicketProvision => ({
    ok: false, repo: null, dir: null, branch, base: null, reused: false, port, error, notes, ...extra,
  });
  try {
    const repos = await d.repos();
    const repo = o.repo && repos.includes(o.repo) ? o.repo : repos[0] || null;
    if (o.repo && repo !== o.repo) notes.push(`repo ${o.repo} is not ready`);
    if (!repo) return fail('no ready repo');
    const repoDir = await d.repoDir(repo);
    const base = await baseBranch(repoDir, repo);
    const existing = await worktreeOnBranch(repoDir, branch);
    if (existing && fs.existsSync(existing)) {
      return { ok: true, repo, dir: existing, branch, base, reused: true, port, notes };
    }
    let dir = ticketWorktreeDir(cfg.reposDir, repo, ticket);
    if (fs.existsSync(dir)) dir = `${dir}-${nano().slice(0, 4).toLowerCase()}`;
    const r = await addWorktree(repoDir, dir, branch, base);
    if (!r.ok) return fail(r.error || 'git worktree add failed', { repo, base });
    for (const [where, inst] of Object.entries(r.install || {}))
      if (inst && !inst.ok) notes.push(`dependency install failed in ${where === 'root' ? 'the worktree' : where}/ — run it yourself`);
    return { ok: true, repo, dir: r.dir, branch, base, reused: false, port, notes };
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** The first chat event of a provisioned ticket session — what the host actually did. */
export function provisionReport(p: TicketProvision): string {
  const port = p.port != null ? `dev server port :${p.port} ($PORT)` : 'no dev server port';
  const head = p.ok
    ? `⤷ Workspace ready — ${p.reused ? 'reusing' : 'created'} worktree ${p.dir} on branch ${p.branch}${p.base && !p.reused ? ` (from ${p.base})` : ''}, ${port}`
    : `⚠ No worktree — ${p.error}. The session starts in its working folder, ${port}`;
  return p.notes.length ? `${head}. Note: ${p.notes.join('; ')}.` : `${head}.`;
}

/** Appended to the first prompt so the agent knows where it is without re-provisioning. */
export function provisionPromptBlock(p: TicketProvision): string {
  const lines = ['## Workspace (set up by the host)'];
  if (p.ok) {
    lines.push(`- Worktree: ${p.dir} (your working directory) — repo ${p.repo}, branch ${p.branch}${p.reused ? ' (existing worktree, reused)' : ''}.`);
    lines.push('- Do not create another worktree for this ticket.');
  } else {
    lines.push(`- No worktree could be created: ${p.error}.`);
  }
  lines.push(p.port != null ? `- Dev server port: ${p.port}, exported as $PORT.` : '- No dev server port was allocated.');
  return lines.join('\n');
}
