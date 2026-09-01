// Domain allow-list for OIDC signup. Mirrors server/auth.ts's emailAllowed
// shape (lower-case, trim, strip a leading "@"), narrowed to domains only —
// the control-plane has no per-email allow-list, just ALLOWED_EMAIL_DOMAINS.
//
// ALLOWED_EMAIL_DOMAINS=* is an explicit OPEN-SIGNUP escape hatch: anyone who
// can prove ownership of ANY email via the configured OIDC provider (e.g.
// "Sign in with Google") gets in — for the solo-operator/demo scenario that
// doesn't have a company domain to gate on at all. This is still real
// authentication (Google/GitHub verified the email), just no allow-list on
// top of it — different from an empty list, which denies everyone by
// default. A bare "*" as one of several entries also means fully open; it
// isn't limited to being the sole entry.
export function domainAllowed(email: string, allowedDomains: string[]): boolean {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  const domain = e.split('@')[1] || '';
  if (!domain) return false;
  const allowed = (allowedDomains || []).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!allowed.length) return false; // no allow-list configured = nobody can sign up
  if (allowed.includes('*')) return true; // open signup
  return allowed.includes(domain);
}
