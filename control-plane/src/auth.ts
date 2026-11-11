// OIDC signup for the control-plane. Same library (`openid-client`) and the
// same cookie hardening as the single-instance host (server/auth.ts: HttpOnly,
// SameSite=Lax, Secure whenever the request was https) — reimplemented here
// rather than imported, because this is a separately deployable service that
// should not depend on server/'s internals (users.json, ARIGAMI_DIR, …).
//
// Transport-agnostic on purpose: every function takes/returns plain strings
// (a cookie header, a Set-Cookie value) instead of node's IncomingMessage /
// ServerResponse, so it works the same under Bun.serve's fetch(Request) API
// (what server.ts uses) and under a unit test with no HTTP involved at all.
import type { Config } from './config.js';
import type { Store } from './db.js';
import { domainAllowed } from './domains.js';

export const COOKIE = 'arigami_cp_sid';
export const OIDC_COOKIE = 'arigami_cp_oidc';

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** Every value sent under `name` — a browser can hold a host-only AND a domain cookie of the same name. */
export function cookieValues(header: string | null | undefined, name: string): string[] {
  const out: string[] = [];
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const v = part.slice(i + 1).trim();
    try {
      out.push(decodeURIComponent(v));
    } catch {
      out.push(v);
    }
  }
  return out;
}

