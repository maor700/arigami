// Direct visits to an orchestrated tenant. A person who already signed in with the organisation's SSO can open a
// workspace URL straight (bookmark, typed, a link) — the edge lets them through on their control-plane session, but
// this pod has no session of its own for that browser and would show the PAIRING screen. When the control plane
// gave us ARIGAMI_SSO_URL (its sign-in entry that ends in the handoff), an unauthenticated browser *navigation* to
// a page is answered with a 302 there instead. Nothing else is ever redirected.
//
// Never redirected: non-GET, non-HTML (API, websocket, webhook, asset, curl), sub-resource / iframe fetches,
// `?pair=1` (the operator's way to the pairing screen), the handoff route, health, and the control plane's callbacks
// (all /__api/* and /__mcp/*). Loop guard: a short cookie remembers that we just sent this browser out; a second
// unauthenticated page request inside that window shows the pairing screen instead of bouncing again.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SSO_TRY_COOKIE = 'arigami_sso_try';
const TRY_WINDOW_SEC = 60;

/** The configured entry point, or null when unset / not an http(s) URL. Read per call (env may change in tests). */
export function ssoUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = String(env.ARIGAMI_SSO_URL || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Page documents that render the SPA (and so the pairing screen) — everything else under /__host/ is an asset. */
function isDocumentPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/__host' || pathname === '/__host/' || pathname === '/__host/index.html';
}

function isReservedPath(pathname: string): boolean {
  return pathname.startsWith('/__api/') || pathname.startsWith('/__mcp/') || pathname === '/__health' || pathname.startsWith('/__artifacts') || pathname.startsWith('/__ext');
}

/**
 * Where to send this request, or null to carry on. `publicPath` = the gate would let it through unauthenticated
 * (a document it serves publicly); the other case is the gate's own "HTML navigation to a protected page -> /__host/".
 */
export function ssoRedirectTarget(req: Pick<IncomingMessage, 'method' | 'url' | 'headers'>, env: NodeJS.ProcessEnv = process.env): string | null {
  const target = ssoUrl(env);
  if (!target) return null;
  if (req.method !== 'GET') return null;
  if (!/text\/html/.test(String(req.headers.accept || ''))) return null;
  const mode = req.headers['sec-fetch-mode'];
  if (mode && mode !== 'navigate') return null;
  const dest = req.headers['sec-fetch-dest'];
  if (dest && dest !== 'document') return null;
  let u: URL;
  try {
    u = new URL(req.url || '/', 'http://x');
  } catch {
    return null;
  }
  if (u.searchParams.has('pair')) return null;
  if (isReservedPath(u.pathname)) return null;
  // Public assets under /__host/ (js, css, images) are not pages.
  if (u.pathname.startsWith('/__host/') && !isDocumentPath(u.pathname)) return null;
  const cookies = String(req.headers.cookie || '');
  if (new RegExp(`(?:^|;\\s*)${SSO_TRY_COOKIE}=`).test(cookies)) return null;
  return target;
}

/** Answer the 302 (with the loop-guard cookie). Returns true when it did. */
export function maybeRedirectToSso(req: IncomingMessage, res: ServerResponse, secure: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const to = ssoRedirectTarget(req, env);
  if (!to) return false;
  res.writeHead(302, {
    location: to,
    'set-cookie': `${SSO_TRY_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TRY_WINDOW_SEC}` + (secure ? '; Secure' : ''),
    'cache-control': 'no-store',
  });
  res.end();
  return true;
}
