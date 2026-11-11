// Pages for shared workspaces: the workspace picker (/workspaces), the wait page, and the admin-page section.
// Same plain server-rendered HTML as templates.ts, which owns the shell.
import type { Tenant } from './db.js';
import { esc, page } from './templates.js';
import type { PersonalWorkspaces } from './config.js';
import { SHARED_ROLES, type Member, type SharedRole, type SharedTenant } from './shared.js';

const STATE_LABEL: Record<string, string> = { running: 'running', provisioning: 'being set up', dormant: 'asleep', archived: 'archived' };
const stateBadge = (state: string): string => `<span class="state state-${esc(state)}">${esc(STATE_LABEL[state] || state)}</span>`;

/**
 * The chooser (`/workspaces`, and where `/` lands someone with a choice to make): one card per place the person can
 * work — every shared workspace they are a member of, and (unless the org runs shared-only) their own personal one.
 * `personal` is their live personal tenant or null (none yet / deleted). `mode` is CP_PERSONAL_WORKSPACES.
 */
export function workspacesPage(email: string, personal: Tenant | null, shared: { tenant: SharedTenant; role: SharedRole }[], isAdmin: boolean, mode: PersonalWorkspaces = 'auto'): string {
  const sharedCards = shared
    .map(({ tenant: t, role }) => `<div class="card">
      <div class="head"><strong>${esc(t.name)}</strong>${stateBadge(t.state)}</div>
      <p class="detail">Shared workspace${t.org_host ? ' (org host)' : ''} · your role: ${esc(role)}</p>
      <div class="act"><a class="button" href="/workspaces/${esc(t.name)}/open">Open</a></div>
    </div>`)
    .join('\n');
  // An org-admin's own workspace is unaffected by the mode; everyone else only gets the card when personal workspaces exist at all.
  const offerPersonal = isAdmin || mode !== 'never';
  const personalAction = personal || mode === 'auto' || isAdmin
    ? `<a class="button" href="/workspace">Open my workspace</a>`
    : `<form class="inline" method="post" action="/workspaces/personal"><button type="submit" class="primary">Create my workspace</button></form>`;
  const personalCard = offerPersonal
    ? `<div class="card">
      <div class="head"><strong>Your own workspace</strong>${personal ? stateBadge(personal.state) : ''}</div>
      <p class="detail">Private to you. It runs on its own dedicated machine, so it uses more of the organisation's resources than joining a shared workspace.</p>
      <div class="act">${personalAction}</div>
    </div>`
    : '';
  const hint = !shared.length
    ? mode === 'never'
      ? '<p class="detail">You are not a member of any shared workspace yet. Ask an organisation admin to invite you.</p>'
      : mode === 'choose' && !personal
        ? '<p class="detail">An organisation admin can also invite you to a shared workspace, which needs no machine of your own.</p>'
        : ''
    : '';
  return page(
    'Workspaces — Arigami',
    `<h1>Where do you want to work?</h1><p>Signed in as ${esc(email)}.${isAdmin ? ' <a href="/admin">Admin</a> ·' : ''} <a href="/auth/logout">Sign out</a></p>
     <div class="cards">${sharedCards}${personalCard}</div>
     ${hint}
     <p><small>A shared workspace is one machine for several people: everyone in it sees its sessions and uses the
     accounts connected there. Viewers can look but never run a turn.</small></p>`,
  );
}

/** `never` mode: a non-admin asked for a personal workspace the organisation does not offer. */
export function sharedOnlyPage(email: string, shared: number): string {
  return page(
    'Shared workspaces only — Arigami',
    `<h1>This organisation uses shared workspaces</h1>
     <p>Personal workspaces are not offered here. ${shared ? 'Pick a shared workspace you are a member of.' : `Ask an organisation admin to invite <strong>${esc(email)}</strong> to one.`}</p>
     <p>${shared ? '<a class="button" href="/workspaces">Choose a workspace</a> ' : ''}<a href="/auth/logout">Sign out</a></p>`,
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
      <input name="name" placeholder="name (e.g. team)" size="14" required minlength="2" maxlength="32" pattern="[A-Za-z][A-Za-z0-9 _\\-]{1,31}" title="2-32 characters, English letters, digits and dashes, starting with a letter (e.g. team-alpha)" autocapitalize="none" autocomplete="off">
      <select name="policy"><option value="explicit">listed members only</option><option value="org">any org member</option></select>
      <label class="fld">default role <select name="default_role">${roleOptions('member')}</select></label>
      <label class="fld"><input type="checkbox" name="org_host" value="1"${items.some((i) => i.tenant.org_host && i.tenant.state !== 'deleted') ? '' : ' checked'}> org host (runs org-wide cron jobs)</label>
      <button type="submit">Create</button>
      <small class="detail" style="flex-basis:100%">Name: 2–32 English letters, digits or dashes, starting with a letter (e.g. <code>team-alpha</code>). It becomes the workspace's address.</small></form>`;
}
