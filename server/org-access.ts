// Shared org workspaces, tenant side (control-plane/src/shared.ts is the other half; docs/CONTROL-PLANE.md
// "Shared workspaces" has the whole picture).
//
// A shared workspace is one host that several org members open, each signed in AS THEMSELVES through the
// control plane's handoff (server/handoff.ts) with the role the control plane gave them. This module holds what
// that needs on this side, kept out of auth.ts/api.ts so those only grow by a call each:
//
//   - the viewer policy: a `viewer` may look (GET/HEAD, the read-only /__ws event stream) and sign out — nothing
//     else. No POST means no prompt, no new session, no settings change; no /__vnc, /__screencast or proxied
//     websocket means no hands on the desktop. Fail closed: an unknown route is a write until proven otherwise.
//   - the cross-origin guard: every tenant lives under the same org domain, so a page served by ONE tenant (any
//     member's dev server inside a shared workspace) is same-site with every other tenant, and SameSite=Lax
//     cookies ride along on its POSTs and websocket upgrades. On an orchestrated host (handoff secret set) a
//     cookie-authenticated write or upgrade must therefore come from this host's own origin.
//   - the roster: the control plane pushes the member list (POST /__api/auth/roster, HMAC-signed with the
//     tenant's handoff secret, single-use). Anyone not on it loses every web session, API token and open socket
//     here; everyone on it gets the role the control plane says.
//   - shared-host sessions are short (ARIGAMI_SHARED_SESSION_HOURS, default 12): a third, dumb backstop behind
//     the edge (which re-checks membership on every request) and the roster push.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { ARIGAMI_DIR } from './lib/instance.js';
import * as handoff from './handoff.js';

export type TenantRole = 'admin' | 'user' | 'viewer';
export const TENANT_ROLES: readonly TenantRole[] = ['admin', 'user', 'viewer'];
export const isTenantRole = (r: unknown): r is TenantRole => typeof r === 'string' && (TENANT_ROLES as readonly string[]).includes(r);

export const ROSTER_FILE = 'org-roster.json';
const DEFAULT_SHARED_SESSION_HOURS = 12;

/** Set by the tenant chart (`sharedWorkspace: true`) when the control plane provisions a shared workspace. */
export function isSharedWorkspace(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARIGAMI_SHARED_WORKSPACE === '1';
}

export function sharedSessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const h = Number(env.ARIGAMI_SHARED_SESSION_HOURS);
  return (Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 30) : DEFAULT_SHARED_SESSION_HOURS) * 3_600_000;
}

// ---- request policy ---------------------------------------------------------------------------------------------

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function viewerMayRequest(method: string, pathname: string): boolean {
  if (pathname === '/__mcp' || pathname.startsWith('/__mcp/')) return false;
  if (SAFE.has(String(method || 'GET').toUpperCase())) return true;
  return pathname === '/__api/auth/logout';
}

export function viewerMayUpgrade(pathname: string): boolean {
  return pathname === '/__ws'; // server -> client only (bus.js); everything else carries input
}

function ownOrigin(req: IncomingMessage, publicUrl?: string): string | null {
  if (publicUrl) {
    try {
      return new URL(publicUrl).origin;
    } catch {}
  }
  return null;
}

/**
 * A cookie-authenticated write or upgrade from another origin, on an orchestrated host. No Origin header (a
 * non-browser client, an old browser on a GET-turned-POST) is let through: the threat is a sibling tenant's
 * page in the victim's browser, and browsers always send Origin on cross-origin POSTs and websocket upgrades.
 */
export function crossOriginWrite(req: IncomingMessage, opts: { publicUrl?: string; upgrade?: boolean; env?: NodeJS.ProcessEnv }): boolean {
  if (!handoff.enabled(opts.env)) return false;
  const method = String(req.method || 'GET').toUpperCase();
  if (!opts.upgrade && SAFE.has(method)) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  const own = ownOrigin(req, opts.publicUrl);
  if (own) return origin !== own;
  // No public URL configured: fall back to the Host the request was sent to.
  try {
    return new URL(String(origin)).host.toLowerCase() !== String(req.headers.host || '').toLowerCase();
  } catch {
    return true;
  }
}

