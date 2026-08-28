# Arigami — v1 Specification

A web-shell cockpit for running many parallel Claude Code sessions. Bun server on
`localhost:3099`. The host is an **unopinionated platform**: it provides primitives
(sessions, chat, tabs, proxy, supervisor, MCP); all workflow (tickets, worktrees,
dev servers, review flows) lives in **skills** that drive the host through its MCP.

Design source: claude.ai/design handoff "Arigami Wireframes" (IDE-shell direction).
Decision record: memory `arigami-project` (grill-me session 2026-06-12).

## Layout

```
arigami/
  server/          Bun server (ESM .js, no TS in v1)
    index.js       entry: HTTP on :3099 — routes /__host/* (UI), /__api/* (REST),
                   /__ws (WebSocket), /__mcp-* (MCP helper), everything else → proxy
    state.js       session registry + persistence (~/.arigami/state.json)
    claude.js      claude CLI process manager (stream-json in/out, one proc per session)
    proxy.js       fixed-origin reverse proxy (ported from iframe-host-poc)
    pages.js       host-internal pages ported from PoC: /__ticket/<id>, compare slider
    bus.js         WebSocket hub: every state mutation broadcasts {type, payload}
  mcp/
    host-mcp.js    stdio MCP server (thin shim → HTTP /__api); registered into
                   spawned sessions; scoped by ARIGAMI_SESSION_ID env
  web/             React + Vite + Tailwind shell UI (built → served at /__host/)
  skills/          bundled default skill pack (create-from-ticket etc.)
  bin/host         CLI: start/stop/status/logs (modeled on PoC bin/host)
```

## Data model (single source of truth, in server/state.js)

```js
session = {
  id: 'sess_<nano>',          // host-generated
  title: 'scratch-3',         // user- or agent-set (host.set_title)
  color: '#E0594F',           // auto round-robin from palette; agent may override
  status: 'In Progress',      // FREE-FORM string; rail groups by it
  cwd: '~/Desktop/repos',     // claude proc working dir, set at creation
  archived: false,
  createdAt, updatedAt,
  metadata: {},               // agent-settable bag: {worktree, branch, ticket,
                              //  cleanup: ['rm -rf …','git branch -D …'], …}
  progress: null | { steps: [{label, state:'done'|'active'|'pending'|'error'}] },
  action: null | { id, prompt, buttons: [{label, value, style:'primary'|'default'|'danger'}] },
  tabs: [tab],                // first tab is ALWAYS {type:'session'} (the chat)
  activeTabId,
  claude: { sessionId, state:'idle'|'working'|'awaiting-input'|'dead',
            permissionMode:'default'|'acceptEdits'|'plan'|'bypassPermissions' },
}

tab =
  | { id, type:'session', title }                       // the chat terminal
  | { id, type:'url', title, url, color?, badge?,       // proxied iframe
      compare?: { url } }                               // renders compare-to-prod toggle
  | { id, type:'content', title, format:'html'|'markdown', body, badge? }
```

Persistence: JSON file `~/.arigami/state.json`, debounced writes. Chat history
is NOT duplicated — it lives in `~/.claude/projects` (claude owns it); the server
keeps an in-memory tail + last N per session in `~/.arigami/chat/<id>.jsonl`
for instant rehydration of the UI.

Session colors: palette `['#E0594F','#1F9C82','#6A4FC4','#2C6BD6','#CE8324','#3C9A4E','#C2459E','#5B62D6']`,
round-robin on creation.

## REST API (all JSON; no auth — localhost only)

```
GET    /__api/sessions                       → [session]   (?archived=true includes archived)
POST   /__api/sessions                       {title?, cwd?, prompt?, permissionMode?, metadata?} → session
                                              spawns claude in cwd; if prompt given, sends it as first message
GET    /__api/sessions/:id                   → session
PATCH  /__api/sessions/:id                   {title?|color?|status?|metadata?(merge)|progress?|archived?}
DELETE /__api/sessions/:id                   ?runCleanup=true → runs metadata.cleanup cmds first
POST   /__api/sessions/:id/tabs              {type,title,url?,format?,body?,compare?,badge?,color?} → tab
PATCH  /__api/sessions/:id/tabs/:tabId       {title?|url?|body?|badge?|color?|compare?}
DELETE /__api/sessions/:id/tabs/:tabId
POST   /__api/sessions/:id/activate-tab      {tabId}
POST   /__api/sessions/:id/message           {text}        → user message into claude stdin
POST   /__api/sessions/:id/action            {prompt, buttons} → sets action bar (request_action)
POST   /__api/sessions/:id/action/answer     {value}       → human click: posts value as user msg, clears bar
POST   /__api/sessions/:id/permission/answer {requestId, behavior:'allow'|'deny', message?}
POST   /__api/sessions/:id/interrupt                       → SIGINT-equivalent (stream-json interrupt)
GET    /__api/sessions/:id/chat?since=N      → chat events tail (rehydration; live = WS)
GET    /__api/linear/tickets?filter=assigned → launcher picker (reuse PoC Linear fetch/cache)
GET    /__api/config                         → {defaultCwd, palette, …}
```

