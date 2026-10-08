// K8S-3 — orchestrator sign-in handoff: how an ALREADY-AUTHENTICATED user
// lands in their tenant without typing a pairing code.
//
// The pairing code (server/auth.ts) exists because a standalone host has no
// idea who you are: possession of the code proves you can read the server's
// filesystem. In an orchestrated fleet that proof is redundant and hostile —
// the control-plane already authenticated the user against the company IdP,
// and the code it would ask for lives inside a pod the user cannot open a
// shell on. So: the control-plane (which provisioned this tenant and holds a
// per-tenant secret) mints a short-lived, single-use token naming the user's
// email, and redirects the browser to `/__api/auth/handoff?t=…`.
//
//   token   = base64url(JSON payload) + '.' + base64url(HMAC-SHA256(secret, payloadB64))
//   payload = { kind: 'handoff', email, exp (unix ms), jti }
//
// Deliberately the SAME wire format as K2's share tokens (server/share-token.ts)
// — one token shape to reason about — but a different module because the trust
// root is different: share tokens are minted BY this instance with a secret it
// generated, handoff tokens are minted FOR it by whoever provisioned it, with a
// secret injected as `ARIGAMI_HANDOFF_SECRET`.
//
// Threat model, stated plainly:
//   - No secret in the env ⇒ the feature is OFF and every token is rejected.
//     A standalone host is exactly as it was before this file existed.
//   - The token rides in a URL (unavoidable for a cross-origin redirect), so
//     it is treated as burnable: MAX_TTL_MS caps how long a minter may make
//     one live regardless of what it wrote in `exp`, and `jti` makes it
//     single-use — a token in a browser history / proxy log is already spent.
//   - Single-use state is persisted (not in memory) so a pod restart does not
//     re-open a spent token.
//   - The token names an email, so a leaked token cannot be replayed to admit
//     a different user.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ARIGAMI_DIR } from './lib/instance.js';

export const HANDOFF_KIND = 'handoff';
/** Hard ceiling on a token's life, whatever `exp` the minter chose. */
export const MAX_TTL_MS = 10 * 60_000;
export const USED_FILE = 'handoff-used.json';

export interface HandoffPayload {
  kind: typeof HANDOFF_KIND;
  email: string;
  exp: number; // unix ms
  jti: string;
}

export type VerifyResult =
  | { ok: true; payload: HandoffPayload }
  | { ok: false; error: string; status: number };

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function secretFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.ARIGAMI_HANDOFF_SECRET || '');
}

export function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return secretFromEnv(env).length >= 16;
}

function sign(payloadB64: string, secret: string): string {
  return b64(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

/**
 * Mint a token. The tenant host itself never needs this — the control-plane
 * mints, with its own copy of the format (it imports nothing from `server/`) —
 * but having both sides here makes the contract testable: the root suite's
 * `test/handoff-contract.test.ts` cross-checks this module against
 * `control-plane/src/handoff.ts` in both directions, so a format drift fails a
 * test instead of a user's login.
 */
export function mint(secret: string, email: string, ttlMs = 5 * 60_000): string {
  const payload: HandoffPayload = {
    kind: HANDOFF_KIND,
    email: String(email || '').trim().toLowerCase(),
    exp: Date.now() + Math.min(ttlMs, MAX_TTL_MS),
    jti: crypto.randomBytes(12).toString('base64url'),
  };
  const p = b64(JSON.stringify(payload));
  return `${p}.${sign(p, secret)}`;
}

function timingSafeEq(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** Pure signature/claims check — no single-use bookkeeping (see `consume`). */
export function verify(token: string, opts: { secret?: string; now?: number } = {}): VerifyResult {
  const secret = opts.secret ?? secretFromEnv();
  if (secret.length < 16) return { ok: false, error: 'handoff sign-in is not configured on this host', status: 404 };
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'malformed token', status: 400 };
  if (!timingSafeEq(parts[1], sign(parts[0], secret))) return { ok: false, error: 'bad signature', status: 403 };
  let payload: HandoffPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed payload', status: 400 };
  }
  const now = opts.now ?? Date.now();
  if (payload?.kind !== HANDOFF_KIND) return { ok: false, error: 'not a handoff token', status: 403 };
  if (!payload.email || !/^[^@\s]+@[^@\s]+$/.test(payload.email)) return { ok: false, error: 'token names no valid email', status: 403 };
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, error: 'token expired — go back and open your workspace again', status: 403 };
  // A minter that asks for a longer life than we allow does not get it: the
  // ceiling is the VERIFIER's, so a compromised/buggy minter cannot issue a
  // long-lived skeleton key.
  if (payload.exp - now > MAX_TTL_MS) return { ok: false, error: 'token life exceeds the allowed maximum', status: 403 };
  if (!payload.jti || typeof payload.jti !== 'string') return { ok: false, error: 'token has no id', status: 400 };
  return { ok: true, payload };
}

interface UsedFile {
  used: { jti: string; exp: number }[];
}

