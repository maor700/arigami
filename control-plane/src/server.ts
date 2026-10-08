import type { Config } from './config.js';
import type { Store, Tenant } from './db.js';
import { createAuthService } from './auth.js';
import * as tpl from './templates.js';
import { canTransition } from './state-machine.js';
import { tenantUrl, pushRoster } from './provisioner.js';
import * as backupMod from './backup.js';
import { signInUrl } from './handoff.js';
import { tenantNsForHost, safeReturnUrl, requestedUrl } from './gate.js';
import { stepsFor, podSnapshot, EMPTY_SNAPSHOT, type PodSnapshot } from './progress.js';
import { rolloutEnabled, haltingTenant, DESIRED_META_KEY, type DesiredRecord } from './profile-rollout.js';
import { decideAccess } from './shared.js';
import { handleShared, adminSection } from './shared-routes.js';
import type { SharedDeps } from './shared-ops.js';

export interface Provisioner {
  provisionTenant(cfg: Config, t: Tenant): Promise<{ url: string }>;
  deleteTenant(cfg: Config, t: Tenant): Promise<void>;
  suspendTenant(cfg: Config, t: Tenant): Promise<void>;
  resumeTenant(cfg: Config, t: Tenant): Promise<void>;
}

// K8S-3 admin-surface ops, injectable so test/server.test.ts runs without k8s.
export interface AdminOps {
  backupTenant(cfg: Config, t: Tenant): Promise<{ name: string; bytes: number }>;
  listBackups(cfg: Config, ns: string): { name: string; bytes: number; mtimeMs: number }[];
  /** live pod state behind the progress page; injected so tests need no cluster */
  podSnapshot(cfg: Config, t: Tenant): Promise<PodSnapshot>;
  /** shared workspaces: hand the tenant its member roster (provisioner.pushRoster); optional so test doubles may omit it */
  pushRoster?(cfg: Config, t: Tenant, token: string): Promise<void>;
}

const realAdminOps: AdminOps = {
  backupTenant: (cfg, t) => backupMod.backupTenant(cfg, t),
  listBackups: (cfg, ns) => backupMod.listBackups(cfg, ns),
  podSnapshot: (cfg, t) => podSnapshot(cfg, t),
  pushRoster: (cfg, t, token) => pushRoster(cfg, t, token),
};