Archive = PATCH {archived:true}: kill claude proc + leave record; rail shows under
"Archived" group; un-archive respawns claude with `--resume <claude.sessionId>`.

## WebSocket (/__ws)

Server → client events: `{type:'state', sessions}` on connect, then granular:
`session-created|session-updated|session-deleted|tab-*`,
`chat:<sessionId>` {event} (parsed stream-json: text deltas, tool_use cards, results),
`permission-request:<sessionId>` {requestId, toolName, input},
`action:<sessionId>`, `progress:<sessionId>`.
Client → server: none (use REST). Reconnect = full state replay.

## Claude process manager (server/claude.js)

- Spawn: `claude --input-format stream-json --output-format stream-json --verbose
  -p --permission-mode <mode> --session-id <uuid>` (cwd = session.cwd, env +
  `ARIGAMI_SESSION_ID`, `ARIGAMI_URL=http://localhost:3099`).
  Write `.mcp.json`-equivalent via `--mcp-config` pointing at `mcp/host-mcp.js`
  (command: `bun <abs path>/mcp/host-mcp.js`) so EVERY session has the host MCP.
- Permission prompts: `--permission-prompt-tool mcp__arigami__permission_prompt`.
  The MCP tool POSTs to /__api (blocking) → server emits `permission-request` →
  UI buttons → /permission/answer resolves the HTTP response → tool returns
  {behavior}. Timeout 10min → deny.
- Lazy lifecycle: proc runs while conversation active; on exit, next message
  respawns with `--resume <claude.sessionId>`. claude.state tracked from stream
  events (init/result/tool_use).
- Parse stream-json into normalized chat events for the UI:
  {kind:'user'|'assistant-text'|'tool-use'|'tool-result'|'thinking'|'result'|'error', …}.
  Persist to ~/.arigami/chat/<id>.jsonl (append).

## MCP tools (mcp/host-mcp.js — stdio, thin HTTP shim)

Session-scoped tools resolve the session from ARIGAMI_SESSION_ID env; tools
taking explicit session_id work from anywhere (any Claude instance).

```
create_session({title?, cwd?, prompt?, permission_mode?, metadata?}) → {id, url}
list_sessions() → summaries
set_title({title, session_id?})       set_color({color, session_id?})
set_status({status, session_id?})     set_metadata({patch, session_id?})  // merge
set_progress({steps, session_id?})    // null/[] clears
open_tab({type:'url'|'content', title, url?, format?, body?, compare_url?, badge?, session_id?}) → {tab_id}
update_tab({tab_id, …same fields…})   close_tab({tab_id})   activate_tab({tab_id})
request_action({prompt, buttons:[{label,value,style?}], session_id?})
request_review({summary?, session_id?})   // sugar: status='In Review' +
   action {prompt: summary||'Claude finished — review the changes',
           buttons:[{label:'Request changes',value:'request-changes'},
                    {label:'✓ Verified',value:'verified',style:'primary'}]}
request_screen({prompt, reason?, hint?, session_id?}) → {ok, note?}
   // reason: login|2fa|captcha|payment|other. BLOCKS until the human clicks
   // Done in the live screen card (or 30 min timeout → note explains).
capture_screen({caption?, session_id?})   // screenshot card in the chat timeline (T3)
permission_prompt(…)                  // internal: permission bridge (hidden from listing if possible)
```

Action-bar answers come ONLY from a human click in the UI.

### Human intervention → push notification

Three paths mean "the agent is stuck until a human acts", and each fires a
web-push (`server/push.ts`, `sendPush`) to every subscribed device, in
addition to the in-app card — same mechanism `listeners.ts` uses to wake a
session from an external event:

| Trigger | Where | Push title | Body |
|---|---|---|---|
| `request_screen` | `POST /__mcp/screen-request` → `handleScreenRequest` | `<session title> — <reason label>` (e.g. "login needed", "2FA code needed") | `prompt` (+ `hint` on a new line) |
| `request_action` / `request_review` | `POST /__api/sessions/:id/action` | `<session title> — waiting for your answer` | `prompt` |
| `report_to_master` with `state:'blocked'` | `POST /__api/sessions/:id/report` | `<session title> — blocked` | `note` or `summary` |

Rules (`pushIntervention` in `server/api.ts`):
- `tag` = `<kind>:<sessionId>` — the OS collapses repeats for the same session
  into one notification; `url` deep-links to the session and the service
  worker's `notificationclick` navigates there.
- Per session + kind cooldown of 15 s: a burst (e.g. an agent retrying
  `request_action`) does not buzz the phone repeatedly.
- Best-effort, fire-and-forget: no subscriptions or a push failure never fails
  the underlying request. `title` ≤ 80 chars, `body` ≤ 200.
- Status changes (`set_status`, `set_progress`, milestones) never push.

Agent-side convention for browser / desktop work — opening line, `capture_screen`
after each significant step, `request_screen` with `reason`+`hint` when blocked,
verify after Done, summary at the end — lives in `skills/machine-work/SKILL.md`.
Every skill that drives a browser should point to it.

## Proxy (server/proxy.js — ported from iframe-host-poc/server.js)

