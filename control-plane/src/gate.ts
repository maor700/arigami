// Tenant gate — org SSO in FRONT of every cockpit, decided here, enforced by the edge.
//
// The edge (deploy/gke-lab/edge.yaml, Caddy `forward_auth`) sends a copy of every request bound for
// u-<id>.<orgDomain> to `GET /auth/verify` on this service before proxying it. The browser's control-plane
// session cookie rides along because, with CP_COOKIE_PARENT_DOMAIN=1, it is scoped to the org domain
// (auth.ts). The answer is binary and owner-bound:
//
//   200  the session's user OWNS this tenant (and it is running)       -> the edge proxies the request
//   302  no / expired session -> /auth/login?rd=<this URL>             -> sign in, come back
//   302  own tenant, not running -> /workspace                         -> resume / starting page
//   403  someone else's tenant, an unknown host, an org-admin included
//   503  the gate is misconfigured (cookie not shared)                 -> denied, never a redirect loop
//
// Org-admins are NOT let through to other people's cockpits: a cockpit drives a machine with that person's
// connected accounts, an admin already has suspend/backup/delete on the admin page, and the tenant's own
// handoff is email-bound to the owner — passing the edge would grant an admin nothing but a pairing screen,
// while widening what one stolen admin session reaches. An admin's OWN workspace (/workspace) passes like
// anyone else's.
//
// Pure functions only; the route lives in server.ts.
import type { Config } from './config.js';

const TENANT_PREFIX = 'u-'; // provisioner.ts tenantUrl / db.ts createTenant

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The tenant namespace (`u-<id>`) a Host header addresses, or null for anything that is not exactly one tenant. */
export function tenantNsForHost(cfg: Config, host: string | null | undefined): string | null {
  const h = String(host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  const m = new RegExp(`^${TENANT_PREFIX}([0-9a-f]{1,32})\\.${escapeRe(cfg.orgDomain.toLowerCase())}$`).exec(h);
  return m ? `${TENANT_PREFIX}${m[1]}` : null;
}

/**
 * Where a sign-in may send the browser afterwards. Returns a normalised URL or null (= go to "/").
 *
 * Accepted: a path on this service ("/x", not "//x" or "/\x"), this service's own origin, or a tenant host
 * u-<hex>.<orgDomain> on the configured scheme and default port. Rejected: everything else — other hosts,
 * look-alikes ("u-1.<orgDomain>.evil.test"), credentials in the URL, other schemes. Tenant hosts are only
 * accepted while the session cookie is shared with them: otherwise the gate could never see the session we
 * are about to mint, and login -> tenant -> login would loop forever.
 */
export function safeReturnUrl(cfg: Config, raw: string | null | undefined): string | null {
  const s = String(raw || '').trim();
  if (!s || s.length > 2048) return null;
  if (s.startsWith('/')) {
    if (s.startsWith('//') || s.includes('\\')) return null;
    try {
      const u = new URL(s, cfg.publicUrl);
      return u.origin === new URL(cfg.publicUrl).origin ? u.pathname + u.search + u.hash : null;
    } catch {
      return null;
    }
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.origin === new URL(cfg.publicUrl).origin) return u.href;
  if (!cfg.cookieParentDomain) return null;
  if (u.protocol !== `${cfg.urlScheme}:` || u.port !== '') return null;
  return tenantNsForHost(cfg, u.hostname) ? u.href : null;
}

/** The URL the user was trying to reach, rebuilt from what the edge forwarded (X-Forwarded-Host / -Uri). */
export function requestedUrl(cfg: Config, host: string, forwardedUri: string | null): string {
  const uri = forwardedUri && forwardedUri.startsWith('/') && !forwardedUri.startsWith('//') ? forwardedUri : '/';
  return `${cfg.urlScheme}://${host.split(',')[0].trim().toLowerCase()}${uri}`;
}
