#!/usr/bin/env bun
// arigami MCP server (stdio). Every tool is a thin fetch() to the host's
// REST API. Session scoping: explicit session_id arg wins, else the
// ARIGAMI_SESSION_ID env injected by the host when it spawned this claude.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// INTERNAL base for host→self fetches only. NEVER put HOST into a value the
// agent might echo to a human — results carry host-relative paths instead
// (they resolve against whatever origin the human used; see
// server/lib/public-url.ts). Guarded by test/no-localhost-urls.test.js.
const HOST = process.env.ARIGAMI_URL || 'http://127.0.0.1:3099';
// Where the cockpit lives on any origin; the human's browser resolves it.
const PUBLIC_PATH = (process.env.ARIGAMI_PUBLIC_PATH || '/__host/').replace(/\/+$/, '') + '/';
// C1: the host injects a per-session bearer token (ARIGAMI_TOKEN) into every
// claude it spawns; without it every /__api call is a 401 once auth is on.
const TOKEN = process.env.ARIGAMI_TOKEN || '';

async function api(method, path, body, headers = {}) {
  const res = await fetch(HOST + path, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json.error || `${res.status} ${text.slice(0, 300)}`);
  return json;
}

function sid(args) {
  const id = args?.session_id || process.env.ARIGAMI_SESSION_ID;
  if (!id) throw new Error('no session: pass session_id or run inside a host session (ARIGAMI_SESSION_ID)');
  return id;
}

// Session mutations (PATCH /__api/sessions/:id) return the FULL updated session
// — which carries a large `capabilities` blob. The agent doesn't need it echoed
// back, and stringifying it into every set_*/progress call silently burns tens of
// thousands of context tokens per call. Ack compactly instead.
const patchSession = async (a, body) => {
  await api('PATCH', `/__api/sessions/${sid(a)}`, body);
  return { ok: true };
};