Keep verbatim behavior: per-tab targets via Service Worker (x-poc-target),
?__target= pinning, Location/Set-Cookie rewrites, WebSocket upgrade proxying,
Vercel bypass header, gzip handling. Strip: card overlay injection, old chat
relay, responder supervisor (replaced by claude.js). Keep host pages: /__ticket/<id>
(Linear renderer incl. GitHub PR view), /__compare (vs-prod slider), /__ticket-img.
URL tabs iframe `http://localhost:3099/?__target=<url>` (SW per-iframe-client
targeting works as it does for PoC tabs today; each iframe is its own SW client).

## Web UI (web/ — React + Vite + Tailwind v4)

Acme-flavored, light: yellow #F9D312 = host chrome accent, neutral surfaces,
per-session colors, `ui-monospace` stack for ids/ports/branches, Inter/system for
text. Layout per wireframe (IDE shell):

- **Left rail (248px)**: yellow "+ New session" btn (boxy 2px border, hard shadow),
  search field (`/` shortcut), header row "ACTIVE · N" + flat/grouped (☰/▦) toggle,
  session rows: color dot, mono id/title, status · relative-time, ⋯ menu →
  Archive / Delete with the two confirm dialogs from the wireframe
  (archive: checkbox "Also remove the worktree…" shown ONLY when metadata.cleanup
  present, listing the commands; delete: red, shows cleanup cmds verbatim).
  Grouped mode: status header rows. Archived group collapsed at bottom (restore).
  Footer: "proxy up · N servers".
- **Tab bar (44px)**: 3px session-color strip at left edge, yellow wave glyph,
  first tab "Session" (color dot + title, truncates first, yellow active underline),
  then dynamic tabs (badge support: count, dot, text like "#2841", ↗ for external),
  `+` opens a small "open URL as tab" popover.
- **Session tab content**: chat pane (claudecodeui-inspired): terminal-dark message
  area (#1b1b1d) rendering chat events — user msgs, assistant text (markdown),
  collapsed tool-use cards (icon + name + summary, expandable, diff stat coloring
  +green/−coral), result line; header strip: color dot, `claude-code`,
  mono `<metadata.ticket> · <metadata.branch>`, status chip right (yellow when
  awaiting); footer: reply textarea (↵ send, shift-↵ newline) + send btn;
  action bar (yellow #FEF6CC, 2px top border) when session.action set;
  permission requests render inline in chat as Allow/Deny buttons.
- **URL tab content**: iframe via proxy; if tab.compare set, host chrome strip
  above iframe with "compare to prod" toggle → swaps iframe src to /__compare.
- **Content tab**: rendered html (sandboxed iframe srcdoc) or markdown.
- **Launcher (main area when "+ New session")**: header "Start a session" +
  segmented [From a ticket | Empty session], ✕ closes.
  From a ticket: paste Linear URL/ID field + filter chips (Assigned to you/Recent/All)
  + ticket rows (priority glyph, mono id, title, status pill, project) from
  /__api/linear/tickets; right plan panel (332px): selected ticket summary +
  "Host will provision" list (worktree/branch/port/color — values produced by the
  default skill's plan, static text in v1) + yellow "Create session →".
  Creating: POST /__api/sessions {cwd: reposDir, metadata:{ticket}, prompt:
  bundled create-from-ticket skill invocation}. Progress strip renders from
  session.progress as the skill reports via set_progress.
  Empty session: name field ("Leave blank → scratch-N — renamed by host.set_title()"
  helper), cwd field (default from config), permission-mode select, "Create empty
  session →".
- **First-run**: no sessions → full-page launcher ("What are we building?" + paste field).
- Keyboard: `/` focus search, `cmd+1..9` switch sessions, `cmd+t` new tab popover.

## bin/host CLI

start | stop | restart | status | logs -f | doctor — same UX as PoC bin/host
(background, health check on /__api/config, pidfile in ~/.arigami/).

## Config (~/.arigami/config.json — extend PoC lib/config.js)

{ port: 3099, defaultCwd: '~/Desktop/repos', prodUrl, reposDir, linearWorkspace,
  palette, devServerPorts: [3020..3030] }
Secrets via existing lib/secrets.js (Keychain → secrets.env → env).

## Skills (skills/ — adapted from repos/.claude/skills.disabled + your-plugin plugin)

v1 bundles `create-from-ticket` (worktree-setup + ticket adapted): given ENG-xxxx →
set_title/set_color/set_metadata → set_progress steps (worktree → bun install →
dev server :302x → open) → open_tab Linear (/__ticket/ENG-xxxx), App
(localhost:302x via proxy, compare_url prod) → work the ticket → request_review().
Other skills (ship-it, feedback-loop, login…) copied + MCP-wired incrementally after v1.
Skills are made available to spawned sessions via --mcp-config + a settings dir
passed with --settings (skills/ mounted as a plugin dir or copied into cwd/.claude).

## Out of scope v1

Multi-user/auth, Tauri wrapper, tab drag-reorder, session pop-out windows,
mobile, Söhne fonts, claudecodeui code reuse (AGPL — inspiration only).