export function createAuthService(cfg: Config, store: Store) {
  function isHttps(xForwardedProto?: string | null): boolean {
    if (cfg.publicUrl.startsWith('https://')) return true;
    if (cfg.trustProxy) {
      const proto = String(xForwardedProto || '').split(',')[0].trim().toLowerCase();
      if (proto === 'https') return true;
    }
    return false;
  }
  function cookieHeader(name: string, value: string, maxAgeSec: number, https: boolean, cookiePath = '/', domain = ''): string {
    return `${name}=${value}; Path=${cookiePath}` + (domain ? `; Domain=${domain}` : '') + `; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` + (https ? '; Secure' : '');
  }
  // CP_COOKIE_PARENT_DOMAIN: the session cookie goes to u-<id>.<orgDomain> too, so the edge's GET /auth/verify
  // (src/gate.ts) can see it. Only the session cookie — the OIDC state cookie stays host-only.
  const sessionDomain = cfg.cookieParentDomain ? cfg.orgDomain : '';
  function sessionCookieHeaders(token: string, expMs: number, https: boolean): string[] {
    const out = [cookieHeader(COOKIE, token, Math.max(1, Math.floor((expMs - Date.now()) / 1000)), https, '/', sessionDomain)];
    // A host-only cookie from before the flag was turned on would shadow the new one on this host only.
    if (sessionDomain) out.push(cookieHeader(COOKIE, '', 0, https));
    return out;
  }
  function clearSessionCookieHeaders(https: boolean): string[] {
    const out = [cookieHeader(COOKIE, '', 0, https)];
    if (sessionDomain) out.push(cookieHeader(COOKIE, '', 0, https, '/', sessionDomain));
    return out;
  }

  function principalFromCookieHeader(cookieHeaderStr: string | null): { subject: string; email: string; role: 'admin' | 'user' } | null {
    for (const tok of cookieValues(cookieHeaderStr, COOKIE)) {
      if (!tok) continue;
      const s = store.findSession(tok);
      if (!s) continue;
      const u = store.findUserBySubject(s.subject);
      if (!u) continue;
      return { subject: u.subject, email: u.email, role: u.role };
    }
    return null;
  }

  const oidcEnabled = () => !!(cfg.oidcIssuer && cfg.oidcClientId);
  const redirectUri = () => `${cfg.publicUrl}/auth/callback`;

  let oidcConfig: any = null;
  async function discover(): Promise<any> {
    if (!oidcEnabled()) throw new Error('CP_OIDC_ISSUER / CP_OIDC_CLIENT_ID not configured');
    if (oidcConfig) return oidcConfig;
    const client = await import('openid-client');
    // openid-client v6 (oauth4webapi) refuses plain-http endpoints unless
    // explicitly allowed. An http:// issuer is only ever a dev/test IdP (the
    // k3d proof's mock IdP, a local Keycloak) — honour it instead of failing
    // with an opaque "only https is allowed"; real IdPs stay strict https.
    const insecure = cfg.oidcIssuer.startsWith('http://');
    oidcConfig = await client.discovery(
      new URL(cfg.oidcIssuer),
      cfg.oidcClientId,
      cfg.oidcClientSecret || undefined,
      undefined,
      insecure ? { execute: [client.allowInsecureRequests] } : undefined,
    );
    return oidcConfig;
  }

  // `returnTo` must already be validated (gate.ts safeReturnUrl); it rides in the state cookie, so the IdP
  // never sees it and the callback re-validates it before redirecting.
  async function oidcStart(https: boolean, returnTo: string | null = null): Promise<{ redirectUrl: string; setCookie: string }> {
    const client = await import('openid-client');
    const config = await discover();
    const code_verifier = client.randomPKCECodeVerifier();
    const code_challenge = await client.calculatePKCECodeChallenge(code_verifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(),
      scope: 'openid email profile',
      code_challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    const payload = Buffer.from(JSON.stringify({ code_verifier, state, nonce, ...(returnTo ? { rd: returnTo } : {}) })).toString('base64url');
    return { redirectUrl: url.href, setCookie: cookieHeader(OIDC_COOKIE, payload, 600, https, '/auth') };
  }

  type CallbackResult =
    | { ok: true; subject: string; email: string; role: 'admin' | 'user'; isNewUser: boolean; returnTo: string | null }
    | { ok: false; status: number; error: string };

  async function oidcCallback(cookieHeaderStr: string | null, currentUrl: URL): Promise<CallbackResult> {
    const raw = parseCookies(cookieHeaderStr)[OIDC_COOKIE];
    if (!raw) return { ok: false, status: 400, error: 'missing oidc state cookie' };
    let st: any;
    try {
      st = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, status: 400, error: 'bad oidc state cookie' };
    }
    const client = await import('openid-client');
    const config = await discover();
    let tokens: any;
    try {
      const cb = new URL(redirectUri());
      cb.search = currentUrl.search;
      tokens = await client.authorizationCodeGrant(config, cb, {
        pkceCodeVerifier: st.code_verifier,
        expectedState: st.state,
        expectedNonce: st.nonce,
      });
    } catch (e) {
      return { ok: false, status: 401, error: 'oidc exchange failed: ' + ((e as Error)?.message || e) };
    }
    const claims = tokens.claims?.() || {};
    let email = String(claims.email || claims.preferred_username || '').toLowerCase();
    const subject = String(claims.sub || '');
    if (!email && tokens.access_token) {
      try {
        const info: any = await client.fetchUserInfo(config, tokens.access_token, subject);
        email = String(info?.email || '').toLowerCase();
      } catch {}
    }
    if (!subject) return { ok: false, status: 400, error: 'provider returned no subject' };
    if (!email) return { ok: false, status: 403, error: 'provider returned no email' };
    if (!domainAllowed(email, cfg.allowedEmailDomains)) return { ok: false, status: 403, error: `${email} is not on an allowed domain` };

    let user = store.findUserBySubject(subject) || store.findUserByEmail(email);
    const isNewUser = !user;
    if (!user) {
      // First org user ever becomes org-admin; everyone after is a plain
      // user (PRD §2, mirroring server/auth.ts's pairing-flow bootstrap).
      const role = store.hasAdmin() ? 'user' : 'admin';
      user = store.createUser(subject, email, role);
    }
    return { ok: true, subject: user.subject, email: user.email, role: user.role, isNewUser, returnTo: typeof st.rd === 'string' ? st.rd : null };
  }

  function login(subject: string, https: boolean): { setCookie: string[] } {
    const s = store.createSession(subject, cfg.cookieDays);
    return { setCookie: sessionCookieHeaders(s.token, s.exp, https) };
  }
  function logout(cookieHeaderStr: string | null, https: boolean): { setCookie: string[] } {
    for (const tok of cookieValues(cookieHeaderStr, COOKIE)) if (tok) store.deleteSession(tok);
    return { setCookie: clearSessionCookieHeaders(https) };
  }

  return { principalFromCookieHeader, oidcEnabled, oidcStart, oidcCallback, login, logout, isHttps };
}

export type AuthService = ReturnType<typeof createAuthService>;