const SID_PROP = { session_id: { type: 'string', description: 'Host session id (defaults to ARIGAMI_SESSION_ID env)' } };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: 'create_session',
    description:
      'Create a new host session (spawns a claude process in cwd). Returns {id, url} — `url` is a host-RELATIVE path ' +
      '(/__host/?session=<id>) that works from any device; show it as-is, never prefix it with http://localhost.\n' +
      'DISPATCH (orchestration): pass `kind` to spawn a CHILD under you — you (the caller) automatically become ' +
      'its master, and the host places it in your project folder (auto-created on first spawn). Kinds: ' +
      '"mutating" = thin worker with a host-made `dispatch/<subtask>` worktree+branch off `base`; ' +
      '"readonly" = thin worker in your repo, no worktree; ' +
      '"full" = a REGULAR session (project-folder child) — no thinning, it provisions itself (pass `skill` to have ' +
      'it run a specific bundled skill, e.g. from a ticket) and the human works with it like any session. ' +
      'Global caps apply across the whole tree — if at capacity you get `{deferred:true, reason:"at-capacity"}` and ' +
      'NO session is created (leave the node ready and retry next wake). Children report back via report_to_master; ' +
      'task a RUNNING child later with task_session.',
    inputSchema: obj({
      title: { type: 'string' },
      cwd: { type: 'string' },
      prompt: { type: 'string', description: 'First message to send to the new session. Merged in after `skill`\'s own instructions if both are given.' },
      skill: { type: 'string', description: 'Name of a bundled skill (from GET /__api/skills) for the session to run, e.g. for ticket work' },
      model: { type: 'string', description: '`claude --model` value (alias or full id); omit for the CLI default' },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: '`claude --effort` value; omit for the CLI default' },
      permission_mode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
      metadata: { type: 'object' },
      kind: { type: 'string', enum: ['mutating', 'readonly', 'full'], description: 'Spawn as your child: thin dispatch worker (mutating/readonly) or full regular session (full)' },
      subtask: { type: 'string', description: 'ORCHESTRATION.json node id this worker owns (names its branch/worktree)' },
      base: { type: 'string', description: 'Mutating only: branch/ref to fork the worktree off (default = your current branch)' },
      needs_server: { type: 'boolean', description: 'Worker needs a dev server — host allocates a free port from the pool into metadata.port and passes it to the worker as $PORT' },
      needs_screen: { type: 'boolean', description: 'Session will drive a browser/machine — host allocates a per-session desktop (Xvfb+VNC) up front instead of lazily on the first request_screen/capture_screen/browser open' },
    }),
    run: async (a) => {
      const body = {
        title: a.title, cwd: a.cwd, prompt: a.prompt, skill: a.skill, model: a.model, effort: a.effort,
        permissionMode: a.permission_mode, metadata: a.metadata,
      };
      if (a.needs_screen) body.needsScreen = true;
      // Dispatch: forward the caller as the worker's master + the worker spec.
      if (a.kind) {
        body.master = a.session_id || process.env.ARIGAMI_SESSION_ID;
        body.kind = a.kind;
        if (a.subtask) body.subtask = a.subtask;
        if (a.base) body.base = a.base;
        if (a.needs_server) body.needsServer = true;
      }
      const s = await api('POST', '/__api/sessions', body);
      if (s.deferred) return { deferred: true, reason: s.reason || 'at-capacity' };
      // `url` is relative on purpose (A3): the human may open it from a phone or
      // over a tailnet. `url_internal` = loopback form, kept for one version for
      // callers that fetch it from the host box itself.
      const url = `${PUBLIC_PATH}?session=${encodeURIComponent(s.id)}`;
      return { id: s.id, url, url_internal: `${HOST}${url}` };
    },
  },
  {
    name: 'report_to_master',
    description:
      'Worker → master handoff. Persists a CAPPED result struct to your own session, then wakes your master ' +
      'with a THIN pointer (it pulls detail itself — it never reads your chat). Call this when you finish, hit a ' +
      'blocker, error out, or want to flag a milestone. ALWAYS report even on error/block (never hang on a prompt — ' +
      'escalate up instead). state: done | blocked | error | milestone. summary: ≤~2KB of what you did (server truncates). ' +
      'artifacts: pointers the master can open on demand, e.g. [{kind:"branch",ref:"dispatch/x"},{kind:"file",path:"REPORT.md"},{kind:"diff",ref:"HEAD~1"}]. ' +
      'If you farmed out part of your work, aggregate your children into ONE result before reporting up. ' +
      'Normally the host already recorded your master at spawn time; pass `master` only if you know your parent id ' +
      'and the handoff reports no master (it back-fills the pointer for next time). ' +
      'skill_proposal_id: if your retro step (see skill_propose) filed a proposal while doing this task, pass its id ' +
      'here so your master can see it was raised — purely a pointer, not required.',
    inputSchema: obj({
      state: { type: 'string', enum: ['done', 'blocked', 'error', 'milestone'] },
      note: { type: 'string', description: 'One-line pointer shown to the master (the thin wake text)' },
      summary: { type: 'string', description: 'Capped (~2KB) bounded handoff of what you did' },
      artifacts: {
        type: 'array',
        items: obj({ kind: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' } }),
      },
      master: { type: 'string', description: 'Explicit master/parent session id — fallback when the spawn-time pointer is missing' },
      skill_proposal_id: { type: 'string', description: 'Optional: id of a skill_propose you filed this task, for your master to see' },
      ...SID_PROP,
    }, ['state', 'note']),
    run: (a) => api('POST', `/__api/sessions/${sid(a)}/report`, {
      state: a.state, note: a.note, summary: a.summary, artifacts: a.artifacts, master: a.master,
      skillProposalId: a.skill_proposal_id,
    }),
  },
  {
    name: 'task_session',
    description:
      'Controller → child command channel. Send a task/instruction to a session in YOUR project folder. ' +
      'Never interrupts: if the child is idle it is delivered now; if busy it lands in the child\'s pending-prompt ' +
      'queue and auto-plays when its current turn ends (returns delivered: "now" | "queued"). ' +
      'Authority = folder membership: if the human dragged the session out of your folder you get a 403 — stop ' +
      'orchestrating around it. This is a COMMAND channel, not a file channel: keep messages short and point at ' +
      'artifacts (branches/files) instead of pasting content. The child answers via report_to_master.',
    inputSchema: obj({
      target_session_id: { type: 'string', description: 'The child session to task (must be in your project folder)' },
      message: { type: 'string', description: 'The task/instruction to deliver' },
      ...SID_PROP,
    }, ['target_session_id', 'message']),
    run: (a) =>
      api('POST', `/__api/sessions/${a.target_session_id}/task`, {
        text: a.message,
        from: sid(a),
      }),
  },
  {
    name: 'cronjob',
    description:
      'Schedule a durable, host-owned job (survives restart — unlike Claude Code\'s own CronCreate, which is ' +
      'session-local and lost on close). action "create": schedule_kind "cron" (5-field expr, e.g. "0 9 * * 1-5"), ' +
      '"interval" (e.g. "30m"/"2h"/"1d", repeats from the last run), or "at" (ISO timestamp, fires once). ' +
      'session_mode "isolated" (default) spawns a fresh session per run with `prompt` as its first message + the host\'s ' +
      'memory bootstrap, and closes/archives it once it calls report_to_master — set autonomous:true so it runs ' +
      'unattended (bypassPermissions, no pausing for questions/review). session_mode "existing" delivers the prompt into ' +
      'target_session_id instead (like task_session: now if idle, queued if busy) — nothing is auto-archived for that mode. ' +
      'deliver controls what happens with the result of an isolated run: deliver_push (default true) sends a web-push to ' +
      'the human\'s phone; deliver_master wakes another session with a thin pointer (like report_to_master); ' +
      'deliver_whatsapp is accepted but not yet wired to an outbound channel in this version — do not rely on it. ' +
      'A run\'s summary/note starting with "[SILENT]" suppresses a SUCCESS delivery only — failures always deliver. ' +
      'GUARD: a session that was itself spawned by a cron job cannot create new ones (loop protection) — action ' +
      '"create" from such a session fails. Other actions: "list" (your jobs + recent runs), "pause"/"resume" (toggle ' +
      '`enabled`, id required), "run" (fire now, bypassing the schedule and the shared maxConcurrent gate, id required), ' +
      '"remove" (id required).',
    inputSchema: obj({
      action: { type: 'string', enum: ['create', 'list', 'pause', 'resume', 'run', 'remove'] },
      id: { type: 'string', description: 'Cron job id — required for pause/resume/run/remove' },
      name: { type: 'string', description: 'create: short label shown in the Triggers UI' },
      prompt: { type: 'string', description: 'create: the message the job sends (first message for isolated, task text for existing)' },
      schedule_kind: { type: 'string', enum: ['cron', 'interval', 'at'], description: 'create: required' },
      schedule_value: { type: 'string', description: 'create: e.g. "0 9 * * 1-5" (cron), "30m" (interval), or an ISO timestamp (at). Required.' },
      session_mode: { type: 'string', enum: ['isolated', 'existing'], description: 'create: default "isolated"' },
      target_session_id: { type: 'string', description: 'create: required when session_mode is "existing"' },
      deliver_push: { type: 'boolean', description: 'create: default true' },
      deliver_whatsapp: { type: 'string', description: 'create: JID — accepted but not yet sent in this version' },
      deliver_master: { type: 'string', description: 'create: session id to wake with the result' },
      autonomous: { type: 'boolean', description: 'create: isolated runs only — bypassPermissions + no-questions directive' },
      ...SID_PROP,
    }, ['action']),
    run: async (a) => {
      if (a.action === 'create') {
        if (!a.prompt) throw new Error('prompt is required');
        if (!a.schedule_kind || !a.schedule_value) throw new Error('schedule_kind and schedule_value are required');
        const sessionMode = a.session_mode === 'existing' ? `existing:${a.target_session_id || ''}` : 'isolated';
        if (sessionMode === 'existing:') throw new Error('target_session_id is required when session_mode is "existing"');
        return api('POST', '/__api/triggers', {
          type: 'cron',
          name: a.name,
          prompt: a.prompt,
          schedule: { kind: a.schedule_kind, value: a.schedule_value },
          sessionMode,
          deliver: { push: a.deliver_push, whatsapp: a.deliver_whatsapp, master: a.deliver_master },
          autonomous: a.autonomous,
          createdBySessionId: sid(a),
        });
      }
      if (a.action === 'list') {
        const all = await api('GET', '/__api/triggers');
        return all
          .filter((t) => t.type === 'cron')
          .map((t) => ({
            id: t.id, name: t.name, enabled: t.enabled, schedule: t.schedule, prompt: t.prompt,
            sessionMode: t.sessionMode, deliver: t.deliver, autonomous: t.autonomous,
            lastRun: t.lastRun, nextRunAt: t.nextRunAt, recentRuns: (t.runs || []).slice(-5),
          }));
      }
      if (a.action === 'pause' || a.action === 'resume') {
        if (!a.id) throw new Error('id is required');
        return api('PATCH', `/__api/triggers/${a.id}`, { enabled: a.action === 'resume' });
      }
      if (a.action === 'run') {
        if (!a.id) throw new Error('id is required');
        return api('POST', `/__api/triggers/${a.id}/run`);
      }
      if (a.action === 'remove') {
        if (!a.id) throw new Error('id is required');
        return api('DELETE', `/__api/triggers/${a.id}`);
      }
      throw new Error(`unknown action: ${a.action}`);
    },
  },
  {
    name: 'list_sessions',
    description: 'List host sessions (summaries).',
    inputSchema: obj({}),
    run: async () => {
      const all = await api('GET', '/__api/sessions?archived=true');
      return all.map((s) => ({
        id: s.id, title: s.title, status: s.status, color: s.color, cwd: s.cwd,
        archived: s.archived, claude_state: s.claude?.state, metadata: s.metadata,
      }));
    },
  },
  {
    name: 'delete_session',
    description:
      'Delete a session — removes it from the rail and kills its claude process. ' +
      'Pass run_cleanup:true to also run the session metadata.cleanup commands (e.g. kill dev servers, remove the worktree). ' +
      'Idempotent: succeeds even if the session is already gone. ' +
      'NOTE: deleting the CURRENT session (no session_id, or your own) ends it immediately — call it last, only after a human confirmed (e.g. via request_action).',
    inputSchema: obj({ run_cleanup: { type: 'boolean' }, ...SID_PROP }),
    run: async (a) => {
      const id = sid(a);
      try {
        return await api('DELETE', `/__api/sessions/${id}${a.run_cleanup ? '?runCleanup=true' : ''}`);
      } catch (e) {
        if (/no such session|unknown session/i.test(e.message)) return { ok: true, alreadyGone: true };
        throw e;
      }
    },
  },
  {
    name: 'restart_session',
    description:
      'Restart a session in place — kills its claude process and respawns it (--resume) in the same cwd. ' +
      'The worktree, branch, metadata, chat and tabs are all preserved; only the process is fresh, which re-establishes ' +
      'dropped MCP server connections (Linear/Notion/Figma). Also revives a dead session. ' +
      'NOTE: restarting the CURRENT session (no session_id, or your own) aborts your in-flight turn — call it last.',
    inputSchema: obj({ ...SID_PROP }),
    run: (a) => api('POST', `/__api/sessions/${sid(a)}/restart`),
  },
  {
    name: 'host_restart',
    description:
      'Restart the Arigami HOST process itself (not a session) — e.g. after a merge to master so the new code runs, ' +
      'or with upgrade:true to `git pull --ff-only && bun install && build web` first. The supervisor (systemd/launchd/pm2) ' +
      'brings it back within seconds; every session is resumed. when:"idle" waits until no session has a turn in flight ' +
      '(max 30 min), when:"now" gives in-flight turns a short grace period then restarts. ' +
      'GUARDED: only master/controller sessions may call this (403 otherwise); 409 when the host has no supervisor. ' +
      'Your own turn will be cut — say what you did first, then call this last.',
    inputSchema: obj({
      when: { type: 'string', enum: ['now', 'idle'], description: 'default "idle"' },
      upgrade: { type: 'boolean', description: 'Pull + install + build before restarting (refused if the repo is dirty)' },
      ...SID_PROP,
    }),
    run: (a) => {
      const when = a.when === 'now' ? 'now' : 'idle';
      const hdr = { 'x-arigami-confirm': 'yes', 'x-arigami-session': sid(a) };
      return api('POST', `/__api/host/${a.upgrade ? 'upgrade' : 'restart'}?when=${when}`, {}, hdr);
    },
  },
  {
    name: 'set_title',
    description: 'Set the session title shown in the host rail.',
    inputSchema: obj({ title: { type: 'string' }, ...SID_PROP }, ['title']),
    run: (a) => patchSession(a, { title: a.title }),
  },
  {
    name: 'set_color',
    description: 'Set the session accent color (hex).',
    inputSchema: obj({ color: { type: 'string' }, ...SID_PROP }, ['color']),
    run: (a) => patchSession(a, { color: a.color }),
  },
  {
    name: 'set_status',
    description: 'Set the session status (free-form string; the rail groups by it).',
    inputSchema: obj({ status: { type: 'string' }, ...SID_PROP }, ['status']),
    run: (a) => patchSession(a, { status: a.status }),
  },
  {
    name: 'set_metadata',
    description:
      'Merge a patch into session.metadata (e.g. {worktree, branch, ticket, cleanup: [cmds]}). ' +
      '{needs_server:true} asks the host to allocate a dev-server port into metadata.port (see allocate_port).',
    inputSchema: obj({ patch: { type: 'object' }, ...SID_PROP }, ['patch']),
    run: (a) => patchSession(a, { metadata: a.patch }),
  },
  {
    name: 'allocate_port',
    description:
      'Reserve a free dev-server port for THIS session from the host pool (same pool dispatch workers get via ' +
      'needs_server). Returns {port, existing}. Idempotent — a session keeps one port until it is deleted. ' +
      'Bind your dev server to it, then open_tab({type:"url", url:"http://localhost:<port>"}) so the human sees it ' +
      'through the host proxy — do not paste the localhost URL into your reply.',
    inputSchema: obj({ ...SID_PROP }),
    run: (a) => api('POST', `/__api/sessions/${sid(a)}/allocate-port`),
  },
  {
    name: 'set_progress',
    description: 'Set the progress strip. steps: [{label, state: done|active|pending|error}]. null/[] clears.',
    inputSchema: obj({
      steps: {
        type: ['array', 'null'],
        items: obj({ label: { type: 'string' }, state: { type: 'string', enum: ['done', 'active', 'pending', 'error'] } }, ['label', 'state']),
      },
      ...SID_PROP,
    }),
    run: (a) => patchSession(a, { progress: a.steps?.length ? { steps: a.steps } : null }),
  },
  {
    name: 'open_tab',
    description:
      'Open a tab in the session: type "url" (rendered in an iframe via the host proxy) or "content" (html/markdown). Returns {tab_id}. ' +
      'This is THE way to show the human a live dev server: pass its http://localhost:<port> URL here and the host proxies it — ' +
      'never paste that URL into your reply (the human may be on a phone). For static output use publish_artifact instead. ' +
      'URL guidance — localhost URLs (dev server, Storybook) render directly; for a Linear issue use "/__ticket/<ID>" (linear.app cannot be embedded); ' +
      'for a GitHub PR use "/__pr/<owner>/<repo>/<number>" (github.com cannot be embedded; this renders via the local gh auth) — raw linear.app/github.com PR urls are auto-rewritten to these; ' +
      'other unembeddable sites (e.g. Chromatic builds) become external link tabs that open in a new window.',
    inputSchema: obj({
      type: { type: 'string', enum: ['url', 'content'] },
      title: { type: 'string' },
      url: { type: 'string' },
      format: { type: 'string', enum: ['html', 'markdown'] },
      body: { type: 'string' },
      compare_url: { type: 'string', description: 'Prod URL — renders a compare-to-prod toggle. Omit to compare against prod at the same path by default.' },
      compare: { type: 'boolean', description: 'Open the tab already split in comparison mode (local vs compare_url / prod), not just with the toggle available.' },
      badge: { type: 'string' },
      ...SID_PROP,
    }, ['type', 'title']),
    run: async (a) => {
      // compare can be requested via compare_url (an explicit baseline) and/or
      // compare:true (open straight into the split view). Either alone is valid —
      // compare:true with no url compares against prod at the same path.
      const wantCompare = a.compare === true || a.compare_url != null;
      const tab = await api('POST', `/__api/sessions/${sid(a)}/tabs`, {
        type: a.type, title: a.title, url: a.url, format: a.format, body: a.body,
        compare: wantCompare ? { url: a.compare_url, open: a.compare === true } : undefined,
        badge: a.badge,
      });
      return { tab_id: tab.id };
    },
  },
  {
    name: 'publish_artifact',
    description:
      'Publish a static artifact (an HTML file, a built app folder, a report, an image) so the human can open it ' +
      'from ANY device (laptop, phone). The host snapshots the file/folder and serves it on its own origin. ' +
      'Returns a HOST-RELATIVE path — NEVER print localhost URLs; show the returned `path` or rely on the chat card that appears. ' +
      'Directory: entry defaults to index.html; build with relative asset paths (Vite: base "./"). ' +
      'Re-publishing the same `path` creates a new version and updates the card. The page runs sandboxed (opaque origin: no cookies, ' +
      'no localStorage, no same-origin /__api calls). `share:true` is reserved for share links (not available yet → share_url:null + warning).',
    inputSchema: obj({
      path: { type: 'string', description: 'Absolute path (or relative to the session cwd) to a file or directory' },
      title: { type: 'string' },
      entry: { type: 'string', description: 'Entry file inside a directory (default index.html)' },
      open: { type: 'boolean', description: 'Also open as a session tab (default true)' },
      notify: { type: 'boolean', description: 'Send a push notification with the link (default false)' },
      share: { type: 'boolean', description: 'Also mint an expiring public share link (K2 — not implemented yet)' },
      ...SID_PROP,
    }, ['path', 'title']),
    run: async (a) => {
      const r = await api('POST', `/__api/sessions/${sid(a)}/artifacts`, {
        path: a.path, title: a.title, entry: a.entry, open: a.open, notify: a.notify, share: a.share,
      });
      if (r?.error) throw new Error(r.error);
      return {
        artifact_id: r.artifact_id, path: r.path, version: r.version, bytes: r.bytes, files: r.files,
        warnings: r.warnings || [], share_url: r.share_url ?? null,
      };
    },
  },
  {
    name: 'update_tab',
    description: 'Update fields of an existing tab.',
    inputSchema: obj({
      tab_id: { type: 'string' },
      title: { type: 'string' },
      url: { type: 'string' },
      format: { type: 'string', enum: ['html', 'markdown'] },
      body: { type: 'string' },
      compare_url: { type: 'string' },
      badge: { type: 'string' },
      ...SID_PROP,
    }, ['tab_id']),
    run: (a) => {
      const patch = {};
      for (const k of ['title', 'url', 'format', 'body', 'badge']) if (a[k] !== undefined) patch[k] = a[k];
      if (a.compare_url !== undefined) patch.compare = a.compare_url ? { url: a.compare_url } : null;
      return api('PATCH', `/__api/sessions/${sid(a)}/tabs/${a.tab_id}`, patch);
    },
  },
  {
    name: 'close_tab',
    description: 'Close a tab (the first "session" tab cannot be closed).',
    inputSchema: obj({ tab_id: { type: 'string' }, ...SID_PROP }, ['tab_id']),
    run: (a) => api('DELETE', `/__api/sessions/${sid(a)}/tabs/${a.tab_id}`),
  },
  {
    name: 'activate_tab',
    description: 'Bring a tab to the front.',
    inputSchema: obj({ tab_id: { type: 'string' }, ...SID_PROP }, ['tab_id']),
    run: (a) => api('POST', `/__api/sessions/${sid(a)}/activate-tab`, { tabId: a.tab_id }),
  },
  {
    name: 'set_changes_explanation',
    description:
      "Store explanations of the session worktree's git changes, shown in the Changes tab (and open that tab). " +
      'Write the explanation text in the language the user asked for (any language; e.g. Hebrew, Spanish) — match the chat. ' +
      'files: [{path, summary, dir?}] — for each changed file, what changed and why (1–3 sentences). ' +
      'features: [{title, summary, files:[paths], details?, dir?}] — cross-file groupings: a coherent change that spans several files, ' +
      'with the files it touches and an optional longer "details" walkthrough. ' +
      'dir: optional text direction "rtl" | "ltr" | "auto" (default auto) — set "rtl" for Hebrew/Arabic/Farsi so it renders right-aligned. ' +
      'base: optional comparison ref the explanation is for — omit (or "HEAD") for uncommitted changes, or a branch/commit (e.g. "main", "abc1234") to explain what differs from it. ' +
      'The Changes tab opens on this base. Read the matching diff first: GET /__api/sessions/:id/changes?base=<ref> and /changes/diff?path=&base=<ref>.',
    inputSchema: obj({
      language: { type: 'string', description: 'Human name of the explanation language, e.g. "Hebrew"' },
      base: { type: 'string', description: 'Comparison ref: "HEAD"/omit for uncommitted, or a branch/commit like "main"' },
      files: {
        type: 'array',
        items: obj({ path: { type: 'string' }, summary: { type: 'string' }, dir: { type: 'string', enum: ['rtl', 'ltr', 'auto'] } }, ['path', 'summary']),
      },
      features: {
        type: 'array',
        items: obj({
          title: { type: 'string' },
          summary: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          details: { type: 'string' },
          dir: { type: 'string', enum: ['rtl', 'ltr', 'auto'] },
        }, ['title', 'summary']),
      },
      ...SID_PROP,
    }),
    run: (a) => api('POST', `/__api/sessions/${sid(a)}/changes/explanation`, {
      language: a.language, files: a.files, features: a.features, base: a.base,
    }),
  },
  {
    name: 'set_status_summary',
    description:
      "Deliver a session's status brief (shown in the header Summary popover). This is the ONLY deliverable of a " +
      'summary run — the summary does not exist until you call it. text: the brief as markdown, in the language of the ' +
      'conversation. tldr: a 2–3 line plain-text condensation of the brief (shown as the sidebar tooltip). ' +
      'at_seq: the transcript sequence number you were told this summary accounts for (pass it back verbatim).',
    inputSchema: obj({
      text: { type: 'string', description: 'The status brief, markdown, in the conversation language' },
      tldr: { type: 'string', description: '2–3 line plain-text condensation of the brief (sidebar tooltip)' },
      at_seq: { type: 'number', description: 'The chat seq this summary covers (given to you in the prompt)' },
      ...SID_PROP,
    }, ['text']),
    run: (a) => api('POST', `/__api/sessions/${sid(a)}/summary/result`, {
      text: a.text, tldr: a.tldr, atSeq: a.at_seq,
    }),
  },
  {
    name: 'request_action',
    description:
      'Show an action bar with buttons in the session UI. Answers come ONLY from a human click (delivered as a user message). ' +
      'Sends a push notification to the human\'s phone, so use it for real decisions, not status updates (use set_status_summary / set_progress for those). ' +
      'Best practice: one short question in `prompt` (what you need decided and why, ≤200 chars — that is the notification body), 2–4 buttons with clear labels, ' +
      'and stop working until the answer arrives. Do NOT use it for things the human has to DO on the machine (login, 2FA, CAPTCHA, payment) — that is request_screen.',
    inputSchema: obj({
      prompt: { type: 'string' },
      buttons: {
        type: 'array',
        items: obj({ label: { type: 'string' }, value: { type: 'string' }, style: { type: 'string', enum: ['primary', 'default', 'danger'] } }, ['label', 'value']),
      },
      ...SID_PROP,
    }, ['prompt', 'buttons']),
    run: (a) => api('POST', `/__api/sessions/${sid(a)}/action`, { prompt: a.prompt, buttons: a.buttons }),
  },
  {
    name: 'request_review',
    description: 'Sugar: set status to "In Review" and show a review action bar (Request changes / Verified).',
    inputSchema: obj({ summary: { type: 'string' }, ...SID_PROP }),
    run: async (a) => {
      const id = sid(a);
      await api('PATCH', `/__api/sessions/${id}`, { status: 'In Review' });
      return api('POST', `/__api/sessions/${id}/action`, {
        prompt: a.summary || 'Claude finished — review the changes',
        buttons: [
          { label: 'Request changes', value: 'request-changes' },
          { label: '✓ Verified', value: 'verified', style: 'primary' },
        ],
      });
    },
  },
  {
    name: 'register_listener',
    description:
      'Arm a deterministic poller for an external event this session is waiting on, so you can stop working and be woken when something happens — instead of polling yourself. ' +
      'type "github-pr" — watches a pull request and wakes this session (with a thin pointer; you then re-fetch and decide) on new reviews/comments/approval, CI failures, merge conflicts, and once when it is merged/closed. ' +
      'PR target: pass a github PR url, or owner+repo+number; if you omit both, it infers the PR for the current branch in the session worktree. ' +
      'PR fire_on (default ["new_review","new_comment","ci_failed","conflicts"]): any of new_review | approved | changes_requested | new_comment | ci_failed (a check-run/status turned red — fires once per check per push) | ci_passed (ALL checks green — once per push) | conflicts (PR became unmergeable — once until resolved). ' +
      'type "linear-issue" — watches a Linear ticket and wakes this session when someone comments on it (or, opted-in, when its status/assignee changes), and once when it is completed/canceled. ' +
      'Issue target: pass issue_id (the ENG-XXXX identifier or the UUID). ' +
      'Linear fire_on (default ["new_comment"]): any of new_comment | status_changed | assignee_changed. Comments authored by this session\'s own Linear user are ignored. ' +
      'type "slack" — watches a Slack channel/DM (or a single thread) and wakes this session on new messages. ' +
      'Slack target: pass channel_id (a channel/DM id like C0123ABCD / D0123ABCD), optionally thread_ts to watch one thread, or a Slack message url. Requires a Slack user token connected in the host settings. ' +
      'Slack fire_on (default ["new_message"]): any of new_message | mention (a message that @-mentions you) | reply (a threaded reply). Messages authored by your own Slack user are ignored. ' +
      'type "whatsapp" — watches the local WhatsApp DB (written by the whatsapp-mcp Baileys process) and wakes this session when new incoming messages arrive. No target required. ' +
      'For personal chats (default): omit group_jid — only direct messages are tracked. ' +
      'For a specific group: pass group_jid (e.g. "120363412808577334@g.us") — tracking starts immediately and stops when the listener is cancelled. Group messages are NOT stored unless explicitly subscribed. ' +
      'Optionally pass db_path to override the default DB location. ' +
      'type "sms" — watches for inbound SMS messages forwarded by the phone\'s SMS Gateway app via webhook. ' +
      'Optionally pass from_filter to only match SMS from a specific number (partial match). ' +
      'It auto-stops on the terminal event (merge/close, or completed/canceled), after ttl_days (default 7), or when this session is archived. Returns the listener {id, label, ...}.',
    inputSchema: obj({
      type: { type: 'string', enum: ['github-pr', 'linear-issue', 'slack', 'whatsapp', 'sms'], description: 'Listener type (default github-pr)' },
      url: { type: 'string', description: 'GitHub PR url, or a Slack message url (for type slack)' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      number: { type: 'number' },
      issue_id: { type: 'string', description: 'Linear issue identifier (ENG-1234) or UUID — for type linear-issue' },
      channel_id: { type: 'string', description: 'Slack channel/DM id (C…/D…/G…) — for type slack' },
      thread_ts: { type: 'string', description: 'Slack thread ts to watch a single thread — for type slack' },
      fire_on: { type: 'array', items: { type: 'string', enum: ['new_review', 'approved', 'changes_requested', 'new_comment', 'ci_failed', 'ci_passed', 'conflicts', 'status_changed', 'assignee_changed', 'new_message', 'mention', 'reply', 'new_sms'] } },
      group_jid: { type: 'string', description: 'WhatsApp group JID to track (e.g. "120363412808577334@g.us") — for type whatsapp. Omit for personal messages only.' },
      db_path: { type: 'string', description: 'Override WhatsApp DB path (for type whatsapp, default: /home/arigami/.local/lib/whatsapp-mcp/data/whatsapp.db)' },
      from_filter: { type: 'string', description: 'SMS sender filter — partial match on phone number (for type sms)' },
      ttl_days: { type: 'number', description: 'Auto-stop after this many days (default 7)' },
      interval_sec: { type: 'number', description: 'Poll interval seconds (default 10 for whatsapp, 30 for others)' },
      ...SID_PROP,
    }),
    run: (a) => api('POST', `/__api/sessions/${sid(a)}/listeners`, {
      type: a.type || 'github-pr', url: a.url, owner: a.owner, repo: a.repo, number: a.number,
      issue_id: a.issue_id, channel_id: a.channel_id, thread_ts: a.thread_ts,
      fire_on: a.fire_on, ttl_days: a.ttl_days, interval_sec: a.interval_sec,
      group_jid: a.group_jid, db_path: a.db_path, from_filter: a.from_filter,
    }),
  },
  {
    name: 'list_listeners',
    description: 'List the listeners armed for this session (id, type, label, status, firedCount).',
    inputSchema: obj({ ...SID_PROP }),
    run: (a) => api('GET', `/__api/sessions/${sid(a)}/listeners`),
  },
  {
    name: 'cancel_listener',
    description: 'Cancel (remove) a listener by id.',
    inputSchema: obj({ listener_id: { type: 'string' }, ...SID_PROP }, ['listener_id']),
    run: (a) => api('DELETE', `/__api/sessions/${sid(a)}/listeners/${a.listener_id}`),
  },
  {
    name: 'request_screen',
    description:
      'Hand the shared desktop over to the human for a step only they can do — manual login, 2FA / OTP code, CAPTCHA, payment, an interactive installer. ' +
      'Shows a live embedded view in the chat with a "Take over" / "Done" control and pushes a notification to the human\'s phone. ' +
      'BLOCKS until they click Done (or ~30 min timeout); the response may include a short note about what they did. ' +
      'Best practice (see the machine-work skill): (1) call capture_screen right before, so the human sees where you are; ' +
      '(2) `prompt` = one sentence on what you were trying to do and where you got stuck; (3) set `reason` to the closest category — it drives the notification title; ' +
      '(4) `hint` = exactly what the human should do and what "done" looks like (e.g. "enter the SMS code and wait for the dashboard, then click Done"); ' +
      '(5) after it returns, verify the state yourself (re-read the page / capture_screen) before continuing — do not assume it worked; ' +
      '(6) never ask for passwords or codes in chat — let the human type them on the machine. ' +
      'Opens in Watch (view-only) mode; the human can click "Take over" to drive the machine, then "Done". Returns {takenOver: boolean, note?: string} — takenOver=true means the human actually intervened. ' +
      'Do not call it for questions or decisions — use request_action for those.',
    inputSchema: obj(
      {
        prompt: { type: 'string', description: 'What you were doing and why you need the human (shown in the card and the push).' },
        reason: { type: 'string', enum: ['login', '2fa', 'captcha', 'payment', 'other'], description: 'Why the human is needed. Drives the card label and push title.' },
        hint: { type: 'string', description: 'Exactly what to do and what "done" looks like.' },
        ...SID_PROP,
      },
      ['prompt']
    ),
    run: (a) =>
      api('POST', '/__mcp/screen-request', {
        session_id: sid(a),
        prompt: a.prompt,
        ...(a.reason ? { reason: a.reason } : {}),
        ...(a.hint ? { hint: a.hint } : {}),
      }),
  },
  {
    name: 'capture_screen',
    description:
      'Take a screenshot of the session\'s desktop and post it in the chat as a screenshot card. Screenshots are for the HUMAN\'s timeline, not a log — fewer, meaningful ones. ' +
      'Required moments only (machine-work skill): (a) once the first page has loaded, (b) right before request_screen, (c) right after it returns, to verify the human\'s step, (d) the final state or a failure. ' +
      'Any other capture only when YOU need to see the screen to decide what to do next — then it is a viewing tool, not documentation. Never after every click/scroll/form field. ' +
      'Frames that look the same as the previous screenshot are deduped server-side: you get {ok, duplicate:true, url:<previous>} and no new card — do not retry. ' +
      'Give a short factual `caption` ("Login page loaded", "Order confirmed #123"). Returns {ok, url, ts}; {ok:false, error} if no screen is available — then continue without screenshots, do not improvise your own.',
    inputSchema: obj({ caption: { type: 'string', description: 'What this screenshot shows (short, factual).' }, ...SID_PROP }),
    run: async (a) => {
      try {
        return await api('POST', `/__api/sessions/${sid(a)}/screenshot`, { ...(a.caption ? { caption: a.caption } : {}) });
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
  },
  {
    name: 'save_browser_logins',
    description:
      'Sync this session\'s Chrome profile (cookies, saved logins, local storage — not passwords/autofill) back to the shared base profile, so future sessions\' browsers start already logged in. ' +
      'Happens automatically after a request_screen resolves with the human taking over, and at session end — call this yourself only if you want it synced sooner (e.g. right after completing a login flow without a takeover). ' +
      'Safe to call anytime; a no-op if this session never opened a browser (see the machine-work skill\'s Chrome helper).',
    inputSchema: obj({ ...SID_PROP }),
    run: (a) => api('POST', `/__api/sessions/${sid(a)}/browser/sync-logins`, {}),
  },
  {
    name: 'memory_write',
    description:
      "Write to Arigami's own long-term memory (owned by the host, shared by EVERY session/worker on this instance — not Claude Code's per-project auto-memory, and not scoped to your cwd/worktree). " +
      'target "user" = facts about the human (preferences, people, ~600 token cap), "memory" = standing facts/decisions/context (~900 token cap), "journal" = append-only log of what happened today (no cap, action must be "add"). ' +
      'action "add" appends a new bullet (silently deduped if an equivalent line already exists); "replace" needs old_text (the existing line to match) + content (its replacement); "remove" needs old_text (or content) to delete a line — "user"/"memory" only, not journal. ' +
      'Refused if the content looks like a credential/secret or a prompt-injection/exfiltration attempt, or would exceed the target\'s token cap — trim or replace an existing line first. Every write is logged (before/after) and undoable from the host UI/API.',
    inputSchema: obj(
      {
        target: { type: 'string', enum: ['user', 'memory', 'journal'] },
        action: { type: 'string', enum: ['add', 'replace', 'remove'] },
        content: { type: 'string', description: 'New/replacement text (required for add/replace; usable as the remove needle if old_text is omitted)' },
        old_text: { type: 'string', description: 'Existing line to match, for replace/remove' },
        ...SID_PROP,
      },
      ['target', 'action']
    ),
    run: (a) =>
      api('POST', '/__api/memory/write', {
        target: a.target,
        action: a.action,
        content: a.content,
        old_text: a.old_text,
        source: 'agent',
        sessionId: a.session_id || process.env.ARIGAMI_SESSION_ID,
      }),
  },
  {
    name: 'memory_search',
    description:
      "Full-text search over Arigami's own memory (USER.md, MEMORY.md, journal/*.md, episodes/*.md) — the on-demand half of the two-layer memory model (USER.md+MEMORY.md are already injected once at session start; use this for anything older/deeper). " +
      'Zero token cost until called. Returns short ranked snippets (~700 chars each), not full files — follow up with memory_get for the whole file. scope optionally narrows to one of "user" | "memory" | "journal" | "episode".',
    inputSchema: obj({
      query: { type: 'string' },
      scope: { type: 'string', enum: ['user', 'memory', 'journal', 'episode'] },
      limit: { type: 'number', description: 'Max results (default 8, max 50)' },
    }, ['query']),
    run: (a) => api('GET', `/__api/memory/search?query=${encodeURIComponent(a.query)}${a.scope ? `&scope=${encodeURIComponent(a.scope)}` : ''}${a.limit ? `&limit=${a.limit}` : ''}`),
  },
  {
    name: 'memory_get',
    description: 'Read one memory file in full by its path (as returned by memory_search, e.g. "USER.md", "journal/2026-08-28.md", "episodes/<id>.md").',
    inputSchema: obj({ path: { type: 'string' } }, ['path']),
    run: (a) => api('GET', `/__api/memory/get?path=${encodeURIComponent(a.path)}`),
  },
  {
    name: 'skill_propose',
    description:
      'Propose a change to a skill (or a brand-new one) for HUMAN review — writes ONLY to a staging area ' +
      '($ARIGAMI_DIR/skill-proposals/), never to the live skills/ pack. Use this from a retro/reflection step ' +
      '(end of dispatch/project-manager/machine-work, or any time you learn something a future skill run should ' +
      'know) — not speculatively, and never as a background/periodic habit. ' +
      'name: the skill dir (existing to edit it, new to propose creating it — lowercase/digits/hyphens). ' +
      'content: the FULL new SKILL.md text (frontmatter + body) — the reliable way to propose, prefer this. ' +
      'patch: alternative — a unified diff against the skill\'s current content (or against empty, for a new skill); ' +
      'refused with an error if it fails to apply cleanly, in which case pass full `content` instead. Exactly one of ' +
      'content/patch is required. rationale (required): why — what you learned and why a future run needs it. ' +
      'evidence: optional supporting detail (what happened, a link, a transcript excerpt). ' +
      'A human then reviews a diff and applies/rejects/quarantines it from the Skills UI — nothing here is ever ' +
      'auto-applied. Returns the proposal id; you can pass it to report_to_master\'s skill_proposal_id.',
    inputSchema: obj({
      name: { type: 'string' },
      content: { type: 'string', description: 'Full proposed SKILL.md content — preferred over patch' },
      patch: { type: 'string', description: 'Unified diff against the current (or empty, if new) SKILL.md content' },
      rationale: { type: 'string' },
      evidence: { type: 'string' },
      ...SID_PROP,
    }, ['name', 'rationale']),
    run: (a) => api('POST', '/__api/skill-proposals', {
      name: a.name, content: a.content, patch: a.patch, rationale: a.rationale, evidence: a.evidence,
      sessionId: a.session_id || process.env.ARIGAMI_SESSION_ID,
    }),
  },
  {
    name: 'permission_prompt',
    description: 'Internal: permission bridge for --permission-prompt-tool. Blocks until the human answers in the host UI.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name', 'input'],
      additionalProperties: true, // claude may pass extra fields; never reject
    },
    // Claude Code permission-prompt-tool protocol: return a JSON-stringified
    // {behavior:'allow', updatedInput} or {behavior:'deny', message} as text.
    run: async (a) => {
      try {
        return await api('POST', '/__mcp/permission', {
          session_id: a.session_id || process.env.ARIGAMI_SESSION_ID,
          tool_name: a.tool_name,
          input: a.input ?? {},
          tool_use_id: a.tool_use_id,
        });
      } catch (e) {
        return { behavior: 'deny', message: `arigami unreachable: ${e.message}` };
      }
    },
  },
];

const server = new Server({ name: 'arigami', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
  try {
    const result = await tool.run(req.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }] };
  } catch (e) {
    if (tool.name === 'permission_prompt') {
      // never error the permission channel — deny instead
      return { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: e.message }) }] };
    }
    return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
