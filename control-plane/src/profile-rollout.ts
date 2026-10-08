// Profile rollout: converge every running tenant to the org profile at
// CP_ARIGAMI_BUNDLE @ CP_ARIGAMI_BUNDLE_REF — the profile-shaped twin of the
// image convergence in src/reconcile.ts + src/upgrade.ts.
//
// A tenant applies ARIGAMI_BUNDLE once, on its first boot. Publishing a new
// profile version used to reach nobody who already existed; now each reconcile
// tick:
//
//   1. resolves the desired ref to ONE commit (`git ls-remote`, token as a
//      header) — a branch that moves mid-rollout cannot hand two tenants two
//      different profiles, and the canary that passed is exactly what the rest
//      of the fleet gets;
//   2. walks running tenants in rollout order (ring `canary` first, then oldest
//      first) and, for each one decideProfile() says needs it, reads the
//      tenant's own provenance (GET /__api/profiles/rollout) and — when the
//      commit differs and no turn is in flight — asks it to re-apply
//      (POST /__api/profiles/rollout). Both are operator calls signed with the
//      per-tenant handoff secret (src/handoff.ts mintOperator) over loopback
//      (kubectl exec, like the busy probe);
//   3. stops on the first failed apply. While that failure stands for the
//      desired commit, every OTHER tenant is held back ("halted") and only the
//      failed one is retried, with exponential backoff. Fixing the profile
//      (publishing a new commit) or a successful retry releases the halt.
//
// What counts as "applied" is what the tenant REPORTS (its provenance commit,
// with no apply errors), never what we asked for — drift is visible, and a
// tenant whose pod restarted onto the right commit by itself is simply
// confirmed, not re-applied.
import type { Config } from './config.js';
import type { Store, Tenant } from './db.js';
import { mintOperator } from './handoff.js';
import * as provisioner from './provisioner.js';

export const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const GIT_REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
export const DESIRED_META_KEY = 'profile.desired';

export interface DesiredProfile {
  source: string;
  ref: string; // as configured ('' = default branch)
  commit: string; // what it resolved to
  resolvedAt: number;
}

/** What the admin page shows about the desired side (stored in the meta table each tick). */
export interface DesiredRecord {
  ref: string;
  commit: string;
  resolvedAt: number;
  error?: string;
}

/** Same test the host uses (server/profiles.ts isGitUrl) — only a git source has refs to roll out. */
export function isGitSource(s: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s) || /\.git$/.test(s);
}

export function rolloutEnabled(cfg: Config): boolean {
  return cfg.profileRollout && !!cfg.arigamiBundle && isGitSource(cfg.arigamiBundle);
}

// ---- resolving the desired ref ---------------------------------------------------

/**
 * Git env for reading `url` with the org's read-only token: an http.extraheader
 * scoped to that URL's origin (the shape of server/lib/git-auth.ts — this
 * service imports nothing from server/). Only for https; the token is never put
 * in a URL, so it cannot reach a log, an error message or a process list.
 */
export function gitAuthEnv(url: string, token: string): Record<string, string> {
  if (!token) return {};
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return {};
  }
  if (u.protocol !== 'https:') return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${u.protocol}//${u.host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Pick the commit `ref` names out of `git ls-remote` output: an annotated tag's peeled commit, a tag, a branch, or a full ref name. */
export function parseLsRemote(out: string, ref: string): string | null {
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name && COMMIT_RE.test(sha)) refs.set(name, sha);
  }
  const want = ref || 'HEAD';
  const candidates = want.startsWith('refs/') || want === 'HEAD'
    ? [`${want}^{}`, want]
    : [`refs/tags/${want}^{}`, `refs/tags/${want}`, `refs/heads/${want}`];
  for (const c of candidates) if (refs.has(c)) return refs.get(c)!;
  return null;
}

