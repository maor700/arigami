// Domain allow-list for OIDC signup. Mirrors server/auth.ts's emailAllowed
// shape (lower-case, trim, strip a leading "@"), narrowed to domains only —
// the control-plane has no per-email allow-list, just ALLOWED_EMAIL_DOMAINS.
export function domainAllowed(email: string, allowedDomains: string[]): boolean {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  const domain = e.split('@')[1] || '';
  if (!domain) return false;
  const allowed = (allowedDomains || []).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!allowed.length) return false; // no allow-list configured = nobody can sign up
  return allowed.includes(domain);
}
