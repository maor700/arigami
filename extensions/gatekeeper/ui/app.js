// The Permissions tab. A TRUSTED tab of a bundled extension: same origin as the cockpit, so it calls /__api as the
// signed-in person. Profiles and where they apply → /__api/session-profiles (admin only, enforced by the host); the
// gatekeeper's scope and identities → its admin tools (POST /__api/ext/gatekeeper/tool/gk_admin_*, admin person only).
// Values a person types are never echoed back: identities show only "set / not set".
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const S = { store: null, gk: null, folders: [], agents: [], triggers: [], sel: null, draft: null };

  // ---- tiny DOM helpers (no innerHTML with data) ----------------------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'value' || k === 'hidden' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const fill = (el, ...kids) => { el.replaceChildren(); for (const k of kids.flat()) if (k) el.append(k); };
  let toastT = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.hidden = true), 4000);
  }

  // ---- API ----------------------------------------------------------------------------------------------------------
  async function api(method, path, body) {
    const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  async function gk(tool, args) {
    const r = await api('POST', `/__api/ext/gatekeeper/tool/${tool}`, { args: args || {} });
    const blocks = Array.isArray(r.result) ? r.result : [];
    const text = blocks.map((b) => b.text || '').join('');
    let out;
    try { out = JSON.parse(text); } catch { out = { ok: false, error: text || 'no answer' }; }
    if (out && out.ok === false) throw new Error(out.error || 'failed');
    return out;
  }

  async function load() {
    const [store, gkState, folders, agents, triggers] = await Promise.all([
      api('GET', '/__api/session-profiles'),
      gk('gk_admin_state').catch((e) => ({ error: e.message })),
      api('GET', '/__api/folders').catch(() => []),
      api('GET', '/__api/agents').then((r) => r.agents || []).catch(() => []),
      api('GET', '/__api/triggers').catch(() => []),
    ]);
    S.store = store;
    S.gk = gkState;
    S.folders = Array.isArray(folders) ? folders : folders.folders || [];
    S.agents = agents;
    S.triggers = (Array.isArray(triggers) ? triggers : triggers.triggers || []).filter((t) => t.type === 'cron');
  }

  const allProfiles = () => ({ ...(S.store?.builtin || {}), ...(S.store?.profiles || {}) });
  const isBuiltin = (id) => !!S.store?.builtin?.[id] && !S.store?.profiles?.[id];
  async function saveStore(profiles, attach) {
    S.store = { ...S.store, ...(await api('PUT', '/__api/session-profiles', { profiles, attach })) };
  }

  // ---- Profiles -----------------------------------------------------------------------------------------------------
  const TOOL_CHOICES = [
    ['git', 'Bash, edit files, git (local only — no tokens)'],
    ['web', 'Web fetch / search'],
    ['publish', 'Publish artifacts'],
  ];
  const CHILD_TOOLS = ['task_session', 'send_message', 'list_sessions', 'delete_session', 'restart_session'];
  const GK_FAMILY = 'ext:gatekeeper';

  function draftOf(id) {
    const p = allProfiles()[id] || {};
    const tools = Array.isArray(p.tools) ? p.tools.slice() : [];
    // A built-in profile is edited as a copy under a new id.
    const builtin = isBuiltin(id);
    return {
      id: builtin ? `${id}-copy` : id,
      isNew: builtin,
      copyOf: builtin ? id : null,
      name: p.name || id,
      tools,
      desktop: p.desktop || 'none',
      talkTo: p.talkTo || ['parent', 'children'],
      maySpawn: !!p.maySpawn,
      triggers: !!p.triggers,
      hostRoutes: p.hostRoutes || [],
      domains: (p.domains || []).join(', '),
      grants: p.grants || [],
    };
  }

  function usageCount(id) {
    return Object.values(S.store?.attach || {}).filter((v) => v === id).length;
  }

  function renderProfiles() {
    const ids = Object.keys(allProfiles()).sort();
    const list = h('div', { class: 'list' },
      h('button', { class: 'item' + (S.sel === '__full' ? ' on' : ''), onclick: () => { S.sel = '__full'; S.draft = null; renderProfiles(); } }, 'Full', h('small', {}, 'default · as today')),
      ids.map((id) => h('button', { class: 'item' + (S.sel === id ? ' on' : ''), onclick: () => { S.sel = id; S.draft = draftOf(id); renderProfiles(); } },
        allProfiles()[id].name || id, h('small', {}, `${id}${isBuiltin(id) ? ' · built in' : ''}${usageCount(id) ? ` · attached ${usageCount(id)}×` : ''}`))),
      h('button', { class: 'item', onclick: () => { S.sel = '__new'; S.draft = { ...draftOf('__none'), id: '', name: '', isNew: true, tools: ['git'] }; renderProfiles(); } }, '+ New profile'),
    );
    let editor;
    if (S.sel === '__full') editor = h('div', { class: 'card' }, h('h2', {}, 'Full'), h('p', { class: 'muted' }, 'No restrictions: the session is started and served exactly as before this extension existed. It cannot be edited.'));
    else if (S.draft) editor = profileEditor(S.draft);
    else editor = h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Pick a profile, or create one.'));
    fill($('view-profiles'), h('div', { class: 'row' }, list, h('div', { class: 'col' }, editor)));
  }

  function check(label, on, set, extra) {
    return h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: !!on, onchange: (e) => set(e.target.checked) }), label, extra || null);
  }
  const toggleIn = (arr, v, on) => (on ? [...new Set([...arr, v])] : arr.filter((x) => x !== v));

  function profileEditor(d) {
    const ro = !!d.copyOf;
    const actions = (S.gk && S.gk.actions) || [];
    const byService = {};
    for (const a of actions) (byService[a.service] = byService[a.service] || []).push(a);
    const svcTitle = { slack: 'Slack', github: 'GitHub', linear: 'Linear', sentry: 'Sentry' };
    const children = CHILD_TOOLS.every((t) => d.tools.includes(t));
    const card = h('div', { class: 'card' },
      h('h2', {}, d.isNew ? (ro ? `Copy of ${d.copyOf}` : 'New profile') : d.name),
      ro ? h('p', { class: 'hint' }, 'Built in — it is saved as a copy under the id below.') : null,
      d.isNew ? h('label', {}, 'Id', h('input', { type: 'text', value: d.id, placeholder: 'fix-child', oninput: (e) => (d.id = e.target.value.trim()) })) : null,
      h('label', {}, 'Name', h('input', { type: 'text', value: d.name, oninput: (e) => (d.name = e.target.value) })),
      h('h3', {}, 'Tools'),
      TOOL_CHOICES.map(([v, label]) => check(label, d.tools.includes(v), (on) => (d.tools = toggleIn(d.tools, v, on)))),
      check('Manage its own children (task, message, list, delete, restart)', children, (on) => { for (const t of CHILD_TOOLS) d.tools = toggleIn(d.tools, t, on); }),
      h('p', { class: 'hint' }, 'Enforced by the host when the session starts and on every call. Read, search and the cockpit tools are always on.'),
      h('h3', {}, 'Desktop'),
      ['none', 'own', 'shared'].map((m) => h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'desk', checked: d.desktop === m, onchange: () => (d.desktop = m) }), { none: 'None', own: 'Own browser', shared: 'Shared (ask each time)' }[m])),
      h('h3', {}, 'Talk to'),
      check('Its parent', d.talkTo.includes('parent'), (on) => (d.talkTo = toggleIn(d.talkTo, 'parent', on))),
      check('Its children', d.talkTo.includes('children'), (on) => (d.talkTo = toggleIn(d.talkTo, 'children', on))),
      check('May start children (they inherit and can only narrow this profile)', d.maySpawn, (on) => (d.maySpawn = on)),
      check('May create cron jobs / listeners (only its own)', d.triggers, (on) => (d.triggers = on)),
      h('h3', {}, 'Host features'),
      (S.store?.hostRouteGroups || []).map((g) => check(g, d.hostRoutes.includes(g), (on) => (d.hostRoutes = toggleIn(d.hostRoutes, g, on)))),
      h('label', {}, 'Web / browser domains (comma separated; empty = none of its own)', h('input', { type: 'text', value: d.domains, oninput: (e) => (d.domains = e.target.value) })),
      h('h3', {}, 'Through the gatekeeper'),
      S.gk && S.gk.error ? h('p', { class: 'hint' }, `Gatekeeper unavailable: ${S.gk.error}`) : null,
      Object.entries(byService).map(([svc, acts]) => h('div', { class: 'svc' }, h('b', {}, svcTitle[svc] || svc), h('div', {},
        acts.map((a) => check(a.label, d.grants.includes(a.grant), (on) => (d.grants = toggleIn(d.grants, a.grant, on)), a.approval ? h('span', { class: 'pill warn' }, 'needs operator approval') : null))))),
      h('p', { class: 'hint' }, 'Approvers are checked in code against their Slack user id, never by the model (Connections).'),
    );
    const save = async () => {
      const id = d.id || '';
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return toast('Id: lowercase letters, digits and dashes');
      if (d.isNew && allProfiles()[id] && !isBuiltin(id)) return toast(`A profile "${id}" already exists`);
      let tools = d.tools.filter((t) => t !== GK_FAMILY);
      if (d.grants.length) tools.push(GK_FAMILY);
      const spec = { name: d.name || id, tools, desktop: d.desktop, talkTo: d.talkTo, maySpawn: d.maySpawn, triggers: d.triggers, hostRoutes: d.hostRoutes, grants: d.grants, domains: d.domains.split(',').map((x) => x.trim()).filter(Boolean) };
      if (!spec.domains.length) delete spec.domains;
      try {
        await saveStore({ ...(S.store.profiles || {}), [id]: spec }, S.store.attach || {});
        S.sel = id;
        S.draft = draftOf(id);
        toast('Saved');
        renderProfiles();
      } catch (e) { toast(e.message); }
    };
    const del = async () => {
      if (usageCount(d.id)) return toast('Detach it everywhere first (Where it applies)');
      const profiles = { ...(S.store.profiles || {}) };
      delete profiles[d.id];
      try { await saveStore(profiles, S.store.attach || {}); S.sel = null; S.draft = null; toast('Deleted'); renderProfiles(); } catch (e) { toast(e.message); }
    };
    card.append(h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: save }, 'Save'),
      !d.isNew && !isBuiltin(d.id) ? h('button', { class: 'btn danger', onclick: del }, 'Delete') : null));
    return card;
  }

  // ---- Where it applies -----------------------------------------------------------------------------------------------
  function profileSelect(value, onchange) {
    return h('select', { onchange: (e) => onchange(e.target.value) },
      h('option', { value: 'full', selected: !value || value === 'full' }, 'Full'),
      Object.keys(allProfiles()).sort().map((id) => h('option', { value: id, selected: value === id }, allProfiles()[id].name || id)));
  }
  async function attach(key, v) {
    const a = { ...(S.store.attach || {}) };
    if (v === 'full') delete a[key];
    else a[key] = v;
    try { await saveStore(S.store.profiles || {}, a); toast('Saved'); } catch (e) { toast(e.message); }
    renderAttach();
  }
  function attachRows(prefix, items, label) {
    if (!items.length) return h('p', { class: 'hint' }, 'none');
    return h('table', {}, h('tbody', {}, items.map((it) => {
      const key = `${prefix}:${it.id}`;
      const cur = S.store.attach?.[key];
      return h('tr', {}, h('td', { class: 'wrap' }, label(it)), h('td', {}, typeof cur === 'object' ? h('span', { class: 'pill' }, 'snapshot of its creator') : profileSelect(cur, (v) => attach(key, v))));
    })));
  }
  function renderAttach() {
    const ns = { title: '', profile: 'restricted', cwd: '' };
    fill($('view-attach'),
      h('div', { class: 'card' }, h('h2', {}, 'New session'),
        h('p', { class: 'hint' }, 'Start a session under a profile. Only an admin in the cockpit can choose it; the session cannot raise its own permissions.'),
        h('label', {}, 'Title', h('input', { type: 'text', oninput: (e) => (ns.title = e.target.value) })),
        h('label', {}, 'Working directory (optional)', h('input', { type: 'text', oninput: (e) => (ns.cwd = e.target.value) })),
        h('label', {}, 'Profile', profileSelect(ns.profile, (v) => (ns.profile = v))),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
          try {
            const s = await api('POST', '/__api/sessions', { title: ns.title || 'Restricted session', profile: ns.profile, ...(ns.cwd ? { cwd: ns.cwd } : {}) });
            toast(`Started ${s.title || s.id} (${s.profile ? s.profile.name : 'Full'})`);
          } catch (e) { toast(e.message); }
        } }, 'Start'))),
      h('div', { class: 'card' }, h('h2', {}, 'Project folders'), h('p', { class: 'hint' }, 'Every session created in the folder gets it; children inherit it and can only narrow it. Applies at creation.'),
        attachRows('folder', S.folders, (f) => f.name || f.id)),
      h('div', { class: 'card' }, h('h2', {}, 'Agents'), h('p', { class: 'hint' }, 'Every session born from the agent; the agent\'s own allowlist still applies on top.'),
        attachRows('agent', S.agents.map((a) => ({ ...a, id: a.slug })), (a) => `${a.emoji || ''} ${a.name || a.slug}`)),
      h('div', { class: 'card' }, h('h2', {}, 'Cron jobs'), h('p', { class: 'hint' }, 'Runs it fires start with this profile.'),
        attachRows('trigger', S.triggers, (t) => `${t.name || t.id} · ${t.schedule?.expr || t.schedule?.kind || ''}`)),
      h('div', { class: 'card' }, h('h2', {}, 'Listeners'), h('p', { class: 'hint' }, 'A listener wakes the session that armed it, which keeps its own profile — set the profile on that session (or its folder / agent / cron).')),
    );
  }

  // ---- Connections ---------------------------------------------------------------------------------------------------
  const IDS = {
    github: { title: 'GitHub App (one repo)', fields: [['appId', 'App id', 'text'], ['installationId', 'Installation id', 'text'], ['privateKey', 'Private key (PEM)', 'area']] },
    slack: { title: 'Slack bot (no chat:write.public, no im:write)', fields: [['botToken', 'Bot token', 'password']] },
    linear: { title: 'Linear', fields: [['apiKey', 'API key', 'password']] },
    sentry: { title: 'Sentry (no alert-rule write)', fields: [['token', 'Token', 'password'], ['alertsToken', 'Alert-rule identity — used only after an operator approval (optional)', 'password']] },
  };
  function renderConnections() {
    if (!S.gk || S.gk.error) return fill($('view-connections'), h('p', { class: 'hint' }, `Gatekeeper unavailable: ${S.gk && S.gk.error}`));
    const st = S.gk.identities || {};
    const cfg = JSON.parse(JSON.stringify(S.gk.config || {}));
    const idCards = Object.entries(IDS).map(([svc, def]) => {
      const vals = {};
      const set = def.fields.map(([k]) => st[svc]?.[k]);
      const all = set.every(Boolean);
      return h('div', { class: 'card' },
        h('h2', {}, def.title, ' ', h('span', { class: 'pill ' + (all ? 'ok' : set.some(Boolean) ? 'warn' : '') }, all ? 'set' : set.some(Boolean) ? 'partly set' : 'not set')),
        def.fields.map(([k, label, kind]) => h('label', {}, `${label} ${st[svc]?.[k] ? '(set — leave empty to keep)' : ''}`,
          kind === 'area' ? h('textarea', { oninput: (e) => (vals[k] = e.target.value) }) : h('input', { type: kind, autocomplete: 'off', oninput: (e) => (vals[k] = e.target.value) }))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: async () => { try { await gk('gk_admin_set_identity', { service: svc, values: vals }); await refresh('connections'); toast('Saved'); } catch (e) { toast(e.message); } } }, 'Save'),
          h('button', { class: 'btn', onclick: async () => { try { const r = await gk('gk_admin_test', { service: svc }); toast(`OK · ${JSON.stringify(r).slice(0, 160)}`); } catch (e) { toast(`Failed: ${e.message}`); } } }, 'Test'),
          h('button', { class: 'btn danger', onclick: async () => { try { await gk('gk_admin_clear_identity', { service: svc }); await refresh('connections'); } catch (e) { toast(e.message); } } }, 'Remove')));
    });
    const lines = (a) => (a || []).join('\n');
    const unlines = (s) => String(s || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    const field = (label, get, set, kind) => h('label', {}, label, kind === 'area'
      ? h('textarea', { value: get(), oninput: (e) => set(e.target.value) })
      : h('input', { type: kind || 'text', value: get() ?? '', oninput: (e) => set(e.target.value) }));
    const scope = h('div', { class: 'card' }, h('h2', {}, 'Scope and approvers'),
      h('h3', {}, 'GitHub'),
      field('Repository (owner/name)', () => cfg.github.repo, (v) => (cfg.github.repo = v.trim())),
      field('Protected branches (never pushed; one per line, * allowed)', () => lines(cfg.github.protectedBranches), (v) => (cfg.github.protectedBranches = unlines(v)), 'area'),
      field('Allowed branch pattern (regex, optional)', () => cfg.github.branchPattern || '', (v) => (cfg.github.branchPattern = v.trim() || null)),
      h('label', {}, 'Merge method', h('select', { onchange: (e) => (cfg.github.mergeMethod = e.target.value) }, ['squash', 'merge', 'rebase'].map((m) => h('option', { value: m, selected: cfg.github.mergeMethod === m }, m)))),
      check('Auto-merge rule: CI green + an approving review on the head commit', cfg.github.autoMerge.enabled, (on) => (cfg.github.autoMerge.enabled = on)),
      field('Required checks (empty = every check on the head)', () => lines(cfg.github.autoMerge.requiredChecks), (v) => (cfg.github.autoMerge.requiredChecks = unlines(v)), 'area'),
      field('Reviewers whose approval counts (GitHub logins; empty = anyone but the author)', () => lines(cfg.github.autoMerge.approvers), (v) => (cfg.github.autoMerge.approvers = unlines(v)), 'area'),
      h('h3', {}, 'Slack'),
      field('Incident channel id', () => cfg.slack.channel, (v) => (cfg.slack.channel = v.trim())),
      field('Approvers — "USERID name" per line (checked by user id)', () => (cfg.slack.operators || []).map((o) => `${o.id}${o.name ? ' ' + o.name : ''}`).join('\n'), (v) => (cfg.slack.operators = String(v).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [id, ...n] = l.split(/\s+/); return { id, name: n.join(' ') || undefined }; })), 'area'),
      field('Alert sources whose threads a session may bind to (user / bot / app ids)', () => lines(cfg.slack.threadOpeners), (v) => (cfg.slack.threadOpeners = unlines(v)), 'area'),
      check('A session may bind itself to such a thread once', cfg.slack.bindOnFirstUse, (on) => (cfg.slack.bindOnFirstUse = on)),
      h('h3', {}, 'Linear'),
      field('Team id', () => cfg.linear.teamId, (v) => (cfg.linear.teamId = v.trim())),
      field('Project id (optional)', () => cfg.linear.projectId || '', (v) => (cfg.linear.projectId = v.trim() || null)),
      h('h3', {}, 'Sentry'),
      field('API base URL (region)', () => cfg.sentry.baseUrl, (v) => (cfg.sentry.baseUrl = v.trim())),
      field('Organization slug', () => cfg.sentry.org, (v) => (cfg.sentry.org = v.trim())),
      field('Project slug', () => cfg.sentry.project, (v) => (cfg.sentry.project = v.trim())),
      field('Alert rules the gatekeeper manages (ids)', () => lines(cfg.sentry.alertRules), (v) => (cfg.sentry.alertRules = unlines(v)), 'area'),
      h('h3', {}, 'Approvals'),
      field('An operator\'s word is valid for (minutes)', () => cfg.approvals.maxAgeMin, (v) => (cfg.approvals.maxAgeMin = Number(v)), 'number'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => { try { await gk('gk_admin_save_config', { config: cfg }); await refresh('connections'); toast('Saved'); } catch (e) { toast(e.message); } } }, 'Save scope')));
    fill($('view-connections'), h('p', { class: 'muted' }, `Logins are added once here. Only the gatekeeper holds them (${S.gk.dir}); sessions never see them.`), idCards, scope);
  }

  // ---- Activity ------------------------------------------------------------------------------------------------------
  async function renderActivity() {
    let entries = [];
    try { entries = (await gk('gk_admin_audit', { limit: 300 })).entries || []; } catch (e) { toast(e.message); }
    const pill = (d) => h('span', { class: 'pill ' + ({ allowed: 'ok', refused: 'bad', failed: 'warn' }[d] || '') }, { allowed: 'Done', refused: 'Blocked', failed: 'Failed', config: 'Config' }[d] || d);
    const bindings = (S.gk && S.gk.bindings) || {};
    const nb = { session: '', channel: '', thread_ts: '' };
    fill($('view-activity'),
      h('div', { class: 'card' }, h('h2', {}, 'Incident threads'),
        Object.keys(bindings).length ? h('table', {}, h('tbody', {}, Object.entries(bindings).map(([sid, b]) => h('tr', {}, h('td', {}, sid), h('td', {}, `${b.channel} / ${b.thread_ts}`), h('td', {}, b.by), h('td', {}, h('button', { class: 'btn danger', onclick: async () => { try { await gk('gk_admin_bind', { session: sid, clear: true }); await refresh('activity'); } catch (e) { toast(e.message); } } }, 'Unbind')))))) : h('p', { class: 'hint' }, 'none'),
        h('div', { class: 'row' },
          h('div', { class: 'col' }, h('label', {}, 'Session id', h('input', { type: 'text', oninput: (e) => (nb.session = e.target.value.trim()) }))),
          h('div', { class: 'col' }, h('label', {}, 'Channel id', h('input', { type: 'text', oninput: (e) => (nb.channel = e.target.value.trim()) }))),
          h('div', { class: 'col' }, h('label', {}, 'Thread ts', h('input', { type: 'text', oninput: (e) => (nb.thread_ts = e.target.value.trim()) })))),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { try { await gk('gk_admin_bind', nb); await refresh('activity'); toast('Bound'); } catch (e) { toast(e.message); } } }, 'Bind'))),
      h('div', { class: 'card' }, h('h2', {}, 'Decisions'),
        entries.length ? h('table', {}, h('thead', {}, h('tr', {}, ['When', '', 'Session', 'What', 'Detail'].map((x) => h('th', {}, x)))),
          h('tbody', {}, entries.map((e) => h('tr', {},
            h('td', {}, String(e.ts || '').replace('T', ' ').slice(0, 19)),
            h('td', {}, pill(e.decision)),
            h('td', { class: 'wrap' }, `${e.session || ''}${e.profile ? ` (${e.profile})` : ''}`),
            h('td', { class: 'wrap' }, `${e.tool || ''}${e.target ? ` · ${e.target}` : ''}`),
            h('td', { class: 'wrap' }, e.reason || (e.approval ? `approved: ${e.approval.kind === 'operator' ? `${e.approval.approverName || e.approval.approver} in the thread` : 'auto-rule'}` : '') || (e.result ? JSON.stringify(e.result) : '')))))) : h('p', { class: 'hint' }, 'No decisions yet.')),
    );
  }

  // ---- shell ---------------------------------------------------------------------------------------------------------
  const RENDER = { profiles: renderProfiles, attach: renderAttach, connections: renderConnections, activity: renderActivity };
  let view = 'profiles';
  async function refresh(v) {
    await load();
    view = v || view;
    RENDER[view]();
  }
  $('nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    view = b.dataset.view;
    for (const x of $('nav').querySelectorAll('button')) x.classList.toggle('on', x === b);
    for (const k of Object.keys(RENDER)) $('view-' + k).hidden = k !== view;
    RENDER[view]();
  });
  const theme = (c) => {
    document.documentElement.dataset.theme = (c && c.theme) || 'dark';
    if (c && c.lang) document.documentElement.lang = c.lang;
  };
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'arigami:init') theme(e.data.context); });
  (async () => {
    try { if (window.arigami) theme(await window.arigami.ready()); } catch { /* standalone */ }
    try { await refresh('profiles'); } catch (e) { fill($('view-profiles'), h('p', { class: 'hint' }, `Could not load: ${e.message}. This tab needs a signed-in admin.`)); }
  })();
})();
