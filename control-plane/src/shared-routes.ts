// HTTP routes for shared workspaces, mounted by server.ts before its own fallthrough. Returns null for any path
// that is not one of ours.
//
//   GET  /workspaces                         the picker: your own workspace + every shared one you may open
//   GET  /workspaces/<name>/open             membership check -> handoff into the tenant AS YOU, with your role
//   POST /admin/shared                       create              (org-admin; Origin-checked by server.ts)
//   POST /admin/shared/<name>/members        add / change role
//   POST /admin/shared/<name>/members/remove remove
//   POST /admin/shared/<name>/policy         member policy + default role
//   POST /admin/shared/<name>/delete         delete (namespace and data)
import type { Config } from './config.js';
import type { Store } from './db.js';
import * as tpl from './templates.js';
import { tenantUrl } from './provisioner.js';
import { signInUrl } from './handoff.js';
import { decideAccess, tenantRoleFor, isMemberPolicy, isSharedRole } from './shared.js';
import { workspacesPage, sharedWaitPage, sharedAdminSection } from './shared-templates.js';
import { SharedError, createShared, addMember, removeMember, setPolicy, deleteShared, type SharedDeps } from './shared-ops.js';

type Principal = { subject: string; email: string; role: 'admin' | 'user' };

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
};
const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });

export interface SharedRouteCtx {
  deps: SharedDeps;
  resumeTenant(cfg: Config, t: import('./db.js').Tenant): Promise<void>;
}

/** The admin page's shared section (server.ts appends it to tpl.adminPage). */
export function adminSection(store: Store): string {
  return sharedAdminSection(store.listShared().map((t) => ({ tenant: t, members: store.listMembers(t.ns) })));
}

export async function handleShared(req: Request, url: URL, principal: Principal | null, ctx: SharedRouteCtx): Promise<Response | null> {
  const { cfg, store, log } = ctx.deps;
  const p = url.pathname;

  if (p === '/workspaces' && req.method === 'GET') {
    if (!principal) return redirect('/');
    return html(workspacesPage(principal.email, store.findPersonalTenant(principal.subject), store.sharedFor(principal), principal.role === 'admin'));
  }

  const open = /^\/workspaces\/([^/]+)\/open$/.exec(p);
  if (open && req.method === 'GET') {
    if (!principal) return redirect(`/auth/login?rd=${encodeURIComponent(p)}`);
    const t = store.findShared(decode(open[1]));
    const a = decideAccess(t, principal, t ? store.getMember(t.ns, principal.email) : null);
    // Same answer for "no such workspace" and "not a member": the picker does not enumerate names.
    if (!a.allow || !t) return html(tpl.errorPage(403, `this workspace is not shared with ${principal.email}`), 403);
    if (t.state === 'running') {
      log(`[shared] ${t.name}: ${principal.email} opened as ${a.role}`);
      return redirect(signInUrl(tenantUrl(cfg, t.ns), t.handoff_secret, principal.email, tenantRoleFor(a.role)));
    }
    if (t.state === 'dormant') {
      ctx.resumeTenant(cfg, t).then(
        () => store.setTenantState(t.subject, 'running'),
        (e) => log(`[provisioner] resume ${t.ns} failed: ${(e as Error).message}`),
      );
      return html(sharedWaitPage(t.name, 'waking up'));
    }
    if (t.state === 'provisioning') return html(sharedWaitPage(t.name, 'being set up'));
    return html(tpl.unavailablePage(t.state));
  }

  if (!p.startsWith('/admin/shared') || req.method !== 'POST') return null;
  if (!principal) return redirect('/');
  if (principal.role !== 'admin') return html(tpl.errorPage(403, 'org-admin only'), 403);
  const form = await req.formData().catch(() => null);
  const field = (k: string) => String(form?.get(k) ?? '').trim();
  const by = principal.email;
  try {
    if (p === '/admin/shared') {
      const policy = field('policy') || 'explicit';
      const defaultRole = field('default_role') || 'member';
      if (!isMemberPolicy(policy)) throw new SharedError('policy must be explicit or org');
      if (!isSharedRole(defaultRole)) throw new SharedError('bad default role');
      // The creating admin is NOT added: being an org-admin does not make you a member (fail closed). They add
      // themselves like anyone else, and that is in the log.
      createShared(ctx.deps, { name: field('name'), policy, defaultRole, orgHost: field('org_host') === '1', by });
      return redirect('/admin');
    }
    const m = /^\/admin\/shared\/([^/]+)\/(members|members\/remove|policy|delete)$/.exec(p);
    if (!m) return html(tpl.errorPage(404, 'not found'), 404);
    const name = decode(m[1]);
    if (m[2] === 'members') {
      const role = field('role') || 'member';
      if (!isSharedRole(role)) throw new SharedError('bad role');
      await addMember(ctx.deps, name, field('email'), role, by);
    } else if (m[2] === 'members/remove') {
      await removeMember(ctx.deps, name, field('email'), by);
    } else if (m[2] === 'policy') {
      const policy = field('policy');
      const defaultRole = field('default_role') || 'member';
      if (!isMemberPolicy(policy) || !isSharedRole(defaultRole)) throw new SharedError('bad policy or default role');
      await setPolicy(ctx.deps, name, policy, defaultRole, by);
    } else {
      await deleteShared(ctx.deps, name, by);
    }
    return redirect('/admin');
  } catch (e) {
    const status = e instanceof SharedError ? e.status : 500;
    return html(tpl.errorPage(status, (e as Error).message), status);
  }
}
