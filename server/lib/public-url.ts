// Outgoing links (A3). Every URL that leaves the host toward a HUMAN — chat
// text, push payloads, report/review cards, WhatsApp/Slack deliveries, MCP
// results — must be host-RELATIVE (`/__host/?session=…`, `/__artifacts/<id>/`)
// so the client resolves it against whatever origin it actually used (laptop
// localhost, tailnet, reverse proxy). `http://localhost:<port>` only works on
// the box running the server and is broken from a phone.
//
// Two envs, two audiences:
//   ARIGAMI_URL        — INTERNAL. Injected into agent processes for host→self
//                        fetches (MCP tools, `curl $ARIGAMI_URL/__api/…`).
//                        Never shown to a human.
//   ARIGAMI_PUBLIC_URL — OPTIONAL. The origin humans reach the cockpit on.
//                        Only used by publicUrl() when a channel genuinely needs
//                        an absolute link (WhatsApp/Slack message, OAuth
//                        redirect fallback). Unset → links stay relative.
import { cfg } from './config.js';

export const HOST_PATH = '/__host/';

// Path a human opens to land in a session (hash route the SPA understands).
export function sessionPath(sessionId: string): string {
  return `${HOST_PATH}#/session/${encodeURIComponent(sessionId)}`;
}

// A path humans can follow: absolute only when ARIGAMI_PUBLIC_URL is set,
// otherwise the same host-relative path. Absolute inputs pass through untouched.
export function publicUrl(p: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p;
  const rel = p.startsWith('/') ? p : `/${p}`;
  const base = (cfg.publicUrl || '').replace(/\/+$/, '');
  return base ? `${base}${rel}` : rel;
}

// Same as publicUrl() but ALWAYS absolute: for callers that cannot use a
// relative path (OAuth redirect_uri, an external service that needs a full
// URL). Falls back to the internal loopback base — only correct on the host box.
export function absoluteUrl(p: string): string {
  const u = publicUrl(p);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  return `${cfg.hostBase || `http://localhost:${cfg.port}`}${u}`;
}
