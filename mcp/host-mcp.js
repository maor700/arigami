#!/usr/bin/env bun
// arigami MCP server (stdio). Every tool is a thin fetch() to the host's
// REST API. Session scoping: explicit session_id arg wins, else the
// ARIGAMI_SESSION_ID env injected by the host when it spawned this claude.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const HOST = process.env.ARIGAMI_URL || 'http://localhost:3099';

async function api(method, path, body) {
  const res = await fetch(HOST + path, {
    method,
    headers: { 'content-type': 'application/json' },
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
      'Create a new host session (spawns a claude process in cwd). Returns {id, url}.\n' +
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
    }),
    run: async (a) => {
      const body = {
        title: a.title, cwd: a.cwd, prompt: a.prompt, skill: a.skill, model: a.model, effort: a.effort,
        permissionMode: a.permission_mode, metadata: a.metadata,
      };
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
      return { id: s.id, url: `${HOST}/__host/?session=${s.id}` };
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
      'and the handoff reports no master (it back-fills the pointer for next time).',
    inputSchema: obj({
      state: { type: 'string', enum: ['done', 'blocked', 'error', 'milestone'] },
      note: { type: 'string', description: 'One-line pointer shown to the master (the thin wake text)' },
      summary: { type: 'string', description: 'Capped (~2KB) bounded handoff of what you did' },
      artifacts: {
        type: 'array',
        items: obj({ kind: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' } }),
      },
      master: { type: 'string', description: 'Explicit master/parent session id — fallback when the spawn-time pointer is missing' },
      ...SID_PROP,
    }, ['state', 'note']),
    run: (a) => api('POST', `/__api/sessions/${sid(a)}/report`, {
      state: a.state, note: a.note, summary: a.summary, artifacts: a.artifacts, master: a.master,
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
    description: 'Merge a patch into session.metadata (e.g. {worktree, branch, ticket, cleanup: [cmds]}).',
    inputSchema: obj({ patch: { type: 'object' }, ...SID_PROP }, ['patch']),
    run: (a) => patchSession(a, { metadata: a.patch }),
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
    description: 'Show an action bar with buttons in the session UI. Answers come ONLY from a human click (delivered as a user message).',
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
    description: 'Ask the human to look at / interact with the shared desktop (e.g. a manual login, CAPTCHA, interactive installer) — shown as a live embedded view in the chat. Blocks until they click Done; the response may include a short note about what happened.',
    inputSchema: obj({ prompt: { type: 'string' }, ...SID_PROP }, ['prompt']),
    run: (a) => api('POST', '/__mcp/screen-request', { session_id: sid(a), prompt: a.prompt }),
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
