// C1 — host authentication.
//
// Three principals can reach the host:
//   1. A BROWSER holding the `arigami_sid` cookie (HttpOnly, SameSite=Lax,
//      Secure when the public URL is https). Minted by pairing (one-time code
//      printed at boot / `bin/host pair`) or by an OIDC login.
//   2. An INTERNAL caller holding `Authorization: Bearer <ARIGAMI_TOKEN>` —
//      the per-session token the host injects into every `claude` it spawns
//      (host-mcp.js, skills' curl, the review prompt), plus one host-scoped
//      token for one-shots/headless runs that have no session. These are
//      in-memory only and die with the process / the session.
//   3. An API TOKEN (`arigami_pat_…`) created by an admin in Settings for CLIs;
//      only its sha256 is stored in users.json.
//
// Everything persistent lives under ARIGAMI_DIR (users.json, sessions.json,
// run/pairing-code). `createAuth()` is the factory the tests use with a tmp
// dir; the default export `auth` is the singleton the server wires in.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isInboundWebhookPath } from './webhooks.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestIsSecure } from './lib/proxy-headers.js';
import { cfg as liveCfg, type AuthConfig } from './lib/config.js';
import { secret } from './lib/secrets.js';

export type Role = 'admin' | 'user';

export interface ApiToken {
  id: string;
  label: string;
  hash: string; // sha256(token) hex
  createdAt: string;
  lastUsedAt?: string;
}

export interface User {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  oidcSub?: string;
  tokens?: ApiToken[];
}

export interface WebSession {
  token: string;
  userId: string;
  exp: number; // epoch ms
  createdAt: number;
  ua?: string;
}

export type Principal =
  | { kind: 'user'; user: User; via: 'cookie' | 'api-token' }
  | { kind: 'session'; sessionId: string; user: null }
  | { kind: 'host'; user: null }
  | { kind: 'off'; user: null };

// May this principal ask for the UNTRUNCATED session list (GET /__api/sessions?full=1)?
// Bearer/internal callers only — host-mcp's list_sessions (masters/PMs read
// child result.summary there), API tokens, host/one-shot tokens, auth off.
// Cookie browsers always get the slim wire form (state.toWireSession).
export function canReadFullList(p: Principal | null): boolean {
  if (!p) return false;
  if (p.kind === 'user') return p.via === 'api-token';
  return true; // session | host | off
}

export interface AuthOptions {
  dir: string; // ARIGAMI_DIR
  auth: AuthConfig;
  publicUrl?: string;
  // C2: honour X-Forwarded-Proto from loopback peers (cfg.trustProxy).
  trustProxy?: boolean;
  log?: (msg: string) => void;
  // Session-token scope check: a bearer token is only valid while its session
  // still exists. Injected so the module has no import cycle with state.ts.
  sessionExists?: (id: string) => boolean;
  shareGate?: ShareGate;
}

// K2: the share-token gate for `/__artifacts/<id>/…`, and EXT3's identical
// gate for `/__ext/<name>/~t/<token>/…`. Injected by index.ts
// (artifacts.shareGate / ext-serve.shareGate) so auth.ts has no import cycle
// with state/artifacts/extensions.
// 'granted' → the request proceeds cookie-less with `req.share` set (never
// `req.auth`, so /__api stays 401); 'denied' → the gate already answered 401;
// 'none' → no token on the URL, normal cookie rules apply.
export type ShareGate = (req: IncomingMessage, res: ServerResponse) => 'granted' | 'denied' | 'none';

export const COOKIE = 'arigami_sid';
export const OIDC_COOKIE = 'arigami_oidc';
export const PAIRING_FILE = 'pairing-code';
const PAIR_MAX_FAILS = 5;
const PAIR_LOCK_MS = 60_000;
const PAT_PREFIX = 'arigami_pat_';

