// The Permissions tab. A TRUSTED tab of a bundled extension: same origin as the cockpit, so it calls /__api as the
// signed-in person. Profiles and where they apply → /__api/session-profiles (admin only, enforced by the host); the
// gatekeeper's scope and identities → its admin tools (POST /__api/ext/gatekeeper/tool/gk_admin_*, admin person only).
// Values a person types are never echoed back: identities show only "set / not set".
//
// Look and feel: Arigami's own tokens. Being same-origin, the page reads the cockpit's LIVE values (data-theme, the
// accent, the UI size, dir/lang, the font faces) from the parent document and follows every change; the
// `arigami:init` theme is the fallback when there is no readable parent.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const S = { store: null, gk: null, folders: [], agents: [], triggers: [], sel: null, draft: null };

  // ---- inherit the host app's look ------------------------------------------------------------------------------------
  const TOKENS = [
    '--hb-bg', '--hb-panel', '--hb-hover', '--hb-sel2', '--hb-fg', '--hb-fg2', '--hb-fgdim', '--hb-faint', '--hb-hair', '--hb-border', '--hb-sel',
    '--hb-ok', '--hb-warn', '--hb-err', '--color-brand', '--on-accent', '--ring', '--elev-card', '--elev-pop', '--font-sans', '--font-mono', '--ui-scale',
  ];
  const hostDoc = () => { try { return window.parent !== window && window.parent.document ? window.parent.document : null; } catch { return null; } };
  function syncFromHost() {
    const pd = hostDoc();
    if (!pd) return false;
    const src = pd.documentElement;
    const me = document.documentElement;
    const theme = src.getAttribute('data-theme') || (window.parent.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    me.dataset.theme = theme;
    me.dir = src.dir || 'ltr';
    me.lang = src.lang || 'en';
    // Values computed in the host (an accent pref, a UI size) beat our fallbacks; set after data-theme so they win.
    const cs = window.parent.getComputedStyle(src);
    for (const t of TOKENS) {
      const v = cs.getPropertyValue(t).trim();
      if (v) me.style.setProperty(t, v);
      else me.style.removeProperty(t);
    }
    return true;
  }
  function copyFonts() {
    const pd = hostDoc();
    if (!pd) return;
    const rules = [];
    for (const sheet of pd.styleSheets) {
      let list;
      try { list = sheet.cssRules; } catch { continue; }
      for (const r of list || []) if (r.type === CSSRule.FONT_FACE_RULE) rules.push(r.cssText);
    }
    if (!rules.length) return;
    const st = document.createElement('style');
    st.textContent = rules.join('\n');
    document.head.append(st);
  }
  function followHost() {
    if (!syncFromHost()) return;
    copyFonts();
    const pd = hostDoc();
    new MutationObserver(syncFromHost).observe(pd.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'dir', 'lang', 'class'] });
    try { window.parent.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncFromHost); } catch { /* old engines */ }
  }
  const fromInit = (c) => {
    if (syncFromHost()) return;
    document.documentElement.dataset.theme = (c && c.theme) || 'dark';
    if (c && c.lang) document.documentElement.lang = c.lang;
  };

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
  const card = (title, { end, foot, body } = {}) =>
    h('div', { class: 'card' },
      title !== null ? h('div', { class: 'card-head' }, h('h2', {}, title), end ? h('div', { class: 'end' }, end) : null) : null,
      h('div', { class: 'card-body' }, body),
      foot ? h('div', { class: 'card-foot' }, foot) : null);
  const group = (title, ...kids) => h('div', { class: 'group' }, title ? h('div', { class: 'group-title' }, title) : null, ...kids);
  const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
  const input = (attrs) => h('input', { class: 'input', type: 'text', ...attrs });
  const opt = (label, on, set, extra, type = 'checkbox') =>
    h('label', { class: 'opt' }, h('input', { type, checked: !!on, onchange: (e) => set(e.target.checked) }), h('span', { class: 'label' }, label), extra || null);
  const opts = (...rows) => h('div', { class: 'opts' }, ...rows);
  const badge = (text, tone) => h('span', { class: 'badge' + (tone ? ' ' + tone : '') }, text);
  const btn = (label, onclick, kind = '') => h('button', { type: 'button', class: 'btn ' + kind, onclick }, label);
  const seg = (choices, value, set) =>
    h('div', { class: 'seg', role: 'group' }, choices.map(([v, label]) => h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: (e) => {
      set(v);
      for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
    } }, label)));

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
  const SVC_TITLE = { slack: 'Slack', github: 'GitHub', linear: 'Linear', sentry: 'Sentry' };

  function draftOf(id) {
    const p = allProfiles()[id] || {};
    // A built-in profile is edited as a copy under a new id.
    const builtin = isBuiltin(id);
    return {
      id: builtin ? `${id}-copy` : id,
      isNew: builtin,
      copyOf: builtin ? id : null,
      name: p.name || id,
      tools: Array.isArray(p.tools) ? p.tools.slice() : [],
      desktop: p.desktop || 'none',
      talkTo: p.talkTo || ['parent', 'children'],
      maySpawn: !!p.maySpawn,
      triggers: p.triggers === true ? true : p.triggers === 'own-thread' ? 'own-thread' : false,
      hostRoutes: p.hostRoutes || [],
      domains: (p.domains || []).join(', '),
      grants: p.grants || [],
      // Not edited in this tab (yet), but kept: the sandbox egress and the host-side caps (docs/SANDBOX.md).
      egress: Array.isArray(p.egress) ? p.egress.slice() : undefined,
      limits: p.limits && typeof p.limits === 'object' ? { ...p.limits } : undefined,
    };
  }
  const usageCount = (id) => Object.values(S.store?.attach || {}).filter((v) => v === id).length;
  const select = (id, draft) => { S.sel = id; S.draft = draft; renderProfiles(); };

  function renderProfiles() {
    const ids = Object.keys(allProfiles()).sort();
    const item = (key, name, meta, onclick) => h('button', { type: 'button', class: 'item', 'aria-current': String(S.sel === key), onclick }, h('span', { class: 'name' }, name), meta ? h('span', { class: 'meta' }, meta) : null);
    const list = h('nav', { class: 'list' },
      item('__full', 'Full', 'Default · as today', () => select('__full', null)),
      ids.map((id) => item(id, allProfiles()[id].name || id, [id, isBuiltin(id) ? 'built in' : '', usageCount(id) ? `attached ${usageCount(id)}×` : ''].filter(Boolean).join(' · '), () => select(id, draftOf(id)))),
      h('button', { type: 'button', class: 'item add', onclick: () => select('__new', { ...draftOf('__none'), id: '', name: '', isNew: true, tools: ['git'] }) }, '+ New profile'),
    );
    let editor;
    if (S.sel === '__full') editor = card('Full', { body: h('p', { class: 'dim', style: 'margin:0' }, 'No restrictions: the session is started and served exactly as before this extension existed. It cannot be edited.') });
    else if (S.draft) editor = profileEditor(S.draft);
    else editor = h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Pick a profile, or create one.'));
    fill($('view-profiles'), h('div', { class: 'split' }, list, editor));
  }

  const toggleIn = (arr, v, on) => (on ? [...new Set([...arr, v])] : arr.filter((x) => x !== v));

  function profileEditor(d) {
    const ro = !!d.copyOf;
    const byService = {};
    for (const a of (S.gk && S.gk.actions) || []) (byService[a.service] = byService[a.service] || []).push(a);
    const children = CHILD_TOOLS.every((t) => d.tools.includes(t));

    const save = async () => {
      const id = d.id || '';
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return toast('Id: lowercase letters, digits and dashes');
      if (d.isNew && allProfiles()[id] && !isBuiltin(id)) return toast(`A profile "${id}" already exists`);
      const tools = d.tools.filter((t) => t !== GK_FAMILY);
      if (d.grants.length) tools.push(GK_FAMILY);
      const spec = { name: d.name || id, tools, desktop: d.desktop, talkTo: d.talkTo, maySpawn: d.maySpawn, triggers: d.triggers, hostRoutes: d.hostRoutes, grants: d.grants, domains: d.domains.split(',').map((x) => x.trim()).filter(Boolean), ...(d.egress ? { egress: d.egress } : {}), ...(d.limits ? { limits: d.limits } : {}) };
      if (!spec.domains.length) delete spec.domains;
      try {
        await saveStore({ ...(S.store.profiles || {}), [id]: spec }, S.store.attach || {});
        toast('Saved');
        select(id, draftOf(id));
      } catch (e) { toast(e.message); }
    };
    const del = async () => {
      if (usageCount(d.id)) return toast('Detach it everywhere first (Where it applies)');
      const profiles = { ...(S.store.profiles || {}) };
      delete profiles[d.id];
      try { await saveStore(profiles, S.store.attach || {}); toast('Deleted'); select(null, null); } catch (e) { toast(e.message); }
    };

    return card(d.isNew ? (ro ? `Copy of ${d.copyOf}` : 'New profile') : d.name, {
      end: !d.isNew ? badge(d.id, 'plain') : null,
      foot: [!d.isNew && !isBuiltin(d.id) ? btn('Delete', del, 'ghost danger') : null, btn('Save', save, 'primary')],
      body: [
        ro ? h('p', { class: 'hint', style: 'margin:0 0 .75rem' }, 'Built in — it is saved as a copy under the id below.') : null,
        h('div', { class: 'grid2' },
          d.isNew ? field('Id', input({ value: d.id, placeholder: 'fix-child', oninput: (e) => (d.id = e.target.value.trim()) })) : null,
          field('Name', input({ value: d.name, oninput: (e) => (d.name = e.target.value) }))),
        group('Tools',
          opts(
            TOOL_CHOICES.map(([v, label]) => opt(label, d.tools.includes(v), (on) => (d.tools = toggleIn(d.tools, v, on)))),
            opt('Manage its own children (task, message, list, delete, restart)', children, (on) => { for (const t of CHILD_TOOLS) d.tools = toggleIn(d.tools, t, on); })),
          h('p', { class: 'hint' }, 'Enforced by the host when the session starts and on every call. Read, search and the cockpit tools are always on.')),
        group('Desktop', seg([['none', 'None'], ['own', 'Own browser'], ['shared', 'Shared · ask each time']], d.desktop, (v) => (d.desktop = v))),
        group('Talk to',
          opts(
            opt('Its parent', d.talkTo.includes('parent'), (on) => (d.talkTo = toggleIn(d.talkTo, 'parent', on))),
            opt('Its children', d.talkTo.includes('children'), (on) => (d.talkTo = toggleIn(d.talkTo, 'children', on))),
            opt('May start children — they inherit and can only narrow this profile', d.maySpawn, (on) => (d.maySpawn = on)),
          )),
        group('Wake-ups',
          seg([[false, 'None'], ['own-thread', 'Listener on its own thread'], [true, 'Cron + listeners']], d.triggers, (v) => (d.triggers = v)),
          h('p', { class: 'hint' }, 'Own thread: one Slack listener on the session\'s incident thread, waking only itself and ending with it. Cron stays off.')),
        group('Host features',
          opts((S.store?.hostRouteGroups || []).map((g) => opt(g, d.hostRoutes.includes(g), (on) => (d.hostRoutes = toggleIn(d.hostRoutes, g, on))))),
          h('div', { style: 'margin-top:.5rem' }, field('Web and browser domains (comma separated)', input({ value: d.domains, placeholder: 'example.com, docs.example.com', oninput: (e) => (d.domains = e.target.value) })))),
        group('Through the gatekeeper',
          S.gk && S.gk.error ? h('p', { class: 'hint' }, `Gatekeeper unavailable: ${S.gk.error}`) : null,
          h('div', { class: 'stack' }, Object.entries(byService).map(([svc, acts]) => h('div', { class: 'opts' },
            h('div', { class: 'svc-name' }, SVC_TITLE[svc] || svc),
            acts.map((a) => opt(a.label, d.grants.includes(a.grant), (on) => (d.grants = toggleIn(d.grants, a.grant, on)), a.approval ? badge('Needs approval', 'warn') : null))))),
          h('p', { class: 'hint' }, 'Approvers are checked in code against their Slack user id, never by the model (Connections).')),
      ],
    });
  }

  // ---- Where it applies -----------------------------------------------------------------------------------------------
  function profileSelect(value, onchange) {
    return h('select', { class: 'input', onchange: (e) => onchange(e.target.value) },
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
    if (!items.length) return h('div', { class: 'empty' }, 'None yet');
    return h('div', { class: 'rows' }, items.map((it) => {
      const key = `${prefix}:${it.id}`;
      const cur = S.store.attach?.[key];
      return h('div', { class: 'rowline' }, h('span', { class: 'label' }, label(it)), typeof cur === 'object' ? badge('Snapshot of its creator') : profileSelect(cur, (v) => attach(key, v)));
    }));
  }
  function renderAttach() {
    const ns = { title: '', profile: 'restricted', cwd: '' };
    const start = async () => {
      try {
        const s = await api('POST', '/__api/sessions', { title: ns.title || 'Restricted session', profile: ns.profile, ...(ns.cwd ? { cwd: ns.cwd } : {}) });
        toast(`Started ${s.title || s.id} (${s.profile ? s.profile.name : 'Full'})`);
      } catch (e) { toast(e.message); }
    };
    fill($('view-attach'), h('div', { class: 'stack' },
      card('New session', {
        foot: btn('Start session', start, 'primary'),
        body: [
          h('p', { class: 'hint', style: 'margin:0 0 .75rem' }, 'Only an admin in the cockpit chooses a profile; the session cannot raise its own permissions.'),
          h('div', { class: 'grid2' },
            field('Title', input({ placeholder: 'Restricted session', oninput: (e) => (ns.title = e.target.value) })),
            field('Profile', profileSelect(ns.profile, (v) => (ns.profile = v))),
            field('Working directory (optional)', input({ class: 'input mono', dir: 'ltr', oninput: (e) => (ns.cwd = e.target.value) }))),
        ],
      }),
      card('Project folders', { body: [h('p', { class: 'hint', style: 'margin:0 0 .5rem' }, 'Every session created in the folder gets it; children inherit it and can only narrow it. Applies at creation.'), attachRows('folder', S.folders, (f) => f.name || f.id)] }),
      card('Agents', { body: [h('p', { class: 'hint', style: 'margin:0 0 .5rem' }, 'Every session born from the agent; the agent\'s own allowlist still applies on top.'), attachRows('agent', S.agents.map((a) => ({ ...a, id: a.slug })), (a) => `${a.emoji || ''} ${a.name || a.slug}`.trim())] }),
      card('Cron jobs', { body: [h('p', { class: 'hint', style: 'margin:0 0 .5rem' }, 'Runs it fires start with this profile.'), attachRows('trigger', S.triggers, (t) => `${t.name || t.id} · ${t.schedule?.expr || t.schedule?.kind || ''}`)] }),
      card('Listeners', { body: h('p', { class: 'dim', style: 'margin:0' }, 'A listener wakes the session that armed it, which keeps its own profile — set the profile on that session, its folder, agent or cron job.') }),
    ));
  }

  // ---- Connections ---------------------------------------------------------------------------------------------------
  const IDS = {
    github: { title: 'GitHub App', sub: 'Installed on one repository', fields: [['appId', 'App id', 'text'], ['installationId', 'Installation id', 'text'], ['privateKey', 'Private key (PEM)', 'area']] },
    slack: { title: 'Slack bot', sub: 'Without chat:write.public and im:write', fields: [['botToken', 'Bot token', 'password']] },
    linear: { title: 'Linear', sub: 'Team-scoped by the gatekeeper', fields: [['apiKey', 'API key', 'password']] },
    sentry: { title: 'Sentry', sub: 'Without alert-rule write', fields: [['token', 'Token', 'password'], ['alertsToken', 'Alert-rule identity — used only after an operator approval (optional)', 'password']] },
  };
  function renderConnections() {
    if (!S.gk || S.gk.error) return fill($('view-connections'), h('div', { class: 'card' }, h('div', { class: 'empty' }, `Gatekeeper unavailable: ${S.gk && S.gk.error}`)));
    const st = S.gk.identities || {};
    const cfg = JSON.parse(JSON.stringify(S.gk.config || {}));
    const idCards = Object.entries(IDS).map(([svc, def]) => {
      const vals = {};
      const set = def.fields.map(([k]) => st[svc]?.[k]);
      const all = set.every(Boolean);
      const some = set.some(Boolean);
      return card(def.title, {
        end: badge(all ? 'Connected' : some ? 'Partly set' : 'Not set', all ? 'ok' : some ? 'warn' : ''),
        foot: [
          some ? btn('Remove', async () => { try { await gk('gk_admin_clear_identity', { service: svc }); await refresh('connections'); } catch (e) { toast(e.message); } }, 'ghost danger') : null,
          btn('Test', async () => { try { const r = await gk('gk_admin_test', { service: svc }); toast(`OK · ${JSON.stringify(r).slice(0, 160)}`); } catch (e) { toast(`Failed: ${e.message}`); } }),
          btn('Save', async () => { try { await gk('gk_admin_set_identity', { service: svc, values: vals }); await refresh('connections'); toast('Saved'); } catch (e) { toast(e.message); } }),
        ],
        body: [
          h('p', { class: 'hint', style: 'margin:0 0 .5rem' }, def.sub),
          h('div', { class: 'stack' }, def.fields.map(([k, label, kind]) => field(`${label}${st[svc]?.[k] ? ' · set, leave empty to keep' : ''}`,
            kind === 'area' ? h('textarea', { class: 'input', dir: 'ltr', autocomplete: 'off', oninput: (e) => (vals[k] = e.target.value) }) : input({ type: kind, dir: 'ltr', autocomplete: 'off', oninput: (e) => (vals[k] = e.target.value) })))),
        ],
      });
    });
    const lines = (a) => (a || []).join('\n');
    const unlines = (s) => String(s || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    const text = (label, get, set, extra = {}) => field(label, input({ value: get() ?? '', dir: 'ltr', oninput: (e) => set(e.target.value), ...extra }));
    const area = (label, get, set) => field(label, h('textarea', { class: 'input', dir: 'ltr', value: get(), oninput: (e) => set(e.target.value) }));
    const saveScope = async () => { try { await gk('gk_admin_save_config', { config: cfg }); await refresh('connections'); toast('Saved'); } catch (e) { toast(e.message); } };
    const scope = card('Scope and approvers', {
      foot: btn('Save scope', saveScope, 'primary'),
      body: [
        group('GitHub', h('div', { class: 'grid2' },
          text('Repository (owner/name)', () => cfg.github.repo, (v) => (cfg.github.repo = v.trim())),
          field('Merge method', h('select', { class: 'input', onchange: (e) => (cfg.github.mergeMethod = e.target.value) }, ['squash', 'merge', 'rebase'].map((m) => h('option', { value: m, selected: cfg.github.mergeMethod === m }, m)))),
          area('Protected branches — never pushed (one per line, * allowed)', () => lines(cfg.github.protectedBranches), (v) => (cfg.github.protectedBranches = unlines(v))),
          text('Allowed branch pattern (regex, optional)', () => cfg.github.branchPattern || '', (v) => (cfg.github.branchPattern = v.trim() || null))),
          h('div', { style: 'margin-top:.5rem' }, opts(opt('Auto-merge: CI green + an approving review on the head commit', cfg.github.autoMerge.enabled, (on) => (cfg.github.autoMerge.enabled = on)))),
          h('div', { class: 'grid2', style: 'margin-top:.5rem' },
            area('Required checks (empty = every check on the head)', () => lines(cfg.github.autoMerge.requiredChecks), (v) => (cfg.github.autoMerge.requiredChecks = unlines(v))),
            area('Reviewers whose approval counts (empty = anyone but the author)', () => lines(cfg.github.autoMerge.approvers), (v) => (cfg.github.autoMerge.approvers = unlines(v))))),
        group('Slack', h('div', { class: 'grid2' },
          text('Incident channel id', () => cfg.slack.channel, (v) => (cfg.slack.channel = v.trim()), { placeholder: 'C…' }),
          area('Approvers — "USERID name" per line, checked by user id', () => (cfg.slack.operators || []).map((o) => `${o.id}${o.name ? ' ' + o.name : ''}`).join('\n'), (v) => (cfg.slack.operators = String(v).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [id, ...n] = l.split(/\s+/); return { id, name: n.join(' ') || undefined }; }))),
          area('Alert sources whose threads a session may bind to (user / bot / app ids)', () => lines(cfg.slack.threadOpeners), (v) => (cfg.slack.threadOpeners = unlines(v)))),
          h('div', { style: 'margin-top:.5rem' }, opts(opt('A session may bind itself to such a thread, once', cfg.slack.bindOnFirstUse, (on) => (cfg.slack.bindOnFirstUse = on))))),
        group('Linear', h('div', { class: 'grid2' },
          text('Team id', () => cfg.linear.teamId, (v) => (cfg.linear.teamId = v.trim())),
          text('Project id (optional)', () => cfg.linear.projectId || '', (v) => (cfg.linear.projectId = v.trim() || null)))),
        group('Sentry', h('div', { class: 'grid2' },
          text('API base URL (region)', () => cfg.sentry.baseUrl, (v) => (cfg.sentry.baseUrl = v.trim())),
          text('Organization slug', () => cfg.sentry.org, (v) => (cfg.sentry.org = v.trim())),
          text('Project slug', () => cfg.sentry.project, (v) => (cfg.sentry.project = v.trim())),
          area('Alert rules the gatekeeper manages (ids)', () => lines(cfg.sentry.alertRules), (v) => (cfg.sentry.alertRules = unlines(v))))),
        group('Approvals', h('div', { class: 'grid2' },
          text('An operator\'s word is valid for (minutes)', () => cfg.approvals.maxAgeMin, (v) => (cfg.approvals.maxAgeMin = Number(v)), { type: 'number', min: '1' }))),
      ],
    });
    fill($('view-connections'), h('div', { class: 'stack' },
      h('p', { class: 'hint', style: 'margin:0' }, 'Logins are added once here. Only the gatekeeper holds them; sessions never see them. ', h('span', { class: 'mono', dir: 'ltr' }, S.gk.dir)),
      h('div', { class: 'grid2' }, idCards),
      scope));
  }

  // ---- Activity ------------------------------------------------------------------------------------------------------
  const DECISION = { allowed: ['Done', 'ok'], refused: ['Blocked', 'err'], failed: ['Failed', 'warn'], config: ['Config', ''] };
  async function renderActivity() {
    let entries = [];
    try { entries = (await gk('gk_admin_audit', { limit: 300 })).entries || []; } catch (e) { toast(e.message); }
    const bindings = (S.gk && S.gk.bindings) || {};
    const nb = { session: '', channel: '', thread_ts: '' };
    const detail = (e) => e.reason || (e.approval ? `Approved by ${e.approval.kind === 'operator' ? `${e.approval.approverName || e.approval.approver} in the thread` : 'the auto-rule'}` : '') || (e.result ? JSON.stringify(e.result) : '');
    fill($('view-activity'), h('div', { class: 'stack' },
      card('Incident threads', {
        foot: btn('Bind', async () => {
          try {
            await gk('gk_admin_bind', nb);
            // the host's own record of the session's thread (its triggers:'own-thread' listener may watch only this one)
            await api('PATCH', `/__api/sessions/${encodeURIComponent(nb.session)}`, { metadata: { origin: { kind: 'slack', channel: nb.channel, thread_ts: nb.thread_ts } } }).catch(() => {});
            await refresh('activity');
            toast('Bound');
          } catch (e) { toast(e.message); }
        }),
        body: [
          Object.keys(bindings).length
            ? h('div', { class: 'rows' }, Object.entries(bindings).map(([sid, b]) => h('div', { class: 'rowline' },
              h('span', { class: 'label mono', dir: 'ltr' }, `${sid} → ${b.channel} / ${b.thread_ts}`), badge(b.by === 'admin' ? 'By admin' : 'Self-bound'),
              btn('Unbind', async () => { try { await gk('gk_admin_bind', { session: sid, clear: true }); await refresh('activity'); } catch (e) { toast(e.message); } }, 'sm ghost danger'))))
            : h('div', { class: 'empty' }, 'No session is bound to a thread yet'),
          h('div', { class: 'grid2', style: 'margin-top:.75rem' },
            field('Session id', input({ dir: 'ltr', oninput: (e) => (nb.session = e.target.value.trim()) })),
            field('Channel id', input({ dir: 'ltr', oninput: (e) => (nb.channel = e.target.value.trim()) })),
            field('Thread ts', input({ dir: 'ltr', oninput: (e) => (nb.thread_ts = e.target.value.trim()) }))),
        ],
      }),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Decisions'), h('div', { class: 'end' }, btn('Refresh', () => renderActivity(), 'sm ghost'))),
        entries.length
          ? h('table', { class: 'table' },
            h('thead', {}, h('tr', {}, ['When', '', 'Session', 'Action', 'Detail'].map((x) => h('th', {}, x)))),
            h('tbody', {}, entries.map((e) => h('tr', {},
              h('td', { class: 'when' }, String(e.ts || '').replace('T', ' ').slice(5, 19)),
              h('td', {}, badge(...(DECISION[e.decision] || [e.decision, '']))),
              h('td', { class: 'mono', dir: 'ltr' }, `${e.session || '—'}${e.profile ? ` · ${e.profile}` : ''}`),
              h('td', { class: 'mono', dir: 'ltr' }, `${e.tool || ''}${e.target ? ` · ${e.target}` : ''}`),
              h('td', { class: 'full dim' }, detail(e))))))
          : h('div', { class: 'empty' }, 'No decisions yet')),
    ));
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
    for (const x of $('nav').querySelectorAll('button')) x.setAttribute('aria-selected', String(x === b));
    for (const k of Object.keys(RENDER)) $('view-' + k).hidden = k !== view;
    RENDER[view]();
  });
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'arigami:init') fromInit(e.data.context); });
  followHost();
  (async () => {
    try { if (window.arigami) fromInit(await window.arigami.ready()); } catch { /* standalone */ }
    try { await refresh('profiles'); } catch (e) { fill($('view-profiles'), h('div', { class: 'card' }, h('div', { class: 'empty' }, `Could not load: ${e.message}. This tab needs a signed-in admin.`))); }
  })();
})();
