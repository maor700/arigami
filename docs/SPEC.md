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
create_session({title?, cwd?, prompt?, permission_mode?, metadata?, needs_screen?}) → {id, url}
   // needs_screen: allocate this session's own desktop (Xvfb+VNC) up front
   // instead of lazily on the first request_screen/capture_screen/browser open.
list_sessions() → summaries
set_title({title, session_id?})       set_color({color, session_id?})
set_status({status, session_id?})     set_metadata({patch, session_id?})  // merge
set_progress({steps, session_id?})    // null/[] clears
open_tab({type:'url'|'content', title, url?, format?, body?, compare_url?, badge?, session_id?}) → {tab_id}
update_tab({tab_id, …same fields…})   close_tab({tab_id})   activate_tab({tab_id})
request_action({prompt, buttons:[{label,value,style?}], session_id?})
request_screen({prompt, reason?, hint?, session_id?}) → {ok, takenOver, note?}
   // reason: 'login'|'2fa'|'captcha'|'payment'|'other' (unknown → 'other')
   // hint: what exactly the human should complete. See "Screen share" below.
capture_screen({caption?, session_id?}) → {ok, url, ts, width?, height?} | {ok:false, error}
   // one frame of the shared desktop → `screenshot` chat card. See "Screenshots" below.
request_review({summary?, session_id?})   // sugar: status='In Review' +
   action {prompt: summary||'Claude finished — review the changes',
           buttons:[{label:'Request changes',value:'request-changes'},
                    {label:'✓ Verified',value:'verified',style:'primary'}]}
request_screen({prompt, reason?, hint?, session_id?}) → {ok, note?}
   // reason: login|2fa|captcha|payment|other. BLOCKS until the human clicks
   // Done in the live screen card (or 30 min timeout → note explains).
capture_screen({caption?, session_id?})   // screenshot card in the chat timeline (T3)
save_browser_logins({session_id?}) → {ok, synced}
   // sync this session's Chrome cookies/Login Data/Local Storage back to
   // ~/.arigami/chrome-base (T8). Automatic after a request_screen takeover
   // and at session delete — call directly to sync sooner.
