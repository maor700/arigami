// Plain server-rendered HTML — no SPA, no build step, matches the task's
// "the user-facing bit, minimal" instruction. One shared shell + escape().
import type { Tenant } from './db.js';

export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// The look follows the cockpit (web/src/index.css): Inter, the --hb-* surface/status tokens, the mint brand accent,
// 1px hairline borders, soft rounded panels. No theme switch here — it follows the OS (the cockpit's dark palette).
const CSS = `
  :root { color-scheme: light dark; --brand: #6eceb7; --bg: #ffffff; --panel: #fcfcfb; --fg: #1a1a1a; --dim: #777777; --border: #e2e2e0; --hair: #ececec; --sel: rgba(0,0,0,.055);
    --ok: #2f7d4f; --ok-bg: #eaf6ef; --ok-line: #bfe3cf; --warn: #82671b; --warn-bg: #fbf3e0; --warn-line: #e7d3a8; --err: #9c3b33; --err-bg: #fbecea; --err-line: #e2c4c0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0b0d10; --panel: #111418; --fg: #e8eaee; --dim: #8e96a4; --border: #303743; --hair: #262b33; --sel: rgba(255,255,255,.06);
      --ok: #7fcf9c; --ok-bg: #12211a; --ok-line: #2b5039; --warn: #e0bd6a; --warn-bg: #1f1a0f; --warn-line: #5a4a24; --err: #f08f86; --err-bg: #261413; --err-line: #6a302b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 Inter, "Rubik Variable", system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  ::selection { background: color-mix(in srgb, var(--brand) 35%, transparent); }
  .top { border-bottom: 1px solid var(--hair); background: var(--panel); }
  .top .in { max-width: 640px; margin: 0 auto; padding: 14px 20px; }
  .top .in.wide { max-width: 1240px; }
  .logo { font-weight: 650; letter-spacing: -.01em; }
  .logo::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 8px; border-radius: 50%; background: var(--brand); }
  main { max-width: 640px; margin: 8vh auto; padding: 0 20px; }
  main.wide { max-width: 1240px; margin: 28px auto 64px; }
  h1 { font-size: 20px; font-weight: 650; letter-spacing: -.01em; margin: 0 0 8px; }
  h2 { font-size: 16px; font-weight: 650; margin: 36px 0 6px; }
  h3 { font-size: 14px; font-weight: 650; margin: 22px 0 6px; }
  p { margin: 8px 0; }
  a { color: inherit; text-decoration-color: var(--border); text-underline-offset: 3px; }
  a:hover { text-decoration-color: var(--brand); }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--sel); padding: 1px 5px; border-radius: 4px; }
  small, .detail { color: var(--dim); font-size: 12px; }
  a.button, button { display: inline-flex; align-items: center; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); color: var(--fg);
    font: inherit; font-size: 13px; font-weight: 500; line-height: 1.3; height: 32px; justify-content: center; text-decoration: none; white-space: nowrap; cursor: pointer; transition: background .12s, border-color .12s; }
  a.button:hover, button:hover { background: var(--sel); border-color: var(--dim); }
  a.button { background: var(--brand); border-color: var(--brand); color: #10231d; padding: 0 18px; height: 38px; font-size: 14px; }
  a.button:hover { background: color-mix(in srgb, var(--brand) 85%, #fff); border-color: transparent; }
  button.danger { color: var(--err); border-color: var(--err-line); background: var(--err-bg); }
  button.danger:hover { border-color: var(--err); background: var(--err-bg); }
  :focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  input, select { height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font: inherit; font-size: 13px; }
  input:focus, select:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 25%, transparent); }
  input[type=checkbox] { accent-color: var(--brand); }
  table { border-collapse: separate; border-spacing: 0; width: 100%; margin-top: 16px; font-size: 13px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--panel); }
  th, td { text-align: left; vertical-align: middle; padding: 9px 10px; border-bottom: 1px solid var(--hair); }
  th { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--dim); background: var(--bg); }
  tr:last-child td { border-bottom: none; }
  td form.inline { margin: 0; white-space: nowrap; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
  .row > span { white-space: nowrap; }
  .row.col { flex-direction: column; align-items: flex-start; }
  .formrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 12px 0; }
  .formrow form { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0; }
  .fld { display: inline-flex; align-items: center; gap: 6px; color: var(--dim); }
  td input { width: 96px; }
  td:nth-child(2), td:nth-child(4) { white-space: nowrap; }
  .state { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; border: 1px solid var(--border); background: var(--sel); color: var(--dim); }
  .state-running { background: var(--ok-bg); border-color: var(--ok-line); color: var(--ok); }
  .state-provisioning { background: var(--warn-bg); border-color: var(--warn-line); color: var(--warn); }
  .state-deleted { background: var(--err-bg); border-color: var(--err-line); color: var(--err); }
  form.inline { display: inline; }
  .pending { color: var(--warn); font-weight: 600; }
  .failed { color: var(--err); font-weight: 600; }
  .banner { padding: 10px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel); font-size: 13px; }
  .banner.bad { background: var(--err-bg); border-color: var(--err-line); }
  .steps { list-style: none; padding: 0; margin: 24px 0; }
  .step { display: flex; align-items: center; gap: 10px; padding: 7px 0; color: var(--dim); transition: color .3s; }
  .step-done, .step-active { color: var(--fg); }
  .step-failed { color: var(--err); }
  .mark { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none; font-size: 12px; }
  .step-done .mark { color: var(--ok); }
  .mark i { width: 11px; height: 11px; border: 2px solid var(--brand); border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mark i { animation-duration: 2.4s; } }
  .meta { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
`;

