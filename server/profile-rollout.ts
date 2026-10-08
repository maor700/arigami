// Profile rollout, tenant side: the TRUSTED re-apply of the org's profile.
//
// ARIGAMI_BUNDLE is applied once, on a fresh data dir (profiles.ts
// applyBundleEnv). A new profile version reaches an existing tenant through
// this module instead: the control-plane (control-plane/src/profile-rollout.ts)
// resolves the ref it wants to one commit and calls
//
//   GET  /__api/profiles/rollout   → what this tenant last applied (+ last attempt, busy count)
//   POST /__api/profiles/rollout   → re-apply the configured bundle at the token's ref/commit
//
// Both carry an operator token in the `x-arigami-operator` header, signed with
// the per-tenant ARIGAMI_HANDOFF_SECRET (server/handoff.ts verifyOperator).
// Nothing else opens these routes — not a signed-in user, not a session token:
// the apply is trusted (extensions install, cron jobs start enabled), which is
// only right when the org's operator asked for it. With no secret the routes
// are off.
//
// What the caller can choose is deliberately narrow: the ref/commit, as signed
// claims. The SOURCE is always this host's own ARIGAMI_BUNDLE, so even a leaked
// token can only re-apply the org's own repo, once.
//
// Safety:
//   - never while a turn is in flight (409, the control-plane retries next tick)
//   - one apply at a time (409)
//   - the bundle is loaded and validated BEFORE anything is touched: a profile
//     that does not validate fails the call and changes nothing on the host
//   - every attempt is recorded in $ARIGAMI_DIR/profile-rollout.json; the
//     applied ref/commit lands in the provenance (profile.json) like any apply
import fs from 'node:fs';
import path from 'node:path';
import { ARIGAMI_DIR } from './lib/instance.js';
import * as pf from './profiles.js';

export const ATTEMPT_FILE = path.join(ARIGAMI_DIR, 'profile-rollout.json');

export interface RolloutAttempt {
  at: string;
  ref?: string;
  commit?: string;
  ok: boolean;
  /** the commit actually applied (ok) */
  applied?: string;
  error?: string;
}

export interface RolloutStatus {
  configured: boolean;
  current: { name: string; version?: string; ref?: string; commit?: string; appliedAt: string; errors: string[] } | null;
  lastAttempt: RolloutAttempt | null;
  busySessions: number;
  applying: boolean;
}

export interface RolloutDeps {
  busySessions: () => number;
  env?: NodeJS.ProcessEnv;
}

let applying = false;

function readAttempt(): RolloutAttempt | null {
  try {
    return JSON.parse(fs.readFileSync(ATTEMPT_FILE, 'utf8'))?.lastAttempt ?? null;
  } catch {
    return null;
  }
}

function writeAttempt(a: RolloutAttempt): void {
  try {
    fs.mkdirSync(ARIGAMI_DIR, { recursive: true });
    fs.writeFileSync(ATTEMPT_FILE, JSON.stringify({ lastAttempt: a }, null, 2) + '\n');
  } catch {
    /* best-effort: the response carries the same outcome */
  }
}

export function status(deps: RolloutDeps): RolloutStatus {
  const env = deps.env ?? process.env;
  const p = pf.readProvenance();
  return {
    configured: !!env.ARIGAMI_BUNDLE,
    current: p
      ? { name: p.name, version: p.version, ref: p.ref, commit: p.commit, appliedAt: p.appliedAt, errors: p.errors || [] }
      : null,
    lastAttempt: readAttempt(),
    busySessions: deps.busySessions(),
    applying,
  };
}

/** HTTP-shaped result so api.ts stays a thin wrapper and the tests can drive it in-process. */
export async function apply(claims: { ref?: string; commit?: string }, deps: RolloutDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const env = deps.env ?? process.env;
  const source = String(env.ARIGAMI_BUNDLE || '').trim();
  if (!source) return { status: 400, body: { ok: false, error: 'no ARIGAMI_BUNDLE configured on this host' } };
  if (applying) return { status: 409, body: { ok: false, error: 'a profile apply is already running', applying: true } };
  const busy = deps.busySessions();
  if (busy > 0) return { status: 409, body: { ok: false, error: `${busy} session(s) have a turn in flight`, busySessions: busy } };
  const ref = String(claims.ref || '').trim();
  const commit = String(claims.commit || '').trim();
  applying = true;
  const at = new Date().toISOString();
  try {
    let bundle: pf.Bundle;
    let applied = '';
    if (pf.isGitUrl(source)) {
      const co = pf.checkoutBundleRef(source, ref, commit);
      bundle = pf.loadBundle(co.dir, source);
      applied = co.commit;
    } else {
      if (ref || commit) throw new Error('ARIGAMI_BUNDLE is not a git source — it has no refs to roll out');
      const r = pf.resolveSource(source);
      bundle = pf.loadBundle(r.dir, r.source);
    }
    // Validate up front (applyBundle would too, but say WHY in the attempt record before touching anything).
    const v = pf.validate(bundle);
    if (!v.ok) throw new Error('invalid bundle: ' + v.errors.join('; '));
    const report = await pf.applyBundle({ ...bundle, trusted: true }, { ...(ref ? { ref } : {}), ...(applied ? { commit: applied } : {}) });
    const ok = report.errors.length === 0;
    writeAttempt({ at, ref, commit, ok, applied, ...(ok ? {} : { error: report.errors.join('; ').slice(0, 2000) }) });
    return {
      status: ok ? 200 : 422,
      body: { ok, commit: applied, ref, name: report.name, version: report.version, errors: report.errors, extensions: report.extensions, skills: report.skills, cron: report.cron, cronSkipped: report.cronSkipped },
    };
  } catch (e) {
    const error = (e as Error).message;
    writeAttempt({ at, ref, commit, ok: false, error: error.slice(0, 2000) });
    return { status: 422, body: { ok: false, error } };
  } finally {
    applying = false;
  }
}
