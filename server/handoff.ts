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
//   payload = { kind: 'handoff', email, exp (unix ms), jti [, role] }
//   payload = { kind: 'roster', exp, jti, roster }   (shared workspaces, server/org-access.ts)
//
// `role` (admin|user|viewer) is only sent for a shared workspace — see server/org-access.ts. A token without it
// is the K8S-3 personal-tenant sign-in. A token of one kind never verifies as the other.
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
export const ROSTER_KIND = 'roster';
const ROLES = ['admin', 'user', 'viewer'];
/** Hard ceiling on a token's life, whatever `exp` the minter chose. */
export const MAX_TTL_MS = 10 * 60_000;
export const USED_FILE = 'handoff-used.json';

export interface HandoffPayload {
  kind: typeof HANDOFF_KIND | typeof ROSTER_KIND;
  email: string; // '' on a roster token
  exp: number; // unix ms
  jti: string;
  role?: 'admin' | 'user' | 'viewer';
  roster?: unknown; // roster tokens only; validated by org-access.parseRoster
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
export function mint(secret: string, email: string, ttlMs = 5 * 60_000, role?: HandoffPayload['role']): string {
  const payload: HandoffPayload = {
    kind: HANDOFF_KIND,
    email: String(email || '').trim().toLowerCase(),
    exp: Date.now() + Math.min(ttlMs, MAX_TTL_MS),
    jti: crypto.randomBytes(12).toString('base64url'),
    ...(role ? { role } : {}),
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
export function verify(token: string, opts: { secret?: string; now?: number; kind?: HandoffPayload['kind'] } = {}): VerifyResult {
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
  const kind = opts.kind ?? HANDOFF_KIND;
  if (payload?.kind !== kind) return { ok: false, error: `not a ${kind} token`, status: 403 };
  if (kind === HANDOFF_KIND) {
    if (!payload.email || !/^[^@\s]+@[^@\s]+$/.test(payload.email)) return { ok: false, error: 'token names no valid email', status: 403 };
    if (payload.role !== undefined && !ROLES.includes(payload.role)) return { ok: false, error: 'token names an unknown role', status: 403 };
  }
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

/**
 * Verify AND spend a token: the same token can never be redeemed twice, even
 * across a pod restart. Expired entries are pruned on every write, so the file
 * stays bounded by MAX_TTL_MS worth of sign-ins.
 */
export function consume(token: string, opts: { secret?: string; now?: number; dir?: string; kind?: HandoffPayload['kind'] } = {}): VerifyResult {
  const r = verify(token, opts);
  if (!r.ok) return r;
  const dir = opts.dir ?? ARIGAMI_DIR;
  const now = opts.now ?? Date.now();
  const file = readUsed(dir);
  if (file.used.some((u) => u.jti === r.payload.jti))
    return { ok: false, error: 'this sign-in link was already used — go back and open your workspace again', status: 403 };
  const used = file.used.filter((u) => u.exp > now);
  used.push({ jti: r.payload.jti, exp: r.payload.exp });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(usedPath(dir), JSON.stringify({ used }, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // A host that cannot record the spend must not pretend the token is
    // single-use — refuse rather than silently downgrade to replayable.
    return { ok: false, error: 'could not record the sign-in', status: 500 };
  }
  return r;
}
