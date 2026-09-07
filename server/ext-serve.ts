// EXT3 — serving an extension's tab UI (`/__ext/<name>/…`) to a SANDBOXED
// document.
//
// The bug this module exists for: an extension tab is an <iframe sandbox …>
// served with CSP `sandbox` and deliberately WITHOUT `allow-same-origin`, so
// the document gets an opaque origin (see EXT_CSP). The iframe NAVIGATION is
// still a same-site request and carries the `arigami_sid` cookie — but every
// SUBRESOURCE the page then fetches (`<script src="/__ext-sdk.js">`, its own
// app.js/style.css) is issued from that opaque origin, which the browser calls
// cross-site: a SameSite=Lax cookie is not attached, auth.gate answered 401,
// `window.arigami` never existed and `arigami.ready()` never resolved. Wave 1
// only ever exercised this with auth off.
//
// The cure is the one artifacts already use (F5, server/artifacts.ts):
//   * `/__ext-sdk.js` is a public path — a static script with no secrets.
//   * The entry HTML, served on an AUTHENTICATED request, gets a
//     `<base href="/__ext/<name>/~t/<token>/…">` injected, where <token> is a
//     short-lived (24h) HMAC capability bound to THAT extension name.
//   * `/__ext/<name>/~t/<token>/<file>` is served with no cookie at all when
//     the token verifies (auth.ts extGate → shareGate() below).
// The token opens nothing else: not another extension, not /__api, and not an
// extension that has since been disabled or removed.
//
// ── the two tiers ──────────────────────────────────────────────────────────
// Everything above is the SANDBOXED tier, and it is the default and the norm.
// A manifest may ask for `"trusted": true`, and a human may grant it (recorded
// in extensions.json, never in the manifest alone — see server/extensions.ts
// loadOne). A granted extension is served with NO `content-security-policy`
// sandbox and the cockpit gives its iframe no `sandbox` attribute, so the page
// is same-origin with the cockpit: it keeps the session cookie, can use the
// host proxy's service worker — the reason the tier exists, see
// examples/extensions/compare — and can call /__api as the signed-in human. No
// asset token is minted for it, because none is needed.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { shareTokens } from './share-token.js';
import { injectBase, rewriteBaseForToken, rewriteAbsoluteRefs, stripTokenSegment } from './lib/asset-base.js';

/**
 * An extension tab is served WITHOUT `allow-same-origin` on purpose — it gets
 * an opaque origin, so it has no cookie and cannot reach /__api at all.
 * Everything it is allowed to do goes through the postMessage bridge, which
 * checks the manifest permissions (architecture decision 2, option B). Same
 * shape as ARTIFACT_CSP minus that one token.
 */
export const EXT_CSP =
  "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https:; " +
  "connect-src 'self' https:; img-src 'self' data: blob: https:; " +
  "style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:";

export const EXT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// the resolver — injected, so this module never imports the loader
// ---------------------------------------------------------------------------
// index.ts imports server/extensions.ts LAZILY (after listen(), so a slow
// extension can't delay the port). Same shape as auth.setSessionExists: a
// resolver the host wires once, returning the `ui/` root of an extension that
// is loaded, enabled and actually declares a tab — and null for everything
// else, so a stray directory under user/extensions is never readable and a
// token minted before a disable stops working the moment it is disabled.
export type ExtUiResolver = (name: string) => string | null;

let resolver: ExtUiResolver = () => null;
export function setResolver(fn: ExtUiResolver): void { resolver = fn; }

function uiRoot(name: string): string | null {
  if (!EXT_NAME_RE.test(name)) return null;
  try { return resolver(name); } catch { return null; }
}

// ---------------------------------------------------------------------------
// the TRUSTED tier
// ---------------------------------------------------------------------------
// A second injected resolver, same shape and for the same reason: this module
// never imports the loader. It answers true only when the manifest asked for
// `trusted` AND $ARIGAMI_DIR/extensions.json says a human granted it, so the
// default here — and the answer while the loader is still importing, or after a
// disable — is `false`, i.e. sandboxed. Fail-closed by construction.
export type ExtTrustResolver = (name: string) => boolean;

let trustResolver: ExtTrustResolver = () => false;
export function setTrustResolver(fn: ExtTrustResolver): void { trustResolver = fn; }