function shell(title: string, body: string, tail = ''): string {
  // Pages with a table (admin) get the wide column; the rest stay a narrow card-less column.
  const wide = body.includes('<table');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style></head><body><header class="top"><div class="in${wide ? ' wide' : ''}"><span class="logo">Arigami</span></div></header><main${wide ? ' class="wide"' : ''}>${body}</main>${tail}</body></html>`;
}

/** The shared shell, for pages rendered outside this file (shared-templates.ts). */
export const page = (title: string, body: string, tail = ''): string => shell(title, body, tail);

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

/**
 * The wait. A first provision is 30-90s of real work (namespace, image pull,
 * boot, org bundle), so this page's job is to make that legible rather than to
 * hide it: named steps that tick over from live Kubernetes state
 * (src/progress.ts), an elapsed timer, and an honest message when something is
 * actually stuck instead of a spinner that never ends.
 *
 * It polls `GET /api/progress` and navigates itself the moment the tenant is
 * ready — the redirect target is minted server-side (a one-shot sign-in), so
 * the user lands INSIDE their workspace, not on a pairing screen. No-JS
 * fallback: the <noscript> meta-refresh keeps the old behaviour.
 */
export function startingPage(): string {
  return shell(
    'Setting up your workspace — Arigami',
    `<noscript><meta http-equiv="refresh" content="5"></noscript>
     <h1 id="title">Setting up your workspace</h1>
     <p id="detail" class="detail">Getting started…</p>
     <ol id="steps" class="steps"></ol>
     <p class="meta"><span id="elapsed"></span><span id="slow" hidden> · this is taking longer than usual</span></p>`,
    `<script>
(function () {
  var byKey = {};
  var t0 = Date.now();
  var stopped = false;
  function icon(state) {
    return state === 'done' ? '✓' : state === 'failed' ? '✕' : state === 'active' ? '' : '';
  }
  function render(p) {
    document.getElementById('title').textContent = p.title;
    document.getElementById('detail').textContent = p.detail;
    var ol = document.getElementById('steps');
    ol.innerHTML = '';
    p.steps.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'step step-' + s.state;
      var mark = document.createElement('span');
      mark.className = 'mark';
      if (s.state === 'active') mark.appendChild(document.createElement('i'));
      else mark.textContent = icon(s.state);
      li.appendChild(mark);
      var txt = document.createElement('span');
      txt.textContent = s.label;
      li.appendChild(txt);
      ol.appendChild(li);
    });
    document.getElementById('slow').hidden = !p.slow;
    if (p.failed) stopped = true;
  }
  function tick() {
    var s = Math.round((Date.now() - t0) / 1000);
    var m = Math.floor(s / 60);
    document.getElementById('elapsed').textContent = m ? m + 'm ' + (s % 60) + 's' : s + 's';
  }
  function poll() {
    if (stopped) return;
    fetch('/api/progress', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (p) {
        render(p);
        if (p.phase === 'ready' && p.redirect) { stopped = true; location.href = p.redirect; return; }
        if (!stopped) setTimeout(poll, 2000);
      })
      .catch(function () { setTimeout(poll, 4000); });
  }
  setInterval(tick, 1000);
  tick();
  poll();
})();
</script>`,
  );
}

export function unavailablePage(state: string): string {
  return shell(
    'Workspace unavailable — Arigami',
    `<h1>Your workspace is ${esc(state)}</h1><p>Contact your organisation admin to reactivate it.</p>`,
  );
}

/** What the admin page knows about the profile rollout (src/profile-rollout.ts). null = rollout off. */
export interface ProfileView {
  ref: string;
  commit: string;
  resolvedAt: number;
  error?: string;
  /** ns whose failed apply of the desired commit is holding the rollout */
  haltedBy: string | null;
}

const shortSha = (c: string) => (c ? c.slice(0, 8) : '—');

/** One tenant's profile cell: applied commit, drift towards the desired one, or the failure that holds it. */
export function profileCell(t: Tenant, p: ProfileView | null): string {
  if (!p) return t.profile_commit ? `<code>${esc(shortSha(t.profile_commit))}</code>` : '—';
  const applied = t.profile_commit ? `<code>${esc(shortSha(t.profile_commit))}</code>` : '—';
  if (!p.commit || t.state === 'deleted') return applied;
  if (t.profile_failed_commit === p.commit && t.profile_failures > 0) {
    const when = t.profile_next_at ? ` — retry ${esc(new Date(t.profile_next_at).toISOString().slice(11, 19))}Z` : '';
    return `${applied} <span class="failed" title="${esc(t.profile_error)}">✗ ${esc(shortSha(p.commit))} failed ×${t.profile_failures}${when}</span>
      <br><small class="detail">${esc(t.profile_error.slice(0, 160))}</small>${t.state === 'running' ? profileRetryForm(t.subject) : ''}`;
  }
  if (t.profile_commit === p.commit) return `${applied} <small class="detail">✓</small>`;
  const why = p.haltedBy && p.haltedBy !== t.ns ? ' (halted)' : t.state !== 'running' ? ` (${esc(t.state)})` : '';
  return `${applied} <span class="pending">→ ${esc(shortSha(p.commit))}${why}</span>`;
}

function profileBanner(p: ProfileView | null): string {
  if (!p) return '';
  const target = `<code>${esc(p.ref || 'default branch')}</code> → <code>${esc(shortSha(p.commit))}</code>`;
  const err = p.error ? `<br><span class="failed">Cannot resolve the profile ref: ${esc(p.error)}</span> (nothing is rolled out until it resolves)` : '';
  const halt = p.haltedBy
    ? `<br><span class="failed">Rollout halted: ${esc(p.haltedBy)} failed to apply ${esc(shortSha(p.commit))}.</span> Fix the profile (a new commit restarts the rollout) or retry that tenant.`
    : '';
  return `<p class="banner${p.error || p.haltedBy ? ' bad' : ''}">Org profile: ${target}${err}${halt}</p>`;
}

export function adminPage(
  tenants: Tenant[],
  adminEmail: string,
  backups: Record<string, { count: number; newestMs: number | null }> = {},
  profile: ProfileView | null = null,
  extra = '',
): string {
  const rows = tenants
    .map((t) => {
      const b = backups[t.ns];
      const digest =
        t.desired_digest && t.desired_digest !== t.running_digest
          ? `${esc(t.running_digest || '—')} <span class="pending">→ ${esc(t.desired_digest)}</span>`
          : esc(t.running_digest || t.desired_digest || '—');
      return `<tr>
      <td>${t.kind === 'shared' ? `<em>shared:</em> ${esc(t.name || '')}` : esc(t.email)}</td>
      <td>${esc(t.ns)}</td>
      <td><span class="state state-${esc(t.state)}">${esc(t.state)}</span></td>
      <td>${esc(t.last_seen_at)}</td>
      <td><div class="row"><span>${digest}</span>${t.state !== 'deleted' ? digestForm(t.subject) : ''}</div></td>
      <td>${profileCell(t, profile)}</td>
      <td><div class="row"><span>${b ? `${b.count}${b.newestMs ? ` <small>(${esc(new Date(b.newestMs).toISOString().slice(0, 16))}Z)</small>` : ''}` : '0'}</span>
        ${t.state === 'running' ? backupForm(t.subject) : ''}</div></td>
      <td><div class="row">
        ${t.state === 'running' ? suspendForm(t.subject) : ''}
        ${t.state === 'dormant' ? resumeForm(t.subject) : ''}
        ${t.state !== 'deleted' ? deleteForm(t.subject) : ''}
      </div></td>
    </tr>`;
    })
    .join('\n');
  return shell(
    'Tenants — Arigami admin',
    `<h1>Tenants</h1><p>Signed in as ${esc(adminEmail)} (org-admin). <a href="/workspace">Open my workspace</a> · <a href="/workspaces">Workspaces</a> · <a href="/auth/logout">Sign out</a></p>
     <p><small>Image and profile changes converge on the next reconcile tick, and only while the tenant has no
     turn in flight. Restores are an operator action: <code>bun src/cli.ts restore …</code>.</small></p>
     ${profileBanner(profile)}
     <table>
       <thead><tr><th>Email</th><th>Namespace</th><th>State</th><th>Last seen</th><th>Image</th><th title="Profile (applied → desired)">Profile (applied → desired)</th><th>Backups</th><th>Actions</th></tr></thead>
       <tbody>${rows || '<tr><td colspan="8">No tenants yet.</td></tr>'}</tbody>
     </table>${extra}`,
  );
}

function digestForm(subject: string): string {
  return `<form class="inline" method="post" action="/admin/tenants/${esc(encodeURIComponent(subject))}/digest">
    <input name="digest" placeholder="tag or sha256:…" size="14"><button type="submit">Set</button></form>`;
}
function profileRetryForm(subject: string): string {
  return `<form class="inline" method="post" action="/admin/tenants/${esc(subject)}/profile-retry"><button type="submit">Retry now</button></form>`;
}
function backupForm(subject: string): string {
  return `<form class="inline" method="post" action="/admin/tenants/${esc(encodeURIComponent(subject))}/backup"><button type="submit">Backup now</button></form>`;
}

function suspendForm(subject: string): string {
  return `<form class="inline" method="post" action="/admin/tenants/${esc(encodeURIComponent(subject))}/suspend"><button type="submit">Suspend</button></form>`;
}
function resumeForm(subject: string): string {
  return `<form class="inline" method="post" action="/admin/tenants/${esc(encodeURIComponent(subject))}/resume"><button type="submit">Resume</button></form>`;
}
function deleteForm(subject: string): string {
  return `<form class="inline" method="post" action="/admin/tenants/${esc(encodeURIComponent(subject))}/delete" onsubmit="return confirm('Delete this tenant? This deletes the namespace.')"><button type="submit" class="danger">Delete</button></form>`;
}
