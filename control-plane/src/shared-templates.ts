// Pages for shared workspaces: the workspace picker (/workspaces), the wait page, and the admin-page section.
// Same plain server-rendered HTML as templates.ts, which owns the shell.
import type { Tenant } from './db.js';
import { esc, page } from './templates.js';
import { SHARED_ROLES, type Member, type SharedRole, type SharedTenant } from './shared.js';

export function workspacesPage(email: string, personal: Tenant | null, shared: { tenant: SharedTenant; role: SharedRole }[], isAdmin: boolean): string {
  const rows = shared
    .map(({ tenant: t, role }) => `<tr>
      <td><strong>${esc(t.name)}</strong>${t.org_host ? ' <small>(org host)</small>' : ''}</td>
      <td>${esc(role)}</td>
      <td><span class="state state-${esc(t.state)}">${esc(t.state)}</span></td>
      <td><a class="button" href="/workspaces/${esc(t.name)}/open">Open</a></td>
    </tr>`)
    .join('\n');
  return page(
    'Workspaces — Arigami',
    `<h1>Workspaces</h1><p>Signed in as ${esc(email)}.${isAdmin ? ' <a href="/admin">Admin</a> ·' : ''} <a href="/auth/logout">Sign out</a></p>
     <p><a class="button" href="/workspace">Open my workspace</a>${personal ? ` <small>${esc(personal.state)}</small>` : ''}</p>
     <h2>Shared with you</h2>
     <table><thead><tr><th>Workspace</th><th>Your role</th><th>State</th><th></th></tr></thead>
     <tbody>${rows || '<tr><td colspan="4">No shared workspaces yet.</td></tr>'}</tbody></table>
     <p><small>A shared workspace is one machine for several people: everyone in it sees its sessions and uses the
     accounts connected there. Viewers can look but never run a turn.</small></p>`,
  );
}

/** Shown while a shared workspace is starting or waking up; reloads itself until the open route can redirect. */
export function sharedWaitPage(name: string, state: string): string {
  return page(
    'Starting — Arigami',
    `<meta http-equiv="refresh" content="4"><h1>Starting ${esc(name)}</h1>
     <p class="detail">The shared workspace is ${esc(state)}. This page opens it as soon as it is ready.</p>
     <p><a href="/workspaces">Back to workspaces</a></p>`,
  );
}

const roleOptions = (sel: string): string =>
  SHARED_ROLES.map((r) => `<option value="${r}"${r === sel ? ' selected' : ''}>${r}</option>`).join('');

export function sharedAdminSection(items: { tenant: SharedTenant; members: Member[] }[]): string {
  const blocks = items
    .map(({ tenant: t, members }) => {
      const n = esc(t.name);
      const synced = t.roster_gen === t.roster_synced_gen;
      const memberRows = members
        .map((m) => `<tr><td>${esc(m.email)}</td><td>${esc(m.role)}</td><td><small>${esc(m.added_by)} · ${esc(m.added_at.slice(0, 16))}Z</small></td>
          <td>${t.state === 'deleted' ? '' : `<form class="inline" method="post" action="/admin/shared/${n}/members/remove"><input type="hidden" name="email" value="${esc(m.email)}"><button type="submit">Remove</button></form>`}</td></tr>`)
        .join('');
      return `<h3>${n} <small>${esc(t.ns)} · <span class="state state-${esc(t.state)}">${esc(t.state)}</span>${t.org_host ? ' · org host' : ''}${synced ? '' : ' · <span class="pending">member changes not yet applied inside the workspace</span>'}</small></h3>
      ${t.state === 'deleted' ? '' : `<div class="formrow">
        <form method="post" action="/admin/shared/${n}/policy"><span class="fld">Who may open it</span>
          <select name="policy"><option value="explicit"${t.member_policy === 'explicit' ? ' selected' : ''}>listed members only</option><option value="org"${t.member_policy === 'org' ? ' selected' : ''}>any org member</option></select>
          <label class="fld">default role <select name="default_role">${roleOptions(t.default_role)}</select></label><button type="submit">Save</button></form>
        <form class="inline" method="post" action="/admin/shared/${n}/delete" onsubmit="return confirm('Delete shared workspace ${n}? This deletes its namespace and data.')"><button type="submit" class="danger">Delete</button></form></div>
      <table><thead><tr><th>Member</th><th>Role</th><th>Added</th><th></th></tr></thead><tbody>${memberRows || '<tr><td colspan="4">No listed members.</td></tr>'}</tbody></table>
      <form class="formrow" method="post" action="/admin/shared/${n}/members"><input name="email" placeholder="name@example.com" size="24">
        <select name="role">${roleOptions('member')}</select><button type="submit">Add / change role</button></form>`}`;
    })
    .join('\n');
  return `<h2>Shared workspaces</h2>
    <p><small>One tenant that several org members open, each signed in as themselves. Org-admins manage who is in;
    being an org-admin does not let you in. Removing someone shuts them out at the edge at once and inside the
    workspace as soon as it hears the new member list.</small></p>
    ${blocks || '<p>None yet.</p>'}
    <form class="formrow" method="post" action="/admin/shared" style="margin-top:20px"><strong>New shared workspace</strong>
      <input name="name" placeholder="name (e.g. team)" size="14">
      <select name="policy"><option value="explicit">listed members only</option><option value="org">any org member</option></select>
      <label class="fld">default role <select name="default_role">${roleOptions('member')}</select></label>
      <label class="fld"><input type="checkbox" name="org_host" value="1"${items.some((i) => i.tenant.org_host && i.tenant.state !== 'deleted') ? '' : ' checked'}> org host (runs org-wide cron jobs)</label>
      <button type="submit">Create</button></form>`;
}