// A digest ("sha256:<hex>") or an image tag — the only two things the chart's
// imageRef helper accepts. Anything else is a typo we bounce at the form.
export const DIGEST_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (location: string, setCookies: string[] = []): Response => {
  const headers = new Headers({ location });
  for (const c of setCookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
};
const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// Fire-and-forget provisioning: runs the helm install in the background so
// the HTTP request that triggered it (the OIDC callback) doesn't block on a
// (potentially minutes-long) chart install. The tenant row is already
// `provisioning` by the time this starts, so a concurrent page load just
// sees the "starting" page; `bootstrapTenant`'s caller in tests awaits this
// directly instead when it needs the outcome synchronously.
async function runProvisioning(cfg: Config, store: Store, provisioner: Provisioner, t: Tenant, log: (m: string) => void): Promise<void> {
  try {
    const { url } = await provisioner.provisionTenant(cfg, t);
    store.setRunningDigest(t.subject, t.desired_digest);
    store.setTenantState(t.subject, 'running');
    log(`[provisioner] ${t.ns} running at ${url}`);
  } catch (e) {
    log(`[provisioner] ${t.ns} failed: ${(e as Error).message}`);
    // Leave the tenant in `provisioning` — an admin can retry by re-hitting
    // provisionTenant (idempotent `helm upgrade --install`); there is no
    // separate "failed" state in the PRD's schema, and retry-in-place is
    // simpler than adding one for a pilot.
  }
}

// An OIDC `sub` is any string ("auth0|123", "…@…"); the admin page puts it in the path percent-encoded.
const pathSubject = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export function createApp(cfg: Config, store: Store, provisioner: Provisioner, log: (m: string) => void = console.log, adminOps: AdminOps = realAdminOps) {
  const auth = createAuthService(cfg, store);
  const sharedDeps: SharedDeps = { cfg, store, provisioner, log, pushRoster: adminOps.pushRoster };

  function ensureTenant(subject: string, email: string): Tenant {
    // Personal only: a shared workspace is never "your" tenant, whatever subject string an IdP hands out.
    let t: Tenant | null = store.findPersonalTenant(subject);
    if (!t) {
      t = store.createTenant(subject, email, { desiredDigest: cfg.imageTag });
      runProvisioning(cfg, store, provisioner, t, log); // not awaited — see runProvisioning
    }
    return t;
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cookieHeader = req.headers.get('cookie');
    const https = auth.isHttps(req.headers.get('x-forwarded-proto'));

    if (url.pathname === '/__health') return json({ ok: true });

    // Always a full OIDC round-trip, even with a session: the gate only sends people here when it saw NO
    // session, so short-circuiting on one it cannot see (a host-only cookie) would bounce forever.
    if (url.pathname === '/auth/login') {
      const { redirectUrl, setCookie } = await auth.oidcStart(https, safeReturnUrl(cfg, url.searchParams.get('rd')));
      return redirect(redirectUrl, [setCookie]);
    }

    if (url.pathname === '/auth/callback') {
      const result = await auth.oidcCallback(cookieHeader, url);
      if (!result.ok) return html(tpl.errorPage(result.status, result.error), result.status);
      const { setCookie } = auth.login(result.subject, https);
      if (result.role === 'user') ensureTenant(result.subject, result.email);
      store.touchLastSeen(result.subject);
      const back = safeReturnUrl(cfg, result.returnTo);
      // Back to the user's OWN workspace: through the handoff while it runs — the gate now lets the browser in, but
      // the cockpit has no session of its own yet in a fresh browser and would show its pairing screen (the handoff
      // lands on /__host/, the deeper path is not kept). Not running: the gate would refuse it again, and an edge
      // that answers that with a fresh sign-in (nginx auth-signin) would loop — /workspace resumes it instead.
      const backNs = back && !back.startsWith('/') ? tenantNsForHost(cfg, new URL(back).host) : null;
      const own = backNs ? store.findTenantByNs(backNs) : null;
      if (own && own.subject === result.subject) {
        if (own.state !== 'running') return redirect('/workspace', setCookie);
        return redirect(signInUrl(tenantUrl(cfg, own.ns), own.handoff_secret, own.email), setCookie);
      }
      return redirect(back || '/', setCookie);
    }

    if (url.pathname === '/auth/logout') {
      const { setCookie } = auth.logout(cookieHeader, https);
      return redirect('/', setCookie);
    }

    // The edge's forward_auth subrequest for every request to a tenant host — src/gate.ts has the contract.
    if (url.pathname === '/auth/verify') {
      const deny = (status: number, msg: string): Response =>
        new Response(msg + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      // Without the shared cookie no browser could ever pass; answering 302 would loop login -> tenant -> login.
      if (!cfg.cookieParentDomain) return deny(503, 'tenant gate misconfigured: the control plane needs CP_COOKIE_PARENT_DOMAIN=1');
      const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
      const ns = tenantNsForHost(cfg, host);
      if (!ns) return deny(403, 'not a workspace address');
      // `?redirect=0`: the edge cannot relay a redirect from here (nginx auth_request treats a 3xx as an error and
      // answers 500). It gets a 401 instead and sends the browser to /auth/login itself (auth-signin).
      const noRedirect = url.searchParams.get('redirect') === '0';
      const who = auth.principalFromCookieHeader(cookieHeader);
      if (!who) {
        if (noRedirect) return deny(401, 'sign in first');
        const rd = safeReturnUrl(cfg, requestedUrl(cfg, host, req.headers.get('x-forwarded-uri')));
        const login = `${cfg.publicUrl}/auth/login` + (rd ? `?rd=${encodeURIComponent(rd)}` : '');
        return new Response(null, { status: 302, headers: { location: login, 'cache-control': 'no-store' } });
      }
      const t = store.findTenantByNs(ns);
      // Owner of a personal tenant, or a member of a shared one (src/shared.ts decideAccess). Read fresh on every
      // request — nothing is cached here, so removing a member shuts them out on their very next request.
      // Same answer for "no such tenant" and "not yours": the gate does not reveal which addresses exist.
      const access = decideAccess(t, who, t?.kind === 'shared' ? store.getMember(t.ns, who.email) : null);
      if (!t || !access.allow) return deny(403, `this workspace is not open to ${who.email}`);
      if (t.state !== 'running') {
        const back = t.kind === 'shared' ? `/workspaces/${encodeURIComponent(t.name || '')}/open` : '/workspace';
        // The sign-in this 401 leads to lands on /workspace for a workspace that is not running (/auth/callback).
        if (noRedirect) return deny(401, 'this workspace is not running');
        return new Response(null, { status: 302, headers: { location: `${cfg.publicUrl}${back}`, 'cache-control': 'no-store' } });
      }
      return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
    }

    // Admin forms are plain POSTs with the session cookie. Every u-<id>.<orgDomain> is same-site with this
    // service (and, with CP_COOKIE_PARENT_DOMAIN, receives the cookie's scope), so SameSite=Lax alone does not
    // stop a page served from a tenant from posting here. A browser always sends Origin on a POST.
    if (req.method === 'POST' && url.pathname.startsWith('/admin/')) {
      const origin = req.headers.get('origin');
      if (origin && origin !== new URL(cfg.publicUrl).origin) return html(tpl.errorPage(403, 'cross-origin form post refused'), 403);
    }

    const principal = auth.principalFromCookieHeader(cookieHeader);

    // An org-admin has no workspace of their own by default (they land on /admin); /workspace gives them — or any
    // signed-in user — the same "get me into my workspace" flow as /.
    if (url.pathname === '/' || url.pathname === '/workspace') {
      if (!principal) return html(tpl.loginPage(cfg.orgDomain));
      if (principal.role === 'admin' && url.pathname === '/') return redirect('/admin');
      const t = ensureTenant(principal.subject, principal.email);
      store.touchLastSeen(principal.subject);
      if (t.state === 'provisioning') return html(tpl.startingPage());
      if (t.state === 'dormant') {
        provisioner.resumeTenant(cfg, t).then(
          () => store.setTenantState(t.subject, 'running'),
          (e) => log(`[provisioner] resume ${t.ns} failed: ${(e as Error).message}`),
        );
        return html(tpl.startingPage());
      }
      // K8S-3: land the user INSIDE their workspace. They authenticated here
      // moments ago against the org IdP; making them hunt for a pairing code
      // that only exists inside the pod was the single worst step of the
      // flow. `signInUrl` mints a one-shot, short-lived, email-bound token the
      // tenant redeems for a session cookie (src/handoff.ts, server/handoff.ts).
      if (t.state === 'running') return redirect(signInUrl(tenantUrl(cfg, t.ns), t.handoff_secret, t.email));
      return html(tpl.unavailablePage(t.state));
    }

    // Feeds the progress view on the starting page. Returns the SAME shape
    // whatever happens, so the page never has to handle an error envelope;
    // `redirect` is only ever present once the tenant is genuinely ready.
    if (url.pathname === '/api/progress') {
      if (!principal) return json({ phase: 'unavailable', steps: [], title: 'Signed out', detail: 'Sign in again to continue.', slow: false, failed: true }, 401);
      const t = store.findPersonalTenant(principal.subject);
      if (!t) return json({ phase: 'queued', steps: [], title: 'Setting up your workspace', detail: 'Getting started…', slow: false, failed: false });
      const snap = t.state === 'provisioning' || t.state === 'dormant'
        ? await adminOps.podSnapshot(cfg, t).catch(() => EMPTY_SNAPSHOT)
        : EMPTY_SNAPSHOT;
      const elapsed = Math.max(0, Date.now() - Date.parse(t.created_at || '') || 0);
      const p = stepsFor(t.state, snap, elapsed, cfg.orgName);
      return json({
        ...p,
        ...(p.phase === 'ready' ? { redirect: signInUrl(tenantUrl(cfg, t.ns), t.handoff_secret, t.email) } : {}),
      });
    }

    const shared = await handleShared(req, url, principal, { deps: sharedDeps, resumeTenant: provisioner.resumeTenant });
    if (shared) return shared;

    if (url.pathname === '/admin') {
      if (!principal) return redirect('/');
      if (principal.role !== 'admin') return html(tpl.errorPage(403, 'org-admin only'), 403);
      const tenants = store.listTenants();
      const backups: Record<string, { count: number; newestMs: number | null }> = {};
      for (const t of tenants) {
        const list = adminOps.listBackups(cfg, t.ns);
        backups[t.ns] = { count: list.length, newestMs: list[0]?.mtimeMs ?? null };
      }
      const desired = rolloutEnabled(cfg) ? store.getMeta<DesiredRecord>(DESIRED_META_KEY) : null;
      const profile: tpl.ProfileView | null = rolloutEnabled(cfg)
        ? {
            ref: desired?.ref ?? cfg.arigamiBundleRef,
            commit: desired?.commit || '',
            resolvedAt: desired?.resolvedAt || 0,
            ...(desired?.error ? { error: desired.error } : {}),
            haltedBy: desired?.commit ? haltingTenant(tenants, desired.commit)?.ns ?? null : null,
          }
        : null;
      return html(tpl.adminPage(tenants, principal.email, backups, profile, adminSection(store)));
    }

    // Profile rollout: "retry now" for a tenant whose apply failed — drops the
    // backoff wait, keeps the failure (and so the halt) until the retry passes.
    const profileRetry = /^\/admin\/tenants\/([^/]+)\/profile-retry$/.exec(url.pathname);
    if (profileRetry && req.method === 'POST') {
      if (!principal) return redirect('/');
      if (principal.role !== 'admin') return html(tpl.errorPage(403, 'org-admin only'), 403);
      const t = store.findTenantBySubject(profileRetry[1]);
      if (!t) return html(tpl.errorPage(404, 'no such tenant'), 404);
      store.clearProfileBackoff(t.subject);
      log(`[admin] ${t.ns} profile retry requested by ${principal.email}`);
      return redirect('/admin');
    }

    // K8S-3 §2: set the digest the reconcile loop converges this tenant to.
    // The upgrade itself happens on a later tick, and only when the tenant
    // has no turn in flight — this route just records intent.
    const digestAction = /^\/admin\/tenants\/([^/]+)\/digest$/.exec(url.pathname);
    if (digestAction && req.method === 'POST') {
      if (!principal) return redirect('/');
      if (principal.role !== 'admin') return html(tpl.errorPage(403, 'org-admin only'), 403);
      const subject = pathSubject(digestAction[1]);
      const t = store.findTenantBySubject(subject);
      if (!t) return html(tpl.errorPage(404, 'no such tenant'), 404);
      if (t.state === 'deleted') return html(tpl.errorPage(409, 'tenant is deleted'), 409);
      const form = await req.formData().catch(() => null);
      const digest = String(form?.get('digest') || '').trim();
      if (!DIGEST_RE.test(digest)) return html(tpl.errorPage(400, 'digest must be an image tag or sha256:<hex> digest'), 400);
      store.setDesiredDigest(subject, digest);
      log(`[admin] ${t.ns} desired_digest set to ${digest} by ${principal.email}`);
      return redirect('/admin');
    }

    // K8S-3 §3: on-demand backup (scheduled ones run from src/reconcile.ts).
    const backupAction = /^\/admin\/tenants\/([^/]+)\/backup$/.exec(url.pathname);
    if (backupAction && req.method === 'POST') {
      if (!principal) return redirect('/');
      if (principal.role !== 'admin') return html(tpl.errorPage(403, 'org-admin only'), 403);
      const t = store.findTenantBySubject(pathSubject(backupAction[1]));
      if (!t) return html(tpl.errorPage(404, 'no such tenant'), 404);
      if (t.state !== 'running') return html(tpl.errorPage(409, `cannot back up a tenant in state ${t.state}`), 409);
      try {
        const b = await adminOps.backupTenant(cfg, t);
        log(`[admin] ${t.ns} backed up (${b.name}, ${b.bytes} bytes) by ${principal.email}`);
      } catch (e) {
        return html(tpl.errorPage(500, (e as Error).message), 500);
      }
      return redirect('/admin');
    }

    const adminAction = /^\/admin\/tenants\/([^/]+)\/(suspend|resume|delete)$/.exec(url.pathname);
    if (adminAction && req.method === 'POST') {
      if (!principal) return redirect('/');
      if (principal.role !== 'admin') return html(tpl.errorPage(403, 'org-admin only'), 403);
      const [, rawSubject, action] = adminAction;
      const subject = pathSubject(rawSubject);
      const t = store.findTenantBySubject(subject);
      if (!t) return html(tpl.errorPage(404, 'no such tenant'), 404);
      const nextState = action === 'suspend' ? 'dormant' : action === 'resume' ? 'running' : 'deleted';
      if (!canTransition(t.state, nextState)) return html(tpl.errorPage(409, `cannot ${action} a tenant in state ${t.state}`), 409);
      try {
        if (action === 'suspend') await provisioner.suspendTenant(cfg, t);
        else if (action === 'resume') await provisioner.resumeTenant(cfg, t);
        else await provisioner.deleteTenant(cfg, t);
        store.setTenantState(subject, nextState);
      } catch (e) {
        return html(tpl.errorPage(500, (e as Error).message), 500);
      }
      return redirect('/admin');
    }

    return html(tpl.errorPage(404, 'not found'), 404);
  }

  return { handle, ensureTenant, auth, sharedDeps };
}

export type App = ReturnType<typeof createApp>;
