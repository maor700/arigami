// C2 — X-Forwarded-* trust. Caddy / `tailscale serve` terminate TLS and dial
// the host over loopback, so the host only ever sees plain http; the session
// cookie would never get `Secure` and OAuth/OIDC redirects would be built on
// the wrong origin. These helpers decide when a forwarded header may be
// believed:
//
//   trusted  ⇔  cfg.trustProxy && the TCP peer is loopback
//
// Loopback-only is the whole point: with the default bind (127.0.0.1) every
// peer IS loopback, and a proxy is the only thing that can reach the socket;
// with bind 0.0.0.0 a remote client could forge `X-Forwarded-Proto: https`
// and downgrade the cookie flags — so the header is ignored unless the
// operator opts in with ARIGAMI_TRUST_PROXY=1 (and even then only for
// loopback peers). No import of config here: pure functions, unit-testable.
import type { IncomingMessage } from 'node:http';

export interface ProxyTrust {
  trustProxy: boolean;
  publicUrl?: string;
}

// Minimal shape so tests can pass plain objects.
export type ReqLike = Pick<IncomingMessage, 'headers'> & { socket?: { remoteAddress?: string } };

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr;
  if (a.startsWith('::ffff:')) a = a.slice(7); // IPv4-mapped IPv6
  return a === '::1' || a === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

// First value of a possibly comma-joined forwarded header, lower-cased and
// trimmed ("https, http" → "https"). Empty string when absent.
function first(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v;
  return String(s || '').split(',')[0].trim().toLowerCase();
}

export function proxyTrusted(req: ReqLike, t: ProxyTrust): boolean {
  return !!t.trustProxy && isLoopbackAddress(req.socket?.remoteAddress);
}

// Scheme the *browser* used: 'https' | 'http'. Forwarded header only when
// trusted; otherwise the socket itself (this server never speaks TLS → http).
export function requestProto(req: ReqLike, t: ProxyTrust): 'https' | 'http' {
  if (proxyTrusted(req, t)) {
    const p = first(req.headers['x-forwarded-proto']);
    if (p === 'https' || p === 'http') return p;
  }
  return 'http';
}

// Host the browser typed (X-Forwarded-Host when trusted, else Host).
export function requestHost(req: ReqLike, t: ProxyTrust, fallback = ''): string {
  if (proxyTrusted(req, t)) {
    const h = first(req.headers['x-forwarded-host']);
    if (h) return h;
  }
  return String(req.headers.host || fallback);
}

// Should cookies carry `Secure`? An explicit https ARIGAMI_PUBLIC_URL always
// wins (the compose `tls` profile relies on it — Caddy is not loopback there);
// otherwise a trusted X-Forwarded-Proto: https. `req` is optional: callers
// that mint cookies outside a request (tests, CLI) get the publicUrl answer.
export function requestIsSecure(req: ReqLike | undefined, t: ProxyTrust): boolean {
  if (/^https:/i.test(t.publicUrl || '')) return true;
  return !!req && requestProto(req, t) === 'https';
}

// Origin for redirects. Precedence: publicUrl → trusted forwarded headers →
// loopback Host as http → any other Host as https on the default port (the
// pre-C2 rule: assumes `tailscale serve` in front; see api.ts browserOrigin).
export function requestOrigin(req: ReqLike, t: ProxyTrust, fallbackHost: string): string {
  if (t.publicUrl) return t.publicUrl;
  if (proxyTrusted(req, t) && first(req.headers['x-forwarded-proto'])) {
    return `${requestProto(req, t)}://${requestHost(req, t, fallbackHost)}`;
  }
  const host = String(req.headers.host || fallbackHost);
  const m = /^\[([^\]]+)\]/.exec(host); // bracketed IPv6 literal
  const hostname = m ? m[1] : host.split(':')[0];
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  return isLoopback ? `http://${host}` : `https://${hostname}`;
}