/** Is this extension served at the trusted tier (no CSP sandbox, same origin as the cockpit)? */
export function isTrusted(name: string): boolean {
  if (!EXT_NAME_RE.test(name)) return false;
  try { return trustResolver(name) === true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// asset tokens
// ---------------------------------------------------------------------------
/** Same lifetime as the artifact asset token (F5). */
export const ASSET_TOKEN_DAYS = 1;
const ASSET_TOKEN_REFRESH_MS = 3_600_000;
const assetTokenCache = new Map<string, { token: string; exp: number }>();

/** Mint (or reuse) the asset token for one extension. Re-minted an hour before expiry. */
export function assetToken(name: string, now = Date.now()): string {
  const hit = assetTokenCache.get(name);
  if (hit && hit.exp - now > ASSET_TOKEN_REFRESH_MS) return hit.token;
  const { token, exp } = shareTokens().sign({ kind: 'extension', id: name, days: ASSET_TOKEN_DAYS, scope: 'assets' });
  assetTokenCache.set(name, { token, exp });
  return token;
}

/** Test hook / called on reload: forget the cached tokens (they stay valid until expiry). */
export function resetAssetTokenCache(): void { assetTokenCache.clear(); }

// ---------------------------------------------------------------------------
// URL parsing + verification
// ---------------------------------------------------------------------------
export interface ParsedExtUrl {
  name: string;
  rel: string;          // path under ui/, `~t/<token>` removed: '' or '/...'
  token: string | null; // from the `~t/` segment or `?t=`
  query: string;        // raw query string incl. '?', or ''
  hadTrailing: boolean; // `/__ext/<name>` (false) vs `/__ext/<name>/…` (true)
}

export function parseExtUrl(raw: string): ParsedExtUrl | null {
  const q = raw.indexOf('?');
  const pathname = q >= 0 ? raw.slice(0, q) : raw;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const m = /^\/__ext\/([^/]+)(\/.*)?$/.exec(decoded);
  if (!m) return null;
  const params = q >= 0 ? new URLSearchParams(raw.slice(q + 1)) : null;
  const stripped = stripTokenSegment(m[2] || '');
  return {
    name: m[1],
    rel: stripped.rel,
    token: stripped.token ?? params?.get('t') ?? null,
    query: q >= 0 ? raw.slice(q) : '',
    hadTrailing: !!m[2],
  };
}

/** Bind a token to ONE extension name — and to that extension still being loaded+enabled. */
export function verifyExtToken(token: string, name: string): { ok: boolean; reason: string } {
  if (!EXT_NAME_RE.test(name)) return { ok: false, reason: 'invalid extension name' };
  const r = shareTokens().verify(token, { kind: 'extension', id: name });
  if (!r.ok) return { ok: false, reason: r.reason };
  if (!uiRoot(name)) return { ok: false, reason: 'extension is not available' };
  return { ok: true, reason: 'ok' };
}

/** What a granted token leaves on the request. Never `req.auth` — a token is not a user. */
export interface ExtGrant { name: string; token: string; }

// auth.ts ShareGate shape: called only when the request has NO principal and
// targets /__ext/. 'granted' → proceed cookie-less with `req.extShare` set;
// 'denied' → this function already answered; 'none' → normal cookie rules.
export function shareGate(req: IncomingMessage, res: ServerResponse): 'granted' | 'denied' | 'none' {
  const u = parseExtUrl(req.url || '/');
  if (!u || u.token == null) return 'none';
  const v = verifyExtToken(u.token, u.name);
  if (!v.ok) {
    // 401, not 404: the shell reloads the iframe on a failed asset and the
    // fresh entry HTML carries a fresh token.
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end('extension asset token rejected: ' + v.reason);
    return 'denied';
  }
  (req as any).extShare = { name: u.name, token: u.token } satisfies ExtGrant;
  return 'granted';
}

// ---------------------------------------------------------------------------
// serving
// ---------------------------------------------------------------------------
/** GET `/__ext/<name>[/rel]` — returns true when it handled the request. */
export function serve(req: IncomingMessage, res: ServerResponse): boolean {
  const raw = req.url || '/';
  const pathname = raw.split('?')[0];
  if (!(pathname === '/__ext' || pathname.startsWith('/__ext/'))) return false;
  const u = parseExtUrl(raw);
  if (!u) { res.writeHead(404); res.end(); return true; }
  const grant = (req as any).extShare as ExtGrant | undefined;
  // A grant is bound to the name it was verified for; a principal-bearing
  // request never has one.
  if (grant && grant.name !== u.name) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return true; }
  const root = uiRoot(u.name);
  if (!root) { res.writeHead(404); res.end(); return true; }
  // `/__ext/<name>` → `/__ext/<name>/` so relative assets resolve.
  if (!u.hadTrailing) {
    res.writeHead(302, { location: `/__ext/${encodeURIComponent(u.name)}/${u.query}` });
    res.end();
    return true;
  }
  const rel = u.rel.replace(/^\//, '');
  const file = path.normalize(path.join(root, rel || 'index.html'));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return true; }
  let target = file;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  } catch {
    res.writeHead(404); res.end(); return true;
  }
  if (!fs.existsSync(target)) { res.writeHead(404); res.end(); return true; }
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const trusted = isTrusted(u.name);
  const headers: Record<string, string | number> = {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  // The whole difference between the two tiers is this header (plus the
  // matching `sandbox` attribute the cockpit puts on the iframe): a trusted tab
  // is same-origin with the cockpit, exactly like /__ticket or a proxied url
  // tab, which is what lets it keep the cookie and use the host proxy's service
  // worker. It can therefore also call /__api as the signed-in human — that is
  // the consequence the install confirmation names out loud.
  if (!trusted) headers['content-security-policy'] = EXT_CSP;
  if (type.startsWith('text/html')) {
    // Sandboxed: the document has an opaque origin → its sub-requests carry no
    // cookie. Route the injected <base> (and any root-absolute
    // `/__ext/<name>/…` reference, which <base> does not cover) through the
    // tokenized path form. A tokenized request keeps ITS token, so a reload
    // inside the iframe does not need a cookie either.
    // Trusted: the cookie is sent like anywhere else on the origin, so the
    // <base> stays plain and no asset token is minted at all.
    const prefix = `/__ext/${u.name}/`;
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    const html = fs.readFileSync(target, 'utf8');
    let body = injectBase(html, `${prefix}${dir}`);
    if (!trusted) {
      const token = grant?.token ?? assetToken(u.name);
      body = rewriteAbsoluteRefs(rewriteBaseForToken(body, prefix, token), prefix, token);
    }
    headers['content-length'] = Buffer.byteLength(body);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end(); else res.end(body);
    return true;
  }
  headers['content-length'] = fs.statSync(target).size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(target).pipe(res);
  return true;
}
