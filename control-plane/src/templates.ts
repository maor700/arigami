// Plain server-rendered HTML — no SPA, no build step, matches the task's
// "the user-facing bit, minimal" instruction. One shared shell + escape().
import type { Tenant } from './db.js';

export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 640px; margin: 10vh auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 20px; }
  a.button, button { display: inline-block; padding: 10px 18px; background: #1a1a1a; color: #fff; text-decoration: none; border-radius: 6px; border: none; cursor: pointer; font-size: 14px; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; }
  .state { padding: 2px 8px; border-radius: 4px; font-size: 12px; }
  .state-running { background: #d6f5d6; }
  .state-provisioning { background: #fff3cd; }
  .state-dormant { background: #eee; }
  .state-archived { background: #eee; }
  .state-deleted { background: #f8d7da; }
  form.inline { display: inline; }
</style></head><body>${body}</body></html>`;
}

export function loginPage(orgDomain: string): string {
  return shell(
    'Sign in — Arigami',
    `<h1>Arigami</h1><p>Sign in with your organisation account to get your own workspace on <code>${esc(orgDomain)}</code>.</p>
     <p><a class="button" href="/auth/login">Sign in</a></p>`,
  );
}

export function errorPage(status: number, message: string): string {
  return shell(`Error ${status}`, `<h1>Error ${status}</h1><p>${esc(message)}</p><p><a href="/">Back</a></p>`);
}

export function startingPage(): string {
  return shell(
    'Your workspace is starting — Arigami',
    `<meta http-equiv="refresh" content="4">
     <h1>Your workspace is starting…</h1>
     <p>This usually takes under a minute. This page refreshes automatically.</p>`,
  );
}

export function unavailablePage(state: string): string {
  return shell(
    'Workspace unavailable — Arigami',
    `<h1>Your workspace is ${esc(state)}</h1><p>Contact your organisation admin to reactivate it.</p>`,
  );
}

export function adminPage(tenants: Tenant[], adminEmail: string): string {
  const rows = tenants
    .map(
      (t) => `<tr>
      <td>${esc(t.email)}</td>
      <td>${esc(t.ns)}</td>
      <td><span class="state state-${esc(t.state)}">${esc(t.state)}</span></td>
      <td>${esc(t.last_seen_at)}</td>
      <td>${esc(t.running_digest || t.desired_digest || '—')}</td>
      <td>
        ${t.state === 'running' ? suspendForm(t.subject) : ''}
        ${t.state === 'dormant' ? resumeForm(t.subject) : ''}
        ${t.state !== 'deleted' ? deleteForm(t.subject) : ''}
      </td>
    </tr>`,
    )
    .join('\n');
  return shell(
    'Tenants — Arigami admin',
    `<h1>Tenants</h1><p>Signed in as ${esc(adminEmail)} (org-admin). <a href="/auth/logout">Sign out</a></p>
     <table>
       <thead><tr><th>Email</th><th>Namespace</th><th>State</th><th>Last seen</th><th>Image</th><th>Actions</th></tr></thead>
       <tbody>${rows || '<tr><td colspan="6">No tenants yet.</td></tr>'}</tbody>
     </table>`,
  );
}

function suspendForm(subject: string): string {
  return `<form class="inline" method="post" action="/admin/tenants/${esc(subject)}/suspend"><button type="submit">Suspend</button></form>`;
}
function resumeForm(subject: string): string {
  return `<form class="inline" method="post" action="/admin/tenants/${esc(subject)}/resume"><button type="submit">Resume</button></form>`;
}
function deleteForm(subject: string): string {
  return `<form class="inline" method="post" action="/admin/tenants/${esc(subject)}/delete" onsubmit="return confirm('Delete this tenant? This deletes the namespace.')"><button type="submit">Delete</button></form>`;
}