type PrincipalLike = { kind: string; via?: string; user: { role: string } | null } | null;

/**
 * Why this request must be refused before routing, or null. Called from auth.gate / gateUpgrade right after the
 * principal is resolved. The origin check applies to cookies only — a bearer token is not an ambient credential a
 * foreign page can borrow; internal (session/host) bearers are never a viewer.
 */
export function refusal(req: IncomingMessage, p: PrincipalLike, pathname: string, opts: { publicUrl?: string; upgrade?: boolean; env?: NodeJS.ProcessEnv } = {}): string | null {
  if (!p || p.kind !== 'user') return null;
  if (p.via === 'cookie' && crossOriginWrite(req, opts)) return 'cross-origin request refused';
  // Viewers are judged whatever the credential: an API token made before a downgrade must not outrank the role.
  if (p.user?.role === 'viewer') {
    const ok = opts.upgrade ? viewerMayUpgrade(pathname) : viewerMayRequest(String(req.method || 'GET'), pathname);
    if (!ok) return 'viewers can look but not act in this workspace';
  }
  return null;
}

// ---- open sockets per user (so a revoked member's /__ws, /__vnc … close now, not at their next reconnect) -------

type Closable = { destroy(): void; once(ev: 'close', fn: () => void): unknown };
const sockets = new Map<string, Set<Closable>>();

export function trackSocket(userId: string, socket: Closable): void {
  let set = sockets.get(userId);
  if (!set) sockets.set(userId, (set = new Set()));
  set.add(socket);
  socket.once('close', () => {
    set!.delete(socket);
    if (!set!.size && sockets.get(userId) === set) sockets.delete(userId);
  });
}

export function closeSocketsOf(userId: string): number {
  const set = sockets.get(userId);
  if (!set) return 0;
  sockets.delete(userId);
  let n = 0;
  for (const s of set) {
    try {
      s.destroy();
      n++;
    } catch {}
  }
  return n;
}

// ---- the roster -------------------------------------------------------------------------------------------------

export interface Roster {
  gen: number;
  policy: 'explicit' | 'org';
  defaultRole: TenantRole | null;
  members: Record<string, TenantRole>;
}

export function parseRoster(raw: unknown): Roster | null {
  const r = raw as any;
  if (!r || typeof r !== 'object') return null;
  if (r.policy !== 'explicit' && r.policy !== 'org') return null;
  if (typeof r.gen !== 'number' || !Number.isFinite(r.gen)) return null;
  if (r.policy === 'org' && !isTenantRole(r.defaultRole)) return null;
  if (!r.members || typeof r.members !== 'object') return null;
  const members: Record<string, TenantRole> = {};
  for (const [e, role] of Object.entries(r.members)) {
    if (!isTenantRole(role)) return null;
    members[String(e).trim().toLowerCase()] = role;
  }
  return { gen: r.gen, policy: r.policy, defaultRole: r.policy === 'org' ? r.defaultRole : null, members };
}

/** The role `email` has under `roster`, or null = not a member any more. */
export function roleUnder(roster: Roster, email: string): TenantRole | null {
  const e = String(email || '').trim().toLowerCase();
  if (roster.members[e]) return roster.members[e];
  return roster.policy === 'org' ? roster.defaultRole : null;
}

export function readAppliedRoster(dir = ARIGAMI_DIR): Roster | null {
  try {
    return parseRoster(JSON.parse(fs.readFileSync(path.join(dir, ROSTER_FILE), 'utf8')));
  } catch {
    return null;
  }
}