permission_prompt(…)                  // internal: permission bridge (hidden from listing if possible)
```

Action-bar answers come ONLY from a human click in the UI.

## Screen share (server/vnc.ts, useScreenConnection.js, ScreenView.jsx, ScreenModal.jsx)

Two kinds of desktop, same wiring:
- **Global** (`config.screen.{vncHost,vncPort}`, default :99/5900) — set up
  outside this repo, always on; backs the rail footer icon and the WhatsApp
  bridge. Never allocated/killed by this server.
- **Per-session** (T8, `server/lib/desktops.ts`) — an `Xvfb`+`x11vnc` pair
  this server spawns for a session on first use (`request_screen`/
  `capture_screen`/opening a browser, or up front via `create_session`'s
  `needs_screen:true`), so two sessions driving a browser at once each see
  only their own window. Recorded in `session.metadata.screen = {display,
  vncPort}` — that IS the allocation table, a free port is just "not claimed
  by any live session's metadata.screen.vncPort" in `config.screen.portRange`
  (default 5901–5950; X display = `:100 + (port − portRange[0])`). Killed at
  archive/delete (`releaseDesktop`); delete also removes the Chrome profile
  copy (see "Chrome profiles" below). A failed allocation (binary missing,
  pool exhausted) isn't fatal — everything downstream falls back to the
  global desktop.

`ws(s)://<host>/__vnc?session=<id>` bridges to that session's own desktop if
it has one, else the global one (`server/lib/desktops.ts`'s `screenTarget()`);
`/__vnc` with no query is always the global desktop. The browser side is
noVNC behind one RFB connection **per desktop**
(`useScreenConnection.js`, keyed by sessionId — see its header comment): every
place that shows a GIVEN desktop registers as a consumer with a priority
(modal > card > panel); the highest-priority visible one hosts the real
canvas, the rest paint a mirror. `ScreenView`/`ScreenSidePanel`/
`ScreenRequestCard` pass their session's id; `ScreenModal` passes
`context.sessionId` (unset for the rail icon's plain global view).

**Three surfaces, one rule — input only ever happens in the modal:**
- **Chat card** (`ScreenRequestCard`, ChatPane.jsx) — small, view-only live
  view + reason chip + prompt/hint + **Cancel** / **Take over**.
- **Side panel** (`ScreenSidePanel.jsx`, desktop) — same content, view-only,
  same two buttons; its "enlarge" is a Take over while a request is open.
- **ScreenModal** (`ScreenModal.jsx`) — the ONE interactive view, mounted
  once in App.jsx from `store.screen.modal`. Opened from the rail icon
  (plain global view, `modal = {}`) or by Take over
  (`modal = {sessionId, requestId}`), in which case it shows the request's
  reason/prompt/hint, a "you are in control" banner and a footer with an
  optional note, **Cancel** and **Done**.
`store.screen.controlRequestId` marks the request currently taken over.

**request_screen flow** (`POST /__mcp/screen-request`, blocking like the
permission bridge; `SCREEN_REQUEST_TIMEOUT_MS`):
1. Agent calls `request_screen({prompt, reason?, hint?})`. Server appends a
   `screen-request` chat event `{requestId, prompt, reason?, hint?}`, sets the
   session to `awaiting-input` and starts the Watch-mode auto-snapshots.
2. The card (and side panel) show a **Watch** view — view-only, no input.
3. **Take over** → `openScreenTakeover()`: opens ScreenModal with the request
   context (fully interactive, the human drives the machine) and posts
   `POST /__api/sessions/:id/screen-request/mode {requestId, mode:'control'}`
   so the snapshot loop pauses — nothing is recorded while they type.
4. Inside the modal:
   - **Done** → `POST /__api/sessions/:id/screen-request/answer
     {requestId, takenOver:true, note?}`.
   - **Cancel** → same endpoint with `{takenOver:false, note:"cancelled by
     user"}` (the card shows "Cancelled"). Also available on the card / panel
     without opening the modal.
   - **Close** (X / Esc / backdrop) → `closeScreenTakeover()`: the modal
     closes, the request stays open (card still there, Take over reopens
     it) and `mode:'watch'` is posted so snapshots resume.
5. On answer the server appends `screen-request-answer`
   `{requestId, takenOver, note?}`, sets the session back to `working` and
   resolves the tool call with `{ok:true, takenOver, note?}`. `takenOver` is
   true only via the modal's Done. Timeouts and session death resolve with
   `takenOver:false` and an explanatory note; either also closes a takeover
   modal that was open for that request.
6. Once answered, the card freezes to a static line and unmounts the viewer
   (no lingering VNC connections in history).

**VNC password.** `config.screen.vncPassword` (or `ARIGAMI_VNC_PASSWORD`),
edited in Settings → Screen share. The UI writes it via
`PUT /__api/screen/settings {vncPassword}` (empty string clears) and only ever
reads `{hasVncPassword}`; `/__api/config` never returns it. noVNC does RFB
VNC-auth client-side, so on `credentialsrequired` the viewer fetches
`GET /__api/screen/credentials` → `{password}` and calls `sendCredentials`.
This endpoint sits behind the same trust boundary as `/__vnc` itself.

Other endpoints: `GET /__api/screen/status[?session=<id>] → {available, display?}`
(config enabled + TCP probe of that desktop's VNC port — the session's own if
allocated, else the global one; the sidebar icon calls it with no `session`).

## Chrome profiles (server/lib/chrome.ts, skills/_lib/chrome.sh)

A shared Chrome profile can't work across concurrent sessions (Chrome locks
`--user-data-dir`), but shared LOGIN STATE should. `~/.arigami/chrome-base/`
is the source of truth; `POST /__api/sessions/:id/browser {url?}` clones it
into `~/.arigami/chrome-sessions/<id>/` on first use (later calls reuse the
existing copy) and launches `google-chrome --user-data-dir=<copy>
--password-store=basic --no-first-run --start-maximized [url]` on that
session's `DISPLAY` (ensuring its desktop first) — supervised like any other
child (`server/lib/children.ts`), never killed by `pkill`. Agents use
`skills/_lib/chrome.sh [url]` rather than calling the endpoint directly.

**Sync back**, `Default/{Cookies,Login Data,Local Storage}` only (not
`Session Storage`, not saved passwords/autofill beyond what's in those two
SQLite files) copied from a session's profile copy over the base copy —
last-writer-wins, under a directory-mkdir lock
(`~/.arigami/chrome-base/.sync.lock`, non-blocking retry, stale after 10s) so
two sessions closing at once can't interleave writes. Triggered by: a
`request_screen` answer with `takenOver:true` (`answerScreenRequest` in
server/api.ts), session `DELETE` (before the profile copy is removed), and
on demand via the `save_browser_logins` MCP tool /
`POST /__api/sessions/:id/browser/sync-logins`.

**Cleanup.** `DELETE /__api/sessions/:id`: closes the session's Chrome, syncs
its profile back, then removes the copy — unless `config.screen.keepProfiles`
(default false) is set. Archive only kills the desktop; the profile copy
survives so unarchiving picks up where it left off.

## Screenshots (server/screenshots.ts, server/vnc.ts captureScreen, ScreenshotCard.jsx)

A timeline of what the agent did on the machine, as `screenshot` chat events
`{url, caption?, ts, width?, height?, auto?, requestId?, via}`.

**Capture.** `captureScreen()` opens a throwaway RFB 3.8 connection to the same
VNC server the bridge proxies (None / VNC-auth with `screen.vncPassword`),
requests one full Raw 32bpp framebuffer update and encodes it to PNG in-process
(`server/lib/png.ts`, no image deps). If that fails and `screen.display` is set
(`ARIGAMI_SCREEN_DISPLAY` / `$DISPLAY`), it falls back to `scrot` / ImageMagick
`import` on that X display. Files: `~/.arigami/uploads/screens/<session>/<ts>.png`,
served by `GET /__api/sessions/:id/screens/<file>`.

**Agent-driven.** `capture_screen({caption?})` → `POST /__api/sessions/:id/screenshot
{caption?}` → `{ok, url, ts}`; 503 `{ok:false, error}` when no screen is
available (the tool returns that instead of throwing, so the machine-work
skill can carry on without screenshots).

**Automatic (Watch mode).** While a `request_screen` is pending, the server
snapshots every `screen.snapshotIntervalMs` (default 10s; first one
immediately), tagged `auto:true, requestId`, skipping frames identical to the
previous one and downscaled 2× to save disk. Take over posts
`POST /__api/sessions/:id/screen-request/mode {requestId, mode:'control'}` and
the loop pauses — **nothing is recorded while the human drives** (privacy,
same rule as Operator); closing the modal without Done posts `mode:'watch'`
and it resumes. Answer / timeout / session death stop the loop. The chat shows
no "recording" indicator: auto-snapshots render like any other screenshot.

**UI.** `ScreenshotCard` renders one screenshot as thumbnail + caption + time
(click → lightbox with ←/→). ChatPane folds a run of consecutive `screenshot`
events into one card: a collapsed strip ("12 screenshots") that expands to the
full grid.

**Retention.** `screen.screenshotRetentionDays` (7) and `screen.screenshotMaxMb`
(200): files past the age are deleted, then oldest-first until under the size
cap. Swept ~5s after each capture and hourly.

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
  palette, devServerPorts: [3020..3030],
  screen: { enabled: true, vncHost: '127.0.0.1', vncPort: 5900, vncPassword?,
            display?, snapshotIntervalMs: 10000, screenshotRetentionDays: 7, screenshotMaxMb: 200,
            portRange: [5901, 5950], keepProfiles: false } }
`screen.*` is overridable via ARIGAMI_SCREEN_ENABLED / ARIGAMI_VNC_HOST /
ARIGAMI_VNC_PORT / ARIGAMI_VNC_PASSWORD; `screen.vncPassword` is the only
config key the UI writes back (Settings → Screen share).
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