export type GitRunner = (args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;

const runGit: GitRunner = async (args, env) => {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 60_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};

/** Strip anything credential-shaped from a message before it is logged or stored. */
export function redact(msg: string): string {
  return String(msg).replace(/(\/\/)[^/@\s]+@/g, '$1***@').replace(/(authorization:\s*\w+\s+)\S+/gi, '$1***');
}

export async function resolveDesired(cfg: Config, git: GitRunner = runGit, now = Date.now()): Promise<DesiredProfile> {
  const source = cfg.arigamiBundle;
  const ref = cfg.arigamiBundleRef.trim();
  if (ref && !GIT_REF_RE.test(ref)) throw new Error(`CP_ARIGAMI_BUNDLE_REF is not a valid git ref: ${JSON.stringify(ref)}`);
  if (COMMIT_RE.test(ref)) return { source, ref, commit: ref, resolvedAt: now };
  const r = await git(['ls-remote', source], gitAuthEnv(source, cfg.arigamiGitToken));
  if (r.code !== 0) throw new Error(`git ls-remote failed: ${redact((r.stderr || '').trim().split('\n').pop() || `exit ${r.code}`)}`);
  const commit = parseLsRemote(r.stdout, ref);
  if (!commit) throw new Error(`ref ${JSON.stringify(ref || 'HEAD')} not found in the profile repo`);
  return { source, ref, commit, resolvedAt: now };
}

// ---- the convergence decision (pure) ---------------------------------------------

export type ProfileDecision =
  | { action: 'skip'; reason: 'not-running' | 'no-secret' | 'converged' | 'backoff' | 'halted' }
  | { action: 'converge'; reason: 'new' | 'retry' | 'recheck' };

export interface DecisionContext {
  /** ns of the tenant whose failed apply of the desired commit is holding the rollout, if any */
  haltedBy: string | null;
  now: number;
  /** re-read a converged tenant's provenance after this long (drift); 0 = never */
  recheckSec: number;
}

export function decideProfile(t: Tenant, desired: { commit: string }, ctx: DecisionContext): ProfileDecision {
  if (t.state !== 'running') return { action: 'skip', reason: 'not-running' };
  if (!t.handoff_secret) return { action: 'skip', reason: 'no-secret' }; // pre-handoff tenant: it cannot verify an operator call
  if (t.profile_failed_commit === desired.commit && t.profile_failures > 0) {
    if (ctx.now < t.profile_next_at) return { action: 'skip', reason: 'backoff' };
    return { action: 'converge', reason: 'retry' }; // the failed tenant is the one allowed through
  }
  if (ctx.haltedBy && ctx.haltedBy !== t.ns) return { action: 'skip', reason: 'halted' };
  if (t.profile_commit === desired.commit) {
    if (ctx.recheckSec > 0 && ctx.now - t.profile_checked_at >= ctx.recheckSec * 1000) return { action: 'converge', reason: 'recheck' };
    return { action: 'skip', reason: 'converged' };
  }
  return { action: 'converge', reason: 'new' };
}

/** The tenant whose unresolved failure of `commit` halts the rollout (deleted tenants do not count). */
export function haltingTenant(tenants: Tenant[], commit: string): Tenant | null {
  return tenants.find((t) => t.state !== 'deleted' && t.profile_failed_commit === commit && t.profile_failures > 0) || null;
}

/** Canary ring first, then oldest first (listTenants order, kept stable). */
export function rolloutOrder(tenants: Tenant[]): Tenant[] {
  return [...tenants.filter((t) => t.ring === 'canary'), ...tenants.filter((t) => t.ring !== 'canary')];
}

export function backoffMs(failures: number, cfg: Pick<Config, 'profileRetryBaseSec' | 'profileRetryMaxSec'>): number {
  const sec = Math.min(cfg.profileRetryBaseSec * 2 ** Math.max(0, failures - 1), cfg.profileRetryMaxSec);
  return sec * 1000;
}

// ---- talking to the tenant -------------------------------------------------------

export interface TenantProfileStatus {
  configured: boolean;
  commit: string;
  ref: string;
  errors: number;
  busySessions: number;
}

export interface ApplyOutcome {
  ok: boolean;
  /** the tenant had a turn in flight (or another apply running) — not a failure, retry next tick */
  busy?: boolean;
  commit?: string;
  error?: string;
}

export interface ProfileOps {
  status(t: Tenant): Promise<TenantProfileStatus>;
  apply(t: Tenant, d: DesiredProfile): Promise<ApplyOutcome>;
}

export function realProfileOps(cfg: Config): ProfileOps {
  return {
    async status(t) {
      const r = await provisioner.tenantOperatorCall(cfg, t, 'GET', mintOperator(t.handoff_secret, { action: 'profile-status' }));
      if (r.status !== 200) throw new Error(`profile status HTTP ${r.status}: ${r.body?.error || 'no body'}`);
      const b = r.body || {};
      return {
        configured: b.configured === true,
        commit: String(b.current?.commit || ''),
        ref: String(b.current?.ref || ''),
        errors: Array.isArray(b.current?.errors) ? b.current.errors.length : 0,
        busySessions: Number(b.busySessions) || 0,
      };
    },
    async apply(t, d) {
      const token = mintOperator(t.handoff_secret, { action: 'profile-apply', ref: d.ref, commit: d.commit });
      // A profile apply can install extensions (git clones) — give it room, well past the helm timeout.
      const r = await provisioner.tenantOperatorCall(cfg, t, 'POST', token, { timeoutMs: 600_000 });
      if (r.status === 409) return { ok: false, busy: true, error: r.body?.error };
      if (r.status === 200 && r.body?.ok) return { ok: true, commit: String(r.body.commit || '') };
      const errs = Array.isArray(r.body?.errors) && r.body.errors.length ? r.body.errors.join('; ') : r.body?.error;
      return { ok: false, error: `HTTP ${r.status}: ${errs || 'apply failed'}` };
    },
  };
}

// ---- one pass over the fleet -----------------------------------------------------

export interface ProfileSummary {
  commit: string;
  applied: string[];
  confirmed: string[];
  busy: string[];
  failed: string[];
  unreachable: string[];
  unconfigured: string[];
  /** ns holding the rollout (a failed apply of the desired commit), if any */
  halted: string | null;
}

export async function profilePass(
  cfg: Config,
  store: Store,
  ops: ProfileOps,
  desired: DesiredProfile,
  opts: { skip?: Set<string>; log?: (m: string) => void; now?: number } = {},
): Promise<{ summary: ProfileSummary; touched: Set<string> }> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? Date.now();
  const skip = opts.skip ?? new Set<string>();
  const touched = new Set<string>();
  const sum: ProfileSummary = { commit: desired.commit, applied: [], confirmed: [], busy: [], failed: [], unreachable: [], unconfigured: [], halted: null };
  const tenants = store.listTenants();
  const holder = haltingTenant(tenants, desired.commit);
  sum.halted = holder?.ns ?? null;
  const short = desired.commit.slice(0, 12);
  let applies = 0;

  for (const t of rolloutOrder(tenants)) {
    if (skip.has(t.ns)) continue; // already had a lifecycle action this tick (an image upgrade)
    const d = decideProfile(t, desired, { haltedBy: sum.halted, now, recheckSec: cfg.profileRecheckSec });
    if (d.action === 'skip') continue;
    if (cfg.profileBatch > 0 && applies >= cfg.profileBatch) break;

    let st: TenantProfileStatus;
    try {
      st = await ops.status(t);
    } catch (e) {
      // Unreadable ≠ failed: nothing was attempted. Fail closed (no apply) and try again next tick.
      sum.unreachable.push(t.ns);
      log(`[profile] ${t.ns} status unreadable — skipped: ${redact((e as Error).message)}`);
      continue;
    }
    if (!st.configured) {
      sum.unconfigured.push(t.ns);
      continue; // provisioned before CP_ARIGAMI_BUNDLE was set — it converges once re-provisioned
    }
    if (st.commit === desired.commit && st.errors === 0) {
      store.setProfileApplied(t.subject, desired.commit, st.ref || desired.ref, now);
      sum.confirmed.push(t.ns);
      if (sum.halted === t.ns) sum.halted = null;
      continue;
    }
    if (st.busySessions > 0) {
      sum.busy.push(t.ns);
      log(`[profile] ${t.ns} busy (${st.busySessions}) — profile ${short} deferred`);
      continue;
    }

    applies++;
    touched.add(t.ns);
    let out: ApplyOutcome;
    try {
      out = await ops.apply(t, desired);
    } catch (e) {
      out = { ok: false, error: (e as Error).message };
    }
    if (out.busy) {
      sum.busy.push(t.ns);
      log(`[profile] ${t.ns} became busy — profile ${short} deferred`);
      continue;
    }
    if (out.ok && out.commit === desired.commit) {
      store.setProfileApplied(t.subject, desired.commit, desired.ref, now);
      sum.applied.push(t.ns);
      if (sum.halted === t.ns) sum.halted = null;
      log(`[profile] ${t.ns} applied ${desired.ref || 'HEAD'}@${short}`);
      continue;
    }
    const error = redact(out.ok ? `tenant applied ${out.commit || '(unknown)'} instead of ${desired.commit}` : out.error || 'apply failed');
    const failures = t.profile_failed_commit === desired.commit ? t.profile_failures + 1 : 1;
    const nextAt = now + backoffMs(failures, cfg);
    store.setProfileFailed(t.subject, desired.commit, error, nextAt);
    sum.failed.push(t.ns);
    sum.halted = t.ns;
    log(`[profile] ${t.ns} apply of ${short} FAILED (#${failures}, retry in ${Math.round((nextAt - now) / 1000)}s) — rollout halted: ${error}`);
    break; // canary rule: never carry a profile that just failed to the next tenant
  }
  return { summary: sum, touched };
}