export interface RosterAuth {
  listUsers(): { id: string; email: string; role: string }[];
  setRole(id: string, role: TenantRole): unknown;
  revokeUser(id: string): { sessions: number; tokens: number };
}

export type ApplyResult =
  | { ok: true; gen: number; revoked: string[]; changed: { email: string; from: string; to: TenantRole }[] }
  | { ok: false; status: number; error: string };

/**
 * Make local users match the roster. Users stay (their per-user settings survive a remove/re-add); what goes is
 * every way in: web sessions, API tokens, open sockets. A roster older than the last applied one is ignored, so
 * two pushes that cross on the wire cannot resurrect a removed member.
 */
export function applyRoster(roster: Roster, a: RosterAuth, dir = ARIGAMI_DIR): ApplyResult {
  const prev = readAppliedRoster(dir);
  if (prev && roster.gen < prev.gen) return { ok: false, status: 409, error: `stale roster (gen ${roster.gen} < applied ${prev.gen})` };
  const revoked: string[] = [];
  const changed: { email: string; from: string; to: TenantRole }[] = [];
  for (const u of a.listUsers()) {
    const role = roleUnder(roster, u.email);
    if (!role) {
      const r = a.revokeUser(u.id);
      const closed = closeSocketsOf(u.id);
      if (r.sessions || r.tokens || closed || u.role !== 'viewer') revoked.push(u.email);
      // Parked as viewer: if a session ever slipped through (a pairing code, a restore), it still cannot act.
      if (u.role !== 'viewer') a.setRole(u.id, 'viewer');
    } else if (u.role !== role) {
      a.setRole(u.id, role);
      closeSocketsOf(u.id); // a desktop socket opened as admin must not outlive a downgrade
      changed.push({ email: u.email, from: u.role, to: role });
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ROSTER_FILE), JSON.stringify({ ...roster, appliedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  } catch {
    return { ok: false, status: 500, error: 'could not record the roster' };
  }
  return { ok: true, gen: roster.gen, revoked, changed };
}

// ---- the handoff ------------------------------------------------------------------------------------------------

export interface HandoffAuth<U extends { id: string }> {
  findByEmail(email: string): U | undefined;
  createUser(email: string, role: TenantRole): U;
  setRole(id: string, role: TenantRole): U | undefined;
}

/**
 * Who a verified handoff signs in, and for how long. Without a role it is the K8S-3 personal sign-in (admin of
 * your own instance) — refused on a shared workspace, which must never hand out an admin by omission. With a
 * role it is that member, as themselves; the role is re-applied on every sign-in, so a change made on the control
 * plane takes effect at the latest at the next one (and at once through the roster).
 */
export function handoffUser<U extends { id: string }>(
  payload: { email: string; role?: string },
  a: HandoffAuth<U>,
  env: NodeJS.ProcessEnv = process.env,
  dir = ARIGAMI_DIR,
): { ok: true; user: U; ttlMs?: number } | { ok: false; status: number; error: string } {
  const email = payload.email;
  if (payload.role === undefined) {
    if (isSharedWorkspace(env)) return { ok: false, status: 403, error: 'this is a shared workspace — open it from your workspace list' };
    return { ok: true, user: a.findByEmail(email) || a.createUser(email, 'admin') };
  }
  if (!isTenantRole(payload.role)) return { ok: false, status: 403, error: 'unknown role' };
  // Belt and braces behind the edge: once the control plane has told us who the members are, a token for anyone
  // else (minted just before their removal, still inside its 2-minute life) does not open a session.
  const roster = readAppliedRoster(dir);
  if (roster && !roleUnder(roster, email)) {
    return { ok: false, status: 403, error: 'you are not on this workspace’s member list (a change may still be on its way — try again in a minute)' };
  }
  const existing = a.findByEmail(email);
  const user = existing ? a.setRole(existing.id, payload.role) || existing : a.createUser(email, payload.role);
  return { ok: true, user, ttlMs: sharedSessionTtlMs(env) };
}
