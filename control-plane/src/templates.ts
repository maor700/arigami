// Plain server-rendered HTML — no SPA, no build step, matches the task's
// "the user-facing bit, minimal" instruction. One shared shell + escape().
import type { Tenant } from './db.js';

export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function shell(title: string, body: string, tail = ''): string {
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
  .pending { color: #b26a00; font-weight: 600; }
  input { padding: 4px 6px; font-size: 12px; }
  .detail { color: #555; }
  .steps { list-style: none; padding: 0; margin: 24px 0; }
  .step { display: flex; align-items: center; gap: 10px; padding: 7px 0; color: #999; transition: color .3s; }
  .step-done, .step-active { color: #1a1a1a; }
  .step-failed { color: #b3261e; }
  .mark { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none; font-size: 12px; }
  .step-done .mark { color: #1e7a34; }
  .mark i { width: 11px; height: 11px; border: 2px solid #1a1a1a; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mark i { animation-duration: 2.4s; } }
  .meta { color: #999; font-size: 12px; font-variant-numeric: tabular-nums; }
</style></head><body>${body}${tail}</body></html>`;
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

export function adminPage(
  tenants: Tenant[],
  adminEmail: string,
  backups: Record<string, { count: number; newestMs: number | null }> = {},
): string {
  const rows = tenants
    .map((t) => {
      const b = backups[t.ns];
      const digest =
        t.desired_digest && t.desired_digest !== t.running_digest
          ? `${esc(t.running_digest || '—')} <span class="pending">→ ${esc(t.desired_digest)}</span>`
          : esc(t.running_digest || t.desired_digest || '—');
      return `<tr>
      <td>${esc(t.email)}</td>
      <td>${esc(t.ns)}</td>
      <td><span class="state state-${esc(t.state)}">${esc(t.state)}</span></td>
      <td>${esc(t.last_seen_at)}</td>
      <td>${digest}${t.state !== 'deleted' ? digestForm(t.subject) : ''}</td>
      <td>${b ? `${b.count}${b.newestMs ? ` <small>(${esc(new Date(b.newestMs).toISOString().slice(0, 16))}Z)</small>` : ''}` : '0'}
        ${t.state === 'running' ? backupForm(t.subject) : ''}</td>
      <td>
        ${t.state === 'running' ? suspendForm(t.subject) : ''}
        ${t.state === 'dormant' ? resumeForm(t.subject) : ''}
        ${t.state !== 'deleted' ? deleteForm(t.subject) : ''}
      </td>
    </tr>`;
    })
    .join('\n');
  return shell(
    'Tenants — Arigami admin',
    `<h1>Tenants</h1><p>Signed in as ${esc(adminEmail)} (org-admin). <a href="/workspace">Open my workspace</a> · <a href="/auth/logout">Sign out</a></p>
     <p><small>Image changes converge on the next reconcile tick, and only while the tenant has no
     turn in flight. Restores are an operator action: <code>bun src/cli.ts restore …</code>.</small></p>
     <table>
       <thead><tr><th>Email</th><th>Namespace</th><th>State</th><th>Last seen</th><th>Image (running → desired)</th><th>Backups</th><th>Actions</th></tr></thead>
       <tbody>${rows || '<tr><td colspan="7">No tenants yet.</td></tr>'}</tbody>
     </table>`,
  );
}

function digestForm(subject: string): string {
  return `<form class="inline" method="post" action="/admin/tenants/${esc(encodeURIComponent(subject))}/digest">
    <input name="digest" placeholder="tag or sha256:…" size="14"><button type="submit">Set</button></form>`;
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
  return `<form class="inline" method="post" action="/admin/tenants/${esc(encodeURIComponent(subject))}/delete" onsubmit="return confirm('Delete this tenant? This deletes the namespace.')"><button type="submit">Delete</button></form>`;
}