function usedPath(dir = ARIGAMI_DIR): string {
  return path.join(dir, USED_FILE);
}

function readUsed(dir: string): UsedFile {
  try {
    const j = JSON.parse(fs.readFileSync(usedPath(dir), 'utf8'));
    return Array.isArray(j?.used) ? j : { used: [] };
  } catch {
    return { used: [] };
  }
}

/** Record `jti` as spent; an error string when it already was (or the spend cannot be recorded). */
function spend(jti: string, exp: number, dir: string, now: number, reused: string): { error: string; status: number } | null {
  const file = readUsed(dir);
  if (file.used.some((u) => u.jti === jti)) return { error: reused, status: 403 };
  const used = file.used.filter((u) => u.exp > now);
  used.push({ jti, exp });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(usedPath(dir), JSON.stringify({ used }, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // A host that cannot record the spend must not pretend the token is
    // single-use — refuse rather than silently downgrade to replayable.
    return { error: 'could not record the token as used', status: 500 };
  }
  return null;
}

/**
 * Verify AND spend a token: the same token can never be redeemed twice, even
 * across a pod restart. Expired entries are pruned on every write, so the file
 * stays bounded by MAX_TTL_MS worth of sign-ins.
 */
export function consume(token: string, opts: { secret?: string; now?: number; dir?: string } = {}): VerifyResult {
  const r = verify(token, opts);
  if (!r.ok) return r;
  const err = spend(r.payload.jti, r.payload.exp, opts.dir ?? ARIGAMI_DIR, opts.now ?? Date.now(), 'this sign-in link was already used — go back and open your workspace again');
  return err ? { ok: false, ...err } : r;
}

// ---- operator calls (profile rollout) -------------------------------------------
//
// The control-plane also needs to tell a tenant "re-apply the org profile at
// commit X" — something no session and no signed-in user may do, because the
// re-apply is TRUSTED (it installs the profile's extensions, which run code).
// It reuses the per-tenant secret and the same token shape, under a different
// `kind`, so a sign-in token can never be replayed as an operator call or the
// other way round. The claims name the action and, for an apply, the exact
// ref/commit — a captured token cannot be bent to roll out something else.
// The source repo is NOT a claim: the tenant only ever applies its own
// configured ARIGAMI_BUNDLE (server/profile-rollout.ts).

export const OPERATOR_KIND = 'operator';
export type OperatorAction = 'profile-status' | 'profile-apply';

export interface OperatorPayload {
  kind: typeof OPERATOR_KIND;
  action: OperatorAction;
  ref?: string;
  commit?: string;
  exp: number;
  jti: string;
}

export type OperatorResult = { ok: true; payload: OperatorPayload } | { ok: false; error: string; status: number };

/** Mint an operator token (the control-plane has its own copy; test/handoff-contract.test.ts pins the two). */
export function mintOperator(secret: string, claims: { action: OperatorAction; ref?: string; commit?: string }, ttlMs = 2 * 60_000): string {
  const payload: OperatorPayload = {
    kind: OPERATOR_KIND,
    action: claims.action,
    ...(claims.ref ? { ref: claims.ref } : {}),
    ...(claims.commit ? { commit: claims.commit } : {}),
    exp: Date.now() + Math.min(ttlMs, MAX_TTL_MS),
    jti: crypto.randomBytes(12).toString('base64url'),
  };
  const p = b64(JSON.stringify(payload));
  return `${p}.${sign(p, secret)}`;
}

/**
 * Verify an operator token for `action`. An apply is single-use (spent like a
 * sign-in); a status read is not — it changes nothing, and the control-plane
 * mints a fresh one per read anyway.
 */
export function verifyOperator(token: string, action: OperatorAction, opts: { secret?: string; now?: number; dir?: string } = {}): OperatorResult {
  const secret = opts.secret ?? secretFromEnv();
  if (secret.length < 16) return { ok: false, error: 'operator calls are not configured on this host', status: 404 };
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'operator token required', status: 401 };
  if (!timingSafeEq(parts[1], sign(parts[0], secret))) return { ok: false, error: 'bad signature', status: 403 };
  let payload: OperatorPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed payload', status: 400 };
  }
  const now = opts.now ?? Date.now();
  if (payload?.kind !== OPERATOR_KIND) return { ok: false, error: 'not an operator token', status: 403 };
  if (payload.action !== action) return { ok: false, error: `token is for "${payload.action}", not "${action}"`, status: 403 };
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, error: 'token expired', status: 403 };
  if (payload.exp - now > MAX_TTL_MS) return { ok: false, error: 'token life exceeds the allowed maximum', status: 403 };
  if (!payload.jti || typeof payload.jti !== 'string') return { ok: false, error: 'token has no id', status: 400 };
  if (action === 'profile-apply') {
    const err = spend(payload.jti, payload.exp, opts.dir ?? ARIGAMI_DIR, now, 'operator token already used');
    if (err) return { ok: false, ...err };
  }
  return { ok: true, payload };
}
