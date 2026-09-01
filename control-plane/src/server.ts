import type { Config } from './config.js';
import type { Store, Tenant } from './db.js';
import { createAuthService } from './auth.js';
import * as tpl from './templates.js';
import { canTransition } from './state-machine.js';
import { tenantUrl } from './provisioner.js';

export interface Provisioner {
  provisionTenant(cfg: Config, t: Tenant): Promise<{ url: string }>;
  deleteTenant(cfg: Config, t: Tenant): Promise<void>;
  suspendTenant(cfg: Config, t: Tenant): Promise<void>;
  resumeTenant(cfg: Config, t: Tenant): Promise<void>;
}

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (location: string, extraHeaders: Record<string, string> = {}): Response =>
  new Response(null, { status: 302, headers: { location, ...extraHeaders } });
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

export function createApp(cfg: Config, store: Store, provisioner: Provisioner, log: (m: string) => void = console.log) {
  const auth = createAuthService(cfg, store);

  function ensureTenant(subject: string, email: string): Tenant {
    let t = store.findTenantBySubject(subject);
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

    if (url.pathname === '/auth/login') {
      const { redirectUrl, setCookie } = await auth.oidcStart(https);
      return redirect(redirectUrl, { 'set-cookie': setCookie });
    }

    if (url.pathname === '/auth/callback') {
      const result = await auth.oidcCallback(cookieHeader, url);
      if (!result.ok) return html(tpl.errorPage(result.status, result.error), result.status);
      const { setCookie } = auth.login(result.subject, https);
      if (result.role === 'user') ensureTenant(result.subject, result.email);
      store.touchLastSeen(result.subject);
      return redirect('/', { 'set-cookie': setCookie });
    }

    if (url.pathname === '/auth/logout') {
      const { setCookie } = auth.logout(cookieHeader, https);
      return redirect('/', { 'set-cookie': setCookie });
    }

    const principal = auth.principalFromCookieHeader(cookieHeader);

    if (url.pathname === '/') {
      if (!principal) return html(tpl.loginPage(cfg.orgDomain));
      if (principal.role === 'admin') return redirect('/admin');
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
      if (t.state === 'running') return redirect(tenantUrl(cfg, t.ns));
      return html(tpl.unavailablePage(t.state));
    }

    if (url.pathname === '/admin') {
      if (!principal) return redirect('/');
      if (principal.role !== 'admin') return html(tpl.errorPage(403, 'org-admin only'), 403);
      return html(tpl.adminPage(store.listTenants(), principal.email));
    }

    const adminAction = /^\/admin\/tenants\/([^/]+)\/(suspend|resume|delete)$/.exec(url.pathname);
    if (adminAction && req.method === 'POST') {
      if (!principal) return redirect('/');
      if (principal.role !== 'admin') return html(tpl.errorPage(403, 'org-admin only'), 403);
      const [, subject, action] = adminAction;
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

  return { handle, ensureTenant, auth };
}

export type App = ReturnType<typeof createApp>;