// Unambiguous alphabet (no 0/O/1/I) → "XXXX-XXXX".
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePairingCode(): string {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
const normCode = (c: string): string => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function parseCookies(header: string | undefined): Record<string, string> {
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

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

// Allowed-email policy for OIDC (also unit-tested on its own).
export function emailAllowed(email: string, oidc: AuthConfig['oidc'] | undefined): boolean {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  const emails = (oidc?.allowedEmails || []).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const domains = (oidc?.allowedDomains || []).map((x) => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (emails.includes(e)) return true;
  const dom = e.split('@')[1] || '';
  return !!dom && domains.includes(dom);
}

export function createAuth(opts: AuthOptions) {
  const dir = opts.dir;
  const runDir = path.join(dir, 'run');
  const usersFile = path.join(dir, 'users.json');
  const sessionsFile = path.join(dir, 'sessions.json');
  const pairingFile = path.join(runDir, PAIRING_FILE);
  const log = opts.log || ((m: string) => console.log(m));
  let sessionExists = opts.sessionExists || (() => true);
  // Wired by the server once state.ts is loaded (avoids an import cycle).
  const setSessionExists = (fn: (id: string) => boolean) => { sessionExists = fn; };
  let shareGate: ShareGate | null = opts.shareGate || null;
  const setShareGate = (fn: ShareGate | null) => { shareGate = fn; };
  // EXT3: same contract, for the extension-tab asset tokens.
  let extGate: ShareGate | null = null;
  const setExtGate = (fn: ShareGate | null) => { extGate = fn; };
  const mode = () => opts.auth.mode;

  // ---- persistence ----------------------------------------------------------
  const readJson = <T,>(file: string, fallback: T): T => {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && typeof v === 'object' ? v : fallback;
    } catch {
      return fallback;
    }
  };
  const writeJson = (file: string, v: unknown, restrict = true): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', restrict ? { mode: 0o600 } : undefined);
    fs.renameSync(tmp, file);
  };

  let users: User[] = readJson<{ users: User[] }>(usersFile, { users: [] }).users || [];
  const saveUsers = () => writeJson(usersFile, { users });

  const sessions = new Map<string, WebSession>();
  for (const s of readJson<{ sessions: WebSession[] }>(sessionsFile, { sessions: [] }).sessions || []) {
    if (s && s.token && s.exp > Date.now()) sessions.set(s.token, s);
  }
  const saveSessions = () => writeJson(sessionsFile, { sessions: [...sessions.values()] });

  // ---- users -----------------------------------------------------------------
  const listUsers = (): Omit<User, 'tokens'>[] =>
    users.map(({ tokens, ...u }) => ({ ...u, tokenCount: (tokens || []).length } as any));
  const hasAdmin = (): boolean => users.some((u) => u.role === 'admin');
  const findByEmail = (email: string): User | undefined =>
    users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
  const getUser = (id: string): User | undefined => users.find((u) => u.id === id);
  function createUser(email: string, role: Role, extra: Partial<User> = {}): User {
    const u: User = {
      id: 'u_' + crypto.randomBytes(6).toString('hex'),
      email: String(email || '').trim() || 'admin',
      role,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    users.push(u);
    saveUsers();
    return u;
  }
  function removeUser(idOrEmail: string): boolean {
    const before = users.length;
    users = users.filter((u) => u.id !== idOrEmail && u.email.toLowerCase() !== idOrEmail.toLowerCase());
    if (users.length === before) return false;
    saveUsers();
    // Drop that user's web sessions too.
    for (const [t, s] of sessions) if (!users.some((u) => u.id === s.userId)) sessions.delete(t);
    saveSessions();
    return true;
  }

  // ---- web sessions (cookie) -------------------------------------------------
  const cookieDays = () => opts.auth.cookieDays || 30;
  function createWebSession(userId: string, ua?: string): WebSession {
    const s: WebSession = {
      token: crypto.randomBytes(32).toString('base64url'),
      userId,
      exp: Date.now() + cookieDays() * 86_400_000,
      createdAt: Date.now(),
      ua: ua ? ua.slice(0, 200) : undefined,
    };
    sessions.set(s.token, s);
    saveSessions();
    return s;
  }
  function sessionFromCookie(req: IncomingMessage): { session: WebSession; user: User } | null {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (!tok) return null;
    const s = sessions.get(tok);
    if (!s) return null;
    if (s.exp <= Date.now()) {
      sessions.delete(tok);
      saveSessions();
      return null;
    }
    const user = getUser(s.userId);
    if (!user) return null;
    return { session: s, user };
  }
  // `Secure` when the browser reached us over https: an https publicUrl, or
  // (C2) a trusted X-Forwarded-Proto from Caddy / tailscale serve on loopback.
  const isHttps = (req?: IncomingMessage) =>
    requestIsSecure(req, { trustProxy: !!opts.trustProxy, publicUrl: opts.publicUrl });
  function cookieHeader(token: string, maxAgeSec: number, req?: IncomingMessage): string {
    return (
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` +
      (isHttps(req) ? '; Secure' : '')
    );
  }
  const setCookie = (res: ServerResponse, s: WebSession, req?: IncomingMessage) =>
    res.setHeader('set-cookie', cookieHeader(s.token, Math.max(1, Math.floor((s.exp - Date.now()) / 1000)), req));
  const clearCookie = (res: ServerResponse, req?: IncomingMessage) => res.setHeader('set-cookie', cookieHeader('', 0, req));
  function logout(req: IncomingMessage): void {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (tok && sessions.delete(tok)) saveSessions();
  }

  // ---- pairing ---------------------------------------------------------------
  let fails = 0;
  let lockedUntil = 0;
  function readPairingCode(): string {
    try {
      return normCode(fs.readFileSync(pairingFile, 'utf8'));
    } catch {
      return '';
    }
  }
  function issuePairingCode(): string {
    const code = generatePairingCode();
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(pairingFile, code + '\n', { mode: 0o600 });
    return code;
  }
  function burnPairingCode(): void {
    try {
      fs.unlinkSync(pairingFile);
    } catch {}
  }
  // Boot: no users yet → print a code next to the listen log. An existing code
  // file (e.g. `bin/host pair` ran before start) is reused, not replaced.
  function announcePairing(): string | null {
    if (mode() === 'off') return null;
    if (hasAdmin()) return null;
    const code = readPairingCode() || normCode(issuePairingCode());
    const pretty = code.slice(0, 4) + '-' + code.slice(4);
    log(`[auth] no admin yet — pairing code: ${pretty}  (also in ${pairingFile}; or run: bin/host pair)`);
    return pretty;
  }
  type PairResult = { ok: true; user: User } | { ok: false; status: number; error: string; retryAfter?: number };
  function pair(code: string, email?: string): PairResult {
    if (mode() === 'off') return { ok: false, status: 400, error: 'auth is off' };
    const now = Date.now();
    if (lockedUntil > now)
      return { ok: false, status: 429, error: 'too many attempts — locked', retryAfter: Math.ceil((lockedUntil - now) / 1000) };
    const want = readPairingCode();
    const got = normCode(code);
    if (!want || !got || !safeEq(want, got)) {
      fails += 1;
      if (fails >= PAIR_MAX_FAILS) {
        fails = 0;
        lockedUntil = now + PAIR_LOCK_MS;
        return { ok: false, status: 429, error: 'too many attempts — locked for 60s', retryAfter: 60 };
      }
      return { ok: false, status: 401, error: want ? 'wrong pairing code' : 'no pairing code issued — run: bin/host pair' };
    }
    fails = 0;
    burnPairingCode(); // one-time
    // Possession of the code == possession of the server's filesystem, so it
    // always yields admin: the existing user (by email) or a new admin.
    const user = (email && findByEmail(email)) || (!email && users.find((u) => u.role === 'admin')) || createUser(email || 'admin', 'admin');
    return { ok: true, user };
  }

  // ---- internal (bearer) tokens ---------------------------------------------
  const sessionTokens = new Map<string, string>(); // token → sessionId
  const hostToken = crypto.randomBytes(32).toString('base64url');
  function tokenForSession(sessionId: string): string {
    for (const [t, id] of sessionTokens) if (id === sessionId) return t;
    const t = crypto.randomBytes(32).toString('base64url');
    sessionTokens.set(t, sessionId);
    return t;
  }
  function revokeSessionToken(sessionId: string): void {
    for (const [t, id] of sessionTokens) if (id === sessionId) sessionTokens.delete(t);
  }
  function bearerOf(req: IncomingMessage): string {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : '';
  }
  function principalFromBearer(tok: string): Principal | null {
    if (!tok) return null;
    if (safeEq(tok, hostToken)) return { kind: 'host', user: null };
    const sid = sessionTokens.get(tok);
    if (sid) {
      if (!sessionExists(sid)) {
        sessionTokens.delete(tok);
        return null;
      }
      return { kind: 'session', sessionId: sid, user: null };
    }
    if (tok.startsWith(PAT_PREFIX)) {
      const h = sha256(tok);
      for (const u of users)
        for (const t of u.tokens || [])
          if (safeEq(t.hash, h)) {
            t.lastUsedAt = new Date().toISOString();
            return { kind: 'user', user: u, via: 'api-token' };
          }
    }
    return null;
  }

  // ---- API tokens (admin) ---------------------------------------------------
  function createApiToken(userId: string, label: string): { token: string; id: string } | null {
    const u = getUser(userId);
    if (!u) return null;
    const token = PAT_PREFIX + crypto.randomBytes(24).toString('base64url');
    const t: ApiToken = { id: 't_' + crypto.randomBytes(4).toString('hex'), label: String(label || 'cli').slice(0, 60), hash: sha256(token), createdAt: new Date().toISOString() };
    u.tokens = [...(u.tokens || []), t];
    saveUsers();
    return { token, id: t.id };
  }
  function deleteApiToken(id: string): boolean {
    let hit = false;
    for (const u of users) {
      const n = (u.tokens || []).length;
      u.tokens = (u.tokens || []).filter((t) => t.id !== id);
      if (u.tokens.length !== n) hit = true;
    }
    if (hit) saveUsers();
    return hit;
  }
  const listApiTokens = () =>
    users.flatMap((u) => (u.tokens || []).map(({ hash, ...t }) => ({ ...t, userId: u.id, email: u.email })));

  // ---- principal resolution --------------------------------------------------
  function principal(req: IncomingMessage): Principal | null {
    if (mode() === 'off') return { kind: 'off', user: null };
    const b = principalFromBearer(bearerOf(req));
    if (b) return b;
    const c = sessionFromCookie(req);
    if (c) return { kind: 'user', user: c.user, via: 'cookie' };
    return null;
  }
  const isAdmin = (p: Principal | null): boolean =>
    !!p && (p.kind === 'off' || p.kind === 'host' || (p.kind === 'user' && p.user.role === 'admin'));

  // ---- HTTP gate -------------------------------------------------------------
  // Paths reachable with no credential at all. Everything else needs a principal.
  function isPublicPath(pathname: string): boolean {
    if (pathname.startsWith('/__api/auth/')) return true;
    if (pathname === '/__api/config') return true; // reduced body when anonymous (api.ts)
    if (pathname === '/__host' || pathname.startsWith('/__host/')) return true; // SPA shows Login
    if (pathname === '/') return true; // 302 → /__host/ (index.ts)
    if (pathname === '/__health' || pathname === '/__poc-sw.js') return true;
    // EXT3: the extension tab SDK — a static script with no secrets, and the
    // ONE subresource every sandboxed (opaque-origin, cookie-less) extension
    // page must be able to load before the postMessage bridge exists at all.
    if (pathname === '/__ext-sdk.js') return true;
    // C3: only the INBOUND webhook routes are public — each verifies its own
    // credential inside server/webhooks.ts (share-token / Slack v0 / GitHub
    // HMAC / custom HMAC). The admin routes under /__api/webhooks/* (token,
    // config, events) are NOT matched here and need a normal principal.
    if (isInboundWebhookPath(pathname)) return true;
    // Pre-C3 phone webhook, unauthenticated for ONE more release (deprecation
    // warning in the log; see docs/SECURITY.md). Remove with the legacy handler.
    if (pathname === '/__api/sms/inbound' || pathname.startsWith('/__api/sms/inbound/')) return true;
    if (pathname.startsWith('/__artifacts/')) return false; // K2: ?t= share tokens handled in gate() via shareGate
    if (pathname.startsWith('/__ext/')) return false; // EXT3: ~t/ asset tokens handled in gate() via extGate
    return false;
  }

  // Returns true when the request was answered (401/302) and must not be routed.
  function gate(req: IncomingMessage, res: ServerResponse): boolean {
    const pathname = (req.url || '/').split('?')[0];
    const p = principal(req);
    (req as any).auth = p;
    if (p || isPublicPath(pathname)) return false;
    // K2: a signed share token opens ONE artifact without a cookie. Only
    // consulted when there is no principal, only on the artifacts route.
    if (shareGate && (pathname === '/__artifacts' || pathname.startsWith('/__artifacts/'))) {
      const r = shareGate(req, res);
      if (r === 'granted') return false;
      if (r === 'denied') return true;
    }
    // EXT3: a `~t/<token>/` segment opens ONE extension's ui/ without a cookie
    // — the sandboxed tab document cannot send one (see server/ext-serve.ts).
    if (extGate && pathname.startsWith('/__ext/')) {
      const r = extGate(req, res);
      if (r === 'granted') return false;
      if (r === 'denied') return true;
    }
    if (pathname.startsWith('/__api/') || pathname.startsWith('/__mcp/')) {
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'unauthorized', login: '/__host/' }));
      return true;
    }
    if (req.headers.accept && /text\/html/.test(String(req.headers.accept))) {
      res.writeHead(302, { location: '/__host/', 'cache-control': 'no-store' });
    } else {
      res.writeHead(401, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    }
    res.end();
    return true;
  }

  // WebSocket upgrades (/__ws, /__vnc, SW proxy): cookie or bearer, else 401 + close.
  function gateUpgrade(req: IncomingMessage, socket: { write: (s: string) => void; destroy: () => void }): boolean {
    const p = principal(req);
    (req as any).auth = p;
    if (p) return false;
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } catch {}
    try {
      socket.destroy();
    } catch {}
    return true;
  }

  // ---- OIDC ------------------------------------------------------------------
  // Lazy: openid-client is only imported when a flow starts, so a host without
  // OIDC never pays for it (and tests never touch the network).
  let oidcConfig: any = null;
  async function oidc(): Promise<any> {
    const o = opts.auth.oidc;
    if (!o?.issuer || !o?.clientId) throw new Error('auth.oidc.issuer / clientId not configured');
    if (oidcConfig) return oidcConfig;
    const client = await import('openid-client');
    const clientSecret = o.clientSecret || secret('ARIGAMI_OIDC_CLIENT_SECRET') || undefined;
    oidcConfig = await client.discovery(new URL(o.issuer), o.clientId, clientSecret);
    return oidcConfig;
  }
  const oidcEnabled = () => !!(opts.auth.oidc?.issuer && opts.auth.oidc?.clientId);
  const redirectUri = (origin: string) => `${(opts.publicUrl || origin).replace(/\/$/, '')}/__api/auth/oidc/callback`;

  async function oidcStart(origin: string, redirect: string | null, req?: IncomingMessage): Promise<{ url: string; cookie: string }> {
    const client = await import('openid-client');
    const config = await oidc();
    const code_verifier = client.randomPKCECodeVerifier();
    const code_challenge = await client.calculatePKCECodeChallenge(code_verifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(origin),
      scope: 'openid email profile',
      code_challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    const payload = Buffer.from(JSON.stringify({ code_verifier, state, nonce, redirect: redirect || '/__host/', origin })).toString('base64url');
    const cookie = `${OIDC_COOKIE}=${payload}; Path=/__api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=600` + (isHttps(req) ? '; Secure' : '');
    return { url: url.href, cookie };
  }

  async function oidcCallback(req: IncomingMessage, currentUrl: URL): Promise<{ ok: true; user: User; redirect: string } | { ok: false; status: number; error: string }> {
    const client = await import('openid-client');
    const raw = parseCookies(req.headers.cookie)[OIDC_COOKIE];
    if (!raw) return { ok: false, status: 400, error: 'missing oidc state cookie' };
    let st: any;
    try {
      st = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, status: 400, error: 'bad oidc state cookie' };
    }
    const config = await oidc();
    let tokens: any;
    try {
      // The provider redirected to redirect_uri; rebuild the URL with the same
      // origin we registered so the library's redirect_uri check matches.
      const cb = new URL(redirectUri(st.origin));
      cb.search = currentUrl.search;
      tokens = await client.authorizationCodeGrant(config, cb, { pkceCodeVerifier: st.code_verifier, expectedState: st.state, expectedNonce: st.nonce });
    } catch (e) {
      return { ok: false, status: 401, error: 'oidc exchange failed: ' + ((e as Error)?.message || e) };
    }
    const claims = tokens.claims?.() || {};
    let email = String(claims.email || claims.preferred_username || '').toLowerCase();
    const sub = String(claims.sub || '');
    if (!email && tokens.access_token) {
      try {
        const info: any = await client.fetchUserInfo(config, tokens.access_token, sub);
        email = String(info?.email || '').toLowerCase();
      } catch {}
    }
    if (!email) return { ok: false, status: 403, error: 'provider returned no email' };
    if (!emailAllowed(email, opts.auth.oidc)) return { ok: false, status: 403, error: `${email} is not allowed` };
    let user = users.find((u) => u.oidcSub === sub) || findByEmail(email);
    if (!user) {
      if (opts.auth.oidc?.autoCreate === false) return { ok: false, status: 403, error: 'no account for this email' };
      user = createUser(email, hasAdmin() ? 'user' : 'admin', { oidcSub: sub });
    } else if (!user.oidcSub) {
      user.oidcSub = sub;
      saveUsers();
    }
    return { ok: true, user, redirect: typeof st.redirect === 'string' && st.redirect.startsWith('/') ? st.redirect : '/__host/' };
  }

  // Public shape of the current auth state — safe for the anonymous /__api/config.
  const publicInfo = () => ({ authMode: mode(), hasAdmin: hasAdmin(), oidc: oidcEnabled() });

  return {
    // users
    listUsers, hasAdmin, getUser, findByEmail, createUser, removeUser,
    // web sessions
    createWebSession, sessionFromCookie, setCookie, clearCookie, logout, cookieHeader,
    // pairing
    announcePairing, issuePairingCode, readPairingCode, pair, pairingFile,
    // internal tokens
    hostToken, tokenForSession, revokeSessionToken, setSessionExists, setShareGate, setExtGate,
    // api tokens
    createApiToken, deleteApiToken, listApiTokens,
    // gate
    principal, isAdmin, isPublicPath, gate, gateUpgrade, publicInfo,
    // oidc
    oidcEnabled, oidcStart, oidcCallback,
    // introspection (tests)
    files: { usersFile, sessionsFile, pairingFile },
    mode,
  };
}

export type Auth = ReturnType<typeof createAuth>;

// The server-wide singleton. api.ts calls setSessionExists() once state.ts is
// loaded so a session's bearer token dies with the session (no import cycle).
export const auth: Auth = createAuth({
  dir: liveCfg.configDir!,
  auth: liveCfg.auth,
  publicUrl: liveCfg.publicUrl,
  trustProxy: liveCfg.trustProxy,
});

// ---- CLI (bin/host pair | user list | user remove <id|email>) ----------------
// `bun server/auth.ts <cmd>` — runs against ARIGAMI_DIR like the server does.
if (import.meta.main) {
  const [cmd, sub, arg] = process.argv.slice(2);
  if (cmd === 'pair') {
    const code = auth.issuePairingCode();
    console.log(`pairing code: ${code}`);
    console.log(`(written to ${auth.pairingFile}; enter it at /__host/ — valid once, until used)`);
  } else if (cmd === 'user' && sub === 'list') {
    const list = auth.listUsers();
    if (!list.length) console.log('no users yet — pair first');
    for (const u of list) console.log(`${u.id}\t${u.role}\t${u.email}\t${u.createdAt}${u.oidcSub ? '\toidc' : ''}`);
  } else if (cmd === 'user' && sub === 'remove' && arg) {
    console.log(auth.removeUser(arg) ? `removed ${arg}` : `no such user: ${arg}`);
  } else {
    console.error('usage: auth.ts pair | user list | user remove <id|email>');
    process.exit(2);
  }
}
