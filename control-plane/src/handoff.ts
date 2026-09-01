// K8S-3 — minting the sign-in handoff the tenant accepts (server/handoff.ts).
//
// Why a second implementation instead of importing the host's: this service
// deliberately imports NOTHING from `server/` (docs/CONTROL-PLANE.md "Why this
// shape") so the two can be deployed and rolled independently. The wire format
// is the contract, and `test/handoff-contract.test.ts` in the ROOT suite
// imports both modules and proves they still agree in both directions — a
// format drift fails a test instead of a user's login.
//
//   token   = base64url(JSON payload) + '.' + base64url(HMAC-SHA256(secret, payloadB64))
//   payload = { kind: 'handoff', email, exp (unix ms), jti }
//
// The verifier caps token life at 10 minutes whatever we ask for, so keep the
// default well under that: this token only has to survive one redirect.
import crypto from 'node:crypto';

export const HANDOFF_KIND = 'handoff';
export const DEFAULT_TTL_MS = 2 * 60_000;

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** Per-tenant, generated once at tenant creation and injected into its pod. */
export function newSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function mint(secret: string, email: string, ttlMs = DEFAULT_TTL_MS): string {
  if (!secret || secret.length < 16) throw new Error('handoff secret is missing or too short');
  const payload = {
    kind: HANDOFF_KIND,
    email: String(email || '').trim().toLowerCase(),
    exp: Date.now() + ttlMs,
    jti: crypto.randomBytes(12).toString('base64url'),
  };
  const p = b64(JSON.stringify(payload));
  return `${p}.${b64(crypto.createHmac('sha256', secret).update(p).digest())}`;
}

/**
 * Where to send the browser so it arrives signed in. Falls back to the plain
 * tenant URL when the tenant has no secret — a tenant provisioned before this
 * feature existed still works, it just shows its pairing screen.
 */
export function signInUrl(tenantUrl: string, secret: string, email: string): string {
  if (!secret) return tenantUrl;
  return `${tenantUrl.replace(/\/$/, '')}/__api/auth/handoff?t=${encodeURIComponent(mint(secret, email))}`;
}
