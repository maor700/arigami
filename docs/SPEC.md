# Arigami — v1 Specification

A web-shell cockpit for running many parallel agent sessions (Claude Code or Codex). Bun server on
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
    codex.ts       codex CLI driver (`codex exec --json`, one proc per turn) — docs/ENGINES.md
    proxy.js       fixed-origin reverse proxy (ported from iframe-host-poc)
    pages.js       host-internal pages ported from PoC: /__ticket/<id>, compare slider
    bus.js         WebSocket hub: every state mutation broadcasts {type, payload}
  mcp/
    host-mcp.js    stdio MCP server (thin shim → HTTP /__api); registered into
                   spawned sessions; scoped by ARIGAMI_SESSION_ID env
  web/             React + Vite + Tailwind shell UI (built → served at /__host/)
  skills/          SHIPPED skill pack (git-tracked, read-only at runtime — user/bundle
                   skills live in $ARIGAMI_DIR/skills and override these by name, see F2)
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
  | { id, type:'url', title, url, color?, badge? }      // proxied iframe
      // (`compare?: {url}` is dead: the vs-prod slider is an extension now,
      //  examples/extensions/compare — old state.json files still parse)
  | { id, type:'content', title, format:'html'|'markdown', body, badge? }
```

Persistence: JSON file `~/.arigami/state.json`, debounced writes. Chat history
is NOT duplicated — it lives in `~/.claude/projects` (claude owns it); the server
keeps an in-memory tail + last N per session in `~/.arigami/chat/<id>.jsonl`
for instant rehydration of the UI.

Session colors: palette `['#E0594F','#1F9C82','#6A4FC4','#2C6BD6','#CE8324','#3C9A4E','#C2459E','#5B62D6']`,
round-robin on creation.

## REST API (all JSON; behind the session cookie / internal bearer token — see docs/AUTH.md and docs/SECURITY.md)

```
GET    /__api/sessions                       → [session]   (?archived=true includes archived)
POST   /__api/sessions                       {title?, cwd?, prompt?, permissionMode?, metadata?} → session
                                              spawns claude in cwd; if prompt given, sends it as first message
GET    /__api/sessions/:id                   → session
PATCH  /__api/sessions/:id                   {title?|color?|status?|metadata?(merge)|progress?|archived?}
DELETE /__api/sessions/:id                   ?runCleanup=true → runs metadata.cleanup cmds first
POST   /__api/sessions                       {master, kind:'full', subtask?, worktree?:true|'<path>'|false, base?, branchPrefix?}
                                              F7: worktree (default true when subtask given) → host makes
                                              <reposDir>/<repo>-wt-<subtask> on <prefix>/<subtask>-<id> off base,
                                              stamps metadata.worktree/branch/base/cleanup, child cwd = worktree
GET    /__api/sessions/:id/merge/status      → {branch, base, approved, merged, conflict, canMerge, reason, dirtyFiles, ahead}   (F7)
POST   /__api/sessions/:id/merge             {strategy?:'no-ff'|'squash', deleteBranch?, runCleanup?, force?(admin)}
                                              → {ok, sha, hint} | 409 {conflict:true, files} | 409 {error, reason} | 403   (F7, host-executed)
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
GET    /__api/sessions/:id/artifacts         → [artifact]                (A1)
POST   /__api/sessions/:id/artifacts         {path, title, entry?, open?, notify?, share?, share_days?} → {artifact_id, path, version, bytes, files, warnings, share_url, share_exp}
DELETE /__api/sessions/:id/artifacts/:aid
POST   /__api/sessions/:id/artifacts/:aid/share {days?} → {share_url, path, exp, nonce, version, warnings}   (K2)
DELETE /__api/sessions/:id/artifacts/:aid/share → {revoked}                                                   (K2: every live link of the artifact)
GET    /__api/sessions/:id/artifacts/:aid/share → {tokens:[{nonce,exp,ver,label,createdAt}]}                 (K2)
GET    /__api/share/tokens                   → {tokens, defaultDays, maxDays, publicUrl}  (K2, admin: all live links, never the token itself)
DELETE /__api/share/tokens/:nonce            → {ok}                                       (K2, admin)
POST   /__api/share/revoke-all               → {revoked}                                  (K2, admin: rotates the secret)
GET    /__artifacts/:aid/[v<N>/]<file>        static snapshot (not JSON; CSP sandbox; `?t=<share-token>` or `/~t/<token>/` opens it cookie-less — K2)
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
  `ARIGAMI_SESSION_ID`, `ARIGAMI_URL=http://localhost:3099` — INTERNAL host→self
  base for the agent's API calls; never a link for humans — `ARIGAMI_PUBLIC_PATH=/__host/`,
  and `ARIGAMI_PUBLIC_URL` only when the operator set it). Links that leave the
  host toward a human are host-relative (`server/lib/public-url.ts`).
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

### Engines

`session.engine` is `claude` (this section) or `codex` (`server/codex.ts`), fixed at creation and
dispatched through `server/lib/engine-driver.ts`; both emit the same chat events. Differences and
limits: docs/ENGINES.md.

## Attachments (server/archive.js, claude.js saveAttachments/writeUserMessage — ZIP)

- **Two upload paths**, chosen client-side by size (`web/src/lib/attachments.js`,
  `STREAM_THRESHOLD = 8MB`): smaller files ride inline as base64 in
  `POST /__api/sessions/:id/message` (`attachments: [{name, type, dataBase64}]`,
  32MB JSON body cap); anything at/past the threshold streams first via
  `POST /__api/sessions/:id/attachments` (raw body + `Content-Type` +
  `X-Arigami-Filename` header, or `multipart/form-data` — a 200MB hard cap,
  `ARIGAMI_ATTACHMENT_MAX_BYTES` env override for tests) and returns a
  descriptor `{name, path, type, size, isImage, archive?}`; the composer then
  sends `{name, type, path}` in the `.../message` call instead of resending
  bytes. Saved files live under `$ARIGAMI_DIR/uploads/<sessionId>/`.
- **Archive extraction.** `saveAttachments` sniffs every saved attachment by
  magic bytes (never the extension) for zip / tar / tar.gz / tgz and, on a
  match, extracts next to the original file into `<file>.d/` via the hardened
  extractor in `server/archive.js`, writing a `<file>.manifest.json` sidecar.
  The extractor is central-directory-driven for zip (never trusts a local
  header's size/method) and rejects, per entry: path traversal (`..`,
  absolute paths), symlinks, encrypted entries, and anything past
  `MAX_ENTRIES` (2000), `MAX_ENTRY_UNCOMPRESSED` (100MB),
  `MAX_TOTAL_UNCOMPRESSED` (200MB), or `MAX_COMPRESSION_RATIO` (100:1,
  zip-bomb guard) — zlib's `maxOutputLength` enforces the last two without a
  manual byte-counter. Rejected entries are skipped, not fatal; a
  structurally corrupt archive throws (the original file is kept either way).
- **What the model sees.** Instead of one opaque path, the injected
  `📎 Attached N file(s)` line gives an archive its own block: the extraction
  dir, entry/rejected counts, total size, a short tree (first 40 entries then
  `+N more`, `formatTree()`), and up to 10 rejected entries with their reason
  code. Non-archive attachments still get a plain `- name → path` line;
  images are still embedded as image blocks when their bytes are available
  (base64 path only — a streamed image has a path but no inline bytes).
- **UI.** The composer chip shows upload progress while streaming, a 📦 icon
  + entry/rejected counts once an archive extracts (dir on hover), or the
  upload error if it failed; Send is disabled mid-upload and refuses (with a
  toast) while a failed attachment is still in the draft. The persisted chat
  bubble (`ChatPane.jsx`) shows the same 📦 + entry count.

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
open_tab({type:'url'|'content'|'ext', title, url?, format?, body?, badge?, ext?, tab?, params?, session_id?}) → {tab_id}
// `compare_url`/`compare` are gone — the vs-prod slider is examples/extensions/compare
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
publish_artifact({path, title, entry?, open?=true, notify?=false, share?=false, share_days?, session_id?})
   → {artifact_id, path:'/__artifacts/<id>/', version, bytes, files, warnings[], share_url:string|null, share_exp}
render_ui({ui, title?, session_id?}) → {ok, event_id}                                     (OPENUI pilot)
   // POST /__api/sessions/:id/ui — one `{kind:'openui', ui}` chat event. `ui` is
   // OpenUI Lang (skills/render-ui/SKILL.md, generated from web/src/openui/library.jsx);
   // the web card (OpenUICard.jsx) renders it with @openuidev/react-lang and shows a
   // quiet fallback on bad input. Button/Form actions POST …/message like an ext-card.
share_artifact({artifact_id, days?, session_id?}) → {share_url, expires_at, version, warnings[]}   (K2)
unshare_artifact({artifact_id, session_id?})      → {revoked}                                        (K2)
   // Snapshot a static file/folder and serve it host-relative (A1). NEVER print
   // localhost URLs — show `path` or rely on the chat card. Re-publish of the
   // same path → next version, same id. share:true → K2 (null until then).
save_browser_logins({session_id?}) → {ok, synced}
   // sync this session's Chrome cookies/Login Data/Local Storage back to
   // ~/.arigami/chrome-base (T8). Automatic after a request_screen takeover
   // and at session delete — call directly to sync sooner.
permission_prompt(…)                  // internal: permission bridge (hidden from listing if possible)
memory_write({target:'user'|'memory'|'journal', action:'add'|'replace'|'remove', content?, old_text?, session_id?})
   // Arigami's own memory ($ARIGAMI_DIR/memory/) — shared by every session/worker
   // on this instance, NOT Claude Code's per-project auto-memory. See "Memory" below.
memory_search({query, scope?:'user'|'memory'|'journal'|'episode', limit?}) → {hits:[{path,scope,snippet,updatedAt}]}
memory_get({path}) → {path, content} | {error}
skill_propose({name, content?, patch?, rationale, evidence?, session_id?}) → proposal | {error}
   // Stages a skill change/creation for human review — NEVER writes skills/ directly
   // (and on apply, only ever $ARIGAMI_DIR/skills — see "Skill roots").
   // See "Skill proposals" below. report_to_master accepts an optional
   // skill_proposal_id to point the master at a proposal filed this task.
```

merge_session({session_id, strategy?:'no-ff'|'squash', delete_branch?}) → {ok, sha, hint} | {conflict, files} | error   (F7)
   // Masters/controllers only (the child itself gets 403). See "Merge after approval".

Action-bar answers come ONLY from a human click in the UI.

## Merge after approval (F7 — server/merge.ts, MergeCard.jsx)

Responsibility is fixed and never ambiguous:

1. **The child never merges.** A full child (or dispatch worker) works on the
   branch the host made for it (`metadata.branch` in `metadata.worktree`), commits,
   and ends with `request_review` / `report_to_master`.
2. **The human approves.** A local review verdict `approve` (Changes tab) or the
   `✓ Verified` button of `request_review` on a session whose `metadata.branch` ≠
   base stamps `metadata.review = {state:'approved', at, by}` (broadcast as a
   normal `session-updated`). Nothing else can stamp it.
3. **After approval the merge is one click for the human OR one tool call for the
   master/PM** — `POST /__api/sessions/:id/merge` (web: the Merge button on the
   review panel / Changes tab / master's Orchestration card) or `merge_session`.
   The HOST runs the git merge in the base checkout (the master's worktree/cwd,
   else the repo's main worktree): `git merge --no-ff` (or `--squash` + commit)
   with a generated message. It refuses when the base checkout has tracked
   modifications, when `base` is not what is checked out there, or when the
   branch is not approved (`force:true` is admin-only). On a conflict it aborts,
   records `metadata.mergeConflict = {files, at}`, posts a `{kind:'merge',
   state:'conflict'}` chat card to the child AND the master ("merge conflict —
   resolve"), and returns `{conflict:true, files}`. On success it records
   `metadata.merged = {sha, at, by, strategy, base}` and appends a
   `{kind:'merge', state:'merged'}` card to both.
4. **Merge runs no project gates.** The response carries `hint`: run tsc / tests /
   build on the base, then push. That is the merger's job (the PM after
   `merge_session`, the human after the click).
5. `deleteBranch` / `delete_branch` runs the session's recorded cleanup after a
   successful merge (worktree removed first — a checked-out branch cannot be
   deleted). Deleting the session with `runCleanup=true` does the same.

Web: `metadata.review.state==='approved' && !metadata.merged` renders the Merge
panel (strategy select · "delete branch & worktree" · Merge, disabled with the
host's `reason` when it can't merge) at the end of the chat and above the
Changes diff; the Changes header shows an "Approved · not merged" / "Merged
<sha>" / "Merge conflict" pill; the master's Orchestration cards show the same
pill for each child.


## Memory (server/memory.ts — $ARIGAMI_DIR/memory/)

Arigami's own memory, owned by the host — separate from Claude Code's
per-project auto-memory (untouched). Scoped **per-instance** (`$ARIGAMI_DIR`,
T5), not per-cwd/worktree: every session and every dispatch worker on this
instance reads and writes the same store, so a worker spawned into a fresh
`git worktree` still sees what the master already knows.

Two layers, same shape as the Hermes/OpenClaw comparison in
`RESEARCH-ARIGAMI-BRAIN.md`:
- **Capped snapshot** — `USER.md` (facts about the human, ~600 token cap),
  `MEMORY.md` (standing facts/decisions, ~900 token cap). `getMemoryBootstrap()`
  is injected once, as a frozen `<system-reminder>` block, into a session's
  very FIRST turn only (`server/claude.js`'s `writeUserMessage`, gated on
  `!p.resume && !p.sent.length`) — never mid-conversation, to keep the
  prompt-cache prefix stable. A `--resume`d proc already has it in history.
- **Unbounded on-demand search** — `journal/YYYY-MM-DD.md` (append-only,
  what happened today) and `episodes/*.md` (session summaries), all indexed
  with FTS5 (`bun:sqlite`, file-granularity rows, `tokenize='trigram'`).
  Trigram (substring, not whole-token) indexing is deliberate: Hebrew glues
  single-letter prefixes (he/vav/bet/lamed/mem/shin/kaf — roughly "the/and/in/to/from/that/as")
  directly onto the next word with no boundary, so the FTS5 default
  (`unicode61`, whole-token) tokenizes "ha-sodi" ("the-secret", one glued token)
  as one token a query for the bare "sodi" ("secret") alone can never match — trigram
  matches it as a substring like any other language, no hand-maintained
  prefix-letter list needed (M1b). A DB created before this fix self-heals in place (drop +
  full re-scan from disk) the first time `memory.ts`'s `db()` runs after
  upgrade — detected via `sqlite_master`, not a separate migration step.
  Ranking: FTS5 `rank` (bm25) first, then a hit containing the whole query as
  one contiguous run is promoted above hits that only satisfy each term
  scattered separately. Zero token cost until `memory_search` is actually
  called; snippets capped ~700 chars. Trade-off: queries under 3 characters
  can't match anything (inherent to trigram).

**Gate** (spec "closed-first" — start closed): every write to
USER.md/MEMORY.md/journal is (1) `sanitize()`d against credential-shaped
strings, prompt-injection phrasing, and exfiltration patterns — refused
outright, not stored; (2) deduped against existing lines (normalized,
case/whitespace-insensitive); (3) capped — `add`/`replace` are refused if the
result would exceed the target's token budget; (4) logged append-only to
`memory/.log.jsonl` with a full before/after snapshot, undoable via
`POST /__api/memory/log/:seq/undo`. journal is append-only (`add` only).

A live agent's own `memory_write` calls land **immediately** (still gated +
logged) — spec decision: direct writes from an in-conversation agent are
trusted the same as any other tool call. **Autonomous** extraction is
different: `runEpisodeHook(sessionId, trigger, transcript)` (fired
fire-and-forget from `report_to_master` and session-archive in
`server/api.ts`, 2-minute cooldown per session so the two don't double-fire)
runs one `claude -p` headless call — same pattern as `skills.ts`'s
`analyze()` — over a bounded chat transcript excerpt, writes an `episodes/*.md`
summary directly (harmless, additive, never touches USER/MEMORY), and
`proposeFacts()`s up to 3 candidate facts into `memory/pending.json` as
`status:"pending"`. Nothing an autonomous hook proposes reaches
USER.md/MEMORY.md until a human calls
`POST /__api/memory/pending/:id/approve` (`reject` discards it).

```
GET  /__api/memory                         → {files:[{path,scope,tokens,updatedAt}], bootstrap:{userMd,memoryMd}}
POST /__api/memory/write                   {target,action,content?,old_text?,source?,sessionId?}
GET  /__api/memory/search?query=&scope=&limit=
GET  /__api/memory/get?path=
GET  /__api/memory/log?limit=
POST /__api/memory/log/:seq/undo
GET  /__api/memory/pending
POST /__api/memory/pending/:id/approve
POST /__api/memory/pending/:id/reject
```

**Migration** (one-time, manual, spec M1.6): `bun scripts/migrate-claude-memory.ts`
reads Claude Code's own auto-memory files for the general "repos" workspace
project (`~/.claude/projects/-home-arigami-repos/memory/*.md`, predates this
store) and proposes each one's `description` as a `pending` fact via
`proposeFacts()` — it never writes USER.md/MEMORY.md directly, same gate as
the episode hook.

**M2 contract:** `getMemoryBootstrap()` is the agreed hook M2's cron
(`server/triggers.ts`, isolated-session runs) calls to load the same snapshot
into a scheduled session — memory.ts doesn't know about cron at all.

## Skill roots (server/skills.ts — F2: repo `skills/` vs `$ARIGAMI_DIR/skills`)

Two roots, merged by name:

| root | path | written at runtime? | sessions see it as |
|---|---|---|---|
| **shipped** | `<repo>/skills` (git-tracked) | **never** | `--plugin-dir <repo>` → `/arigami:<name>` |
| **user** | `$ARIGAMI_DIR/skills` (`USER_SKILLS_DIR`) | yes — the ONLY writable root | `--plugin-dir $ARIGAMI_DIR/user-plugin` → `/arigami-user:<name>` |

A user skill with the same name as a shipped one **overrides** it: `listSkills`
lists each name once with `source: 'shipped' | 'user'` (+ `overridesShipped`),
`readSkill`/`skillDir`/`buildSkillPrompt` resolve to the user copy, and the
graph cache hash covers the effective set. The Skills UI shows the source as a
badge (`shipped` / `user` / `override`).

**Every write path lands in the user dir** — `writeSkill` (human editor
`PUT /__api/skills/:name`), skill-proposal `apply`, and profile-bundle apply
(`server/profiles.ts` routes through proposals). Editing/applying against a
*shipped* skill therefore creates an **override copy** under
`$ARIGAMI_DIR/skills/<name>/` (SKILL.md + the shipped supporting files copied
along so `$SKILL_DIR` stays self-contained); the shipped file and the git tree
are untouched. Deleting the override directory reverts to the shipped copy.
Before F2 a bundle apply copied skills into the repo checkout, which polluted
a live `git status` (`skills/daily-standup/` untracked) — hence the rule.

**Sessions:** Claude Code discovers skills only through `--plugin-dir`, so
`ensureUserPlugin()` generates `$ARIGAMI_DIR/user-plugin/` = `.claude-plugin/
plugin.json` (name `arigami-user`) + a `skills` symlink → `$ARIGAMI_DIR/skills`,
and `server/claude.js` passes it as a second `--plugin-dir` for both the
interactive session and the headless (`runHeadless`) spawn. It's regenerated
on every `writeSkill` and at spawn time, so no restart is needed after an
apply. The plugin namespace is the one place the override is *not* merged:
a user copy of a shipped skill is listed as both `/arigami:x` (shipped) and
`/arigami-user:x` (override) — `$ARIGAMI_USER_SKILLS` is exported next to
`$ARIGAMI_SKILLS` so skills/scripts can prefer the user path.

## Skill proposals (server/skill-proposals.ts — $ARIGAMI_DIR/skill-proposals/)

Spec M3. Skills (`skills/*/SKILL.md`) are git-tracked and shared by **every**
session on this instance — a bad autonomous edit here hurts everyone, not
just the agent that made it (higher blast radius than memory, per
`RESEARCH-ARIGAMI-BRAIN.md` §1.3/M3). So unlike memory's "direct writes land
immediately, gated" model, skills get **no direct-write path at all**: the
`skill_propose` MCP tool can only stage a proposal; only a human
apply/reject/quarantine decision ever touches `skills/`. This follows
OpenClaw's Skill Workshop staging pattern, not Hermes's open-by-default
`write_approval:false` — and specifically fixes the failure mode
Hermes issue #70128 documented (a skill changed with no diff shown, nothing
to review or revert): `getProposal()` always recomputes the diff against the
skill's **current** content, so a human reviewing later — even if the live
skill moved since the proposal was filed (`stale:true`) — sees an accurate
before/after, never a stale one.

**Storage**, one directory per proposal (id `skp_<...>`):
```
$ARIGAMI_DIR/skill-proposals/<id>/
  meta.json     — status/flags/rationale/evidence/etc (source of truth)
  PROPOSAL.md   — the same thing, human-readable
  base.md       — snapshot of the target's SKILL.md when proposed ('' if new)
  content.md    — the full proposed SKILL.md text (what apply() writes verbatim)
  diff          — unified diff, base.md → content.md, as computed at propose time
$ARIGAMI_DIR/skill-proposals/.audit.jsonl   — append-only: propose/apply/reject/quarantine
```

**Diffing** is hand-rolled (no external dep) — an O(n·m) LCS over lines,
emitted as a single unified-diff hunk (skill files are small; a pathological
size falls back to a whole-file replace rather than spending seconds on the
DP table). `applyUnifiedDiff()` is the inverse, for `skill_propose`'s `patch`
form — it validates every context/deleted line actually matches before
applying, refusing (not silently corrupting) on a mismatch.

**Flow:**
1. `skill_propose({name, content?, patch?, rationale, evidence?})` — `name`
   existing = an edit, `name` new = a creation. `content` (full new SKILL.md
   text) is the reliable path; `patch` (unified diff against current/empty
   content) is refused with an error if it doesn't apply cleanly, telling the
   caller to pass `content` instead. Refused outright if identical to the
   current skill, or missing YAML frontmatter. A basic heuristic scan
   (`scanSkillContent`) — curl/wget-pipe-to-shell, credential-shaped strings,
   markdown-image/fetch exfiltration patterns, hidden HTML comments (the
   documented ToxicSkills/OpenClaw backdoor technique — invisible on GitHub's
   renderer) — sets `flags[]` on the proposal. **Flags never block staging or
   apply** — they're surfaced to the human, who still decides.
2. Human reviews in the Skills UI's **Proposals** tab (badge = pending count):
   rationale, evidence, flags, and the live diff.
3. `apply` → `writeSkill(name, content, {allowCreate:true})` — the same
   validated write `skills.ts` already used for the human editor (frontmatter
   + `description` required), with a new `allowCreate` escape hatch that
   **only** this path sets; the human-editor's `PUT /__api/skills/:name`
   still never creates a new skill. `reject`/`quarantine` just record a
   decision (+ optional `reason`) — neither ever touches `skills/`.
   Terminal once decided (`pending → applied|rejected|quarantined`, no
   re-deciding).

**When to propose** (spec M3.3 — explicit, not a background habit): a
"retro" reflection step at the end of the `machine-work`, `dispatch`, and
`project-manager` skills — "did you learn something a future run should
know?" — not a periodic background fork (Hermes's every-10-turns
self-review was explicitly rejected as a v1 pattern, see RESEARCH.md §1.3).
`report_to_master` accepts an optional `skill_proposal_id` so a worker can
point its master at a proposal it filed.

```
GET  /__api/skill-proposals                → ProposalSummary[]
POST /__api/skill-proposals                {name,content?,patch?,rationale,evidence?,sessionId?}
GET  /__api/skill-proposals/:id            → ProposalDetail (content, live diff, stale)
POST /__api/skill-proposals/:id/apply
POST /__api/skill-proposals/:id/reject     {reason?}
POST /__api/skill-proposals/:id/quarantine {reason?}
```

## Brain (server/brain.ts — the singleton "second brain" session + heartbeat)

Spec M4. A thin layer over M1–M3 (memory, cron, skill proposals) — no new
subsystem, no new storage. Two pieces:

**1. The singleton session.** One `metadata.kind:'brain'` session per
instance (`findBrainSession()`/`ensureBrainSession()`), created on first use
via the same `startEmptySession()` every ordinary session goes through — it
just gets a fixed first prompt (`BRAIN_SYSTEM_DIRECTIVE`) that establishes its
identity and toolset (`memory_search`/`get`/`write`, `cronjob`,
`create_session`, `list_sessions` — all shipped in M1–M3, nothing new). Since
it's an ordinary session, USER.md/MEMORY.md are already prepended to that same
first turn by `claude.js` (M1.3) — the directive doesn't repeat that content.
If the found session is archived, `ensureBrainSession()` un-archives it rather
than creating a second one. `POST /__api/brain/session` (find-or-create) backs
the Brain tab's "Ask the brain →" button, which just jumps to the session like
any other (`host:select-session`) — no embedded chat engine.

**2. The heartbeat** (`brain.heartbeatEnabled`/`heartbeatEvery` in config,
default `{false, '30m'}`). Toggling it on/off creates/removes a single
`type:'cron'` trigger named `"Brain heartbeat"` (`sessionMode:
'existing:<brainSessionId>'`, `schedule:{kind:'interval', value:every}`,
`deliver:{push:true}`) via the same `triggers.ts` API a session could call
itself — `setHeartbeat()` finds-or-creates that one trigger idempotently
rather than stacking duplicates. The prompt (`HEARTBEAT_PROMPT`) tells the
brain session to check memory/journal/cron for anything worth surfacing and
always call `report_to_master`: a real summary if something needs attention,
or `summary:'[SILENT] NO_REPLY'` if not — reusing `deliverCronResult`'s
existing `[SILENT]`-suppression (M2) so a quiet heartbeat never pushes.

This required one correctness fix to `triggers.ts`'s `'existing'` session
mode, which previously had no report-back path at all: `fireCron` now tags
the delivery target with `metadata.cronTriggerId`/`cronTriggerName`/
`cronDeliver` (same fields the `'isolated'` branch already set at spawn time)
so a later `report_to_master` call from it correlates back to the trigger; and
`onCronReport`'s archive decision now checks `sessionMode === 'isolated'`
before ever archiving — an `'existing'` target **pre-existed** the fire (it's
not something the cron spawned), so it must never be archived out from under
itself just because it reported a terminal state. This also fixes the same
latent bug for any other `'existing'`-mode cron a session sets up by hand.

```
GET  /__api/brain                → { sessionId, heartbeat: {enabled, every, triggerId} }
POST /__api/brain/session         (find-or-create) → { id, created }
PUT  /__api/brain/heartbeat       {enabled, every?} → {enabled, every, triggerId}
```

**UI** (`BrainView.jsx`, a sidebar tab next to Skills/Triggers): Memory tab
(inline bullet-level edit of USER.md/MEMORY.md via `memory_write`
add/replace/remove, search, journal, episodes, and the change log with
per-entry undo), Pending tab (approve/reject queued facts, badged), Cron tab
(embeds `Launcher.jsx`'s exported `CronSubPanel` — not duplicated), Proposals
tab (embeds `SkillsView.jsx`'s exported `ProposalsPane` — not duplicated). The
heartbeat on/off + interval toggle lives in Settings (`BrainHeartbeat`,
mirroring the `ScreenShare`/`PushNotifications` toggle pattern), not in the
Brain tab itself.

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
  (default 5901–5950; X display = `:displayBase + (port − portRange[0])`,
  skipping displays/ports something else already holds — see "Instances"). Killed at
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
  scoped to `session.id` (T8: that session's own desktop, not the global
  one). Its "enlarge" is a Take over while a request is open, otherwise
  `setScreenModal({sessionId: session.id})` — the same session's machine,
  just full-size (T8c: NOT the global one — only the rail footer icon opens
  that).
- **ScreenModal** (`ScreenModal.jsx`) — the ONE interactive view, mounted
  once in App.jsx from `store.screen.modal`. Three shapes: `modal = true`
  (rail icon → normalized to `{}`, the genuinely global desktop — no
  sessionId), `modal = {sessionId}` (side panel enlarge — that session's
  machine, plain interactive view, no Done/Cancel footer since there's no
  request to answer), or `modal = {sessionId, requestId}` (Take over — same
  as `{sessionId}` plus the request's reason/prompt/hint, a "you are in
  control" banner and a footer with an optional note, **Cancel** and
  **Done**). `context?.sessionId` (undefined for the plain `{}` global case)
  is threaded straight to `ScreenView`/`useScreenConnection`.
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
`--user-data-dir`), but shared LOGIN STATE should. `$ARIGAMI_DIR/chrome-base/`
is the source of truth; `POST /__api/sessions/:id/browser {url?}` clones it
into `$ARIGAMI_DIR/chrome-sessions/<id>/` on first use (later calls reuse the
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

## One chat UI system (web/src/openui/) — OPENUI

Every chat card — host cards and agent `render_ui` blocks — is built from the same primitives
(`primitives.jsx`: CardFrame/Btn/ReceiptLine/…) and defined the same way (`{name, props: zod, description,
component}`). Two views of one library: `library.jsx` is the AGENT set (what `render_ui` may use; its prompt is
`skills/render-ui/SKILL.md`); `define.js` + `host.jsx` add the HOST-ONLY cards (ExtCard, ActionCard, ArtifactCard,
ScreenshotCard, AgentCard, DelegatedLine, AgentAdoptLine, MergeEvent, MergePanel, SetupCard, QuestionCard,
PermissionCard, ScreenRequestCard). ChatPane renders host events through `HostCard` (event → props, zod-checked,
loose: unknown keys pass) — never through the text Renderer, since host events are already structured and the
cards keep their store/api handlers, focus and keyboard rules. Host names are absent from the agent library and
prompt, so a `render_ui` block naming one gets "unknown component" (test/openui-host-cards.test.js).
The full react-lang library object (`getHostLibrary()`) is materialized lazily; the eager path costs zod/mini +
primitives only, the parser stays in the lazy OpenUIBody chunk. Fixture page: web/host-demo.html.

## Artifacts (server/artifacts.ts, ArtifactCard.jsx) — A1

`publish_artifact({path,title,entry?,open?,notify?})` → `POST /__api/sessions/:id/artifacts`.
The host **copies** (never symlinks) the file/folder to
`$ARIGAMI_DIR/uploads/artifacts/<session>/<artifactId>/v<N>/` — realpath on the
source, symlinks inside the tree skipped, `node_modules/`, `.git/`, `.env*`
excluded, whole-version cap `artifacts.maxMb` (50), sources under
`$ARIGAMI_DIR` refused (except `uploads/`). Re-publishing the same source path
from the same session yields `v<N+1>` under the same id; the record lives on
`session.artifacts[]` (survives restart and archive), old versions stay
reachable at `/__artifacts/<id>/v<N>/` until `artifacts.retentionDays` (30)
GCs them (the newest version is never swept while the record exists).

**Serving.** `GET /__artifacts/<id>/` → the entry of the current version;
`/__artifacts/<id>/v<N>/…` pins a version. Traversal-guarded (normalize +
prefix-with-separator, `..`/`.` segments rejected, symlink targets refused),
`X-Content-Type-Options: nosniff`, `Cache-Control: no-store` for HTML /
immutable for the rest, and
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https:; …`
(no `allow-same-origin` → opaque origin: a published page cannot read cookies,
localStorage, or call `/__api` as the cockpit — document this to agents). The
route sits in `server/index.ts` before `handlePage`/proxy and in the Service
Worker SKIP list (`/__artifacts`, `/__preview`). If the entry HTML has no
`<base>`, one pointing at the pinned version dir is injected; root-absolute
`src="/…"` / `fetch('/…')` in the entry produce `warnings[]` (build with
`base:'./'`).

**Chat + tabs.** A `{kind:'artifact', artifactId, title, path, entry, version,
bytes, files, warnings}` event → `ArtifactCard` (open in tab / open in window
[hidden until `config.auth.mode!=='off'`, C1] / copy link = `location.origin+path`).
`open!==false` opens (or re-activates) a URL tab whose iframe gets
`sandbox="allow-scripts allow-forms allow-popups"` when the url starts with
`/__artifacts/`. `notify:true` sends a push with the RELATIVE `url` — the SW
resolves it on whatever origin the device uses. The agent only ever sees the
host-relative `path`; every absolute link is assembled client-side.

## Share links (server/share-token.ts, artifacts.ts share/unshare) — K2

A share link is a **capability**: `/__artifacts/<id>/?t=<token>` opens ONE
artifact at ONE version (the one current when the link was minted) with no
cookie and no access to anything else. `publish_artifact({share:true})`,
`share_artifact`, `POST …/artifacts/:aid/share` and the card's **Share link**
button all call `artifacts.share()`.

**Token.** `base64url(JSON{kind,id,exp,nonce,ver?}) + '.' + base64url(HMAC-SHA256)`
over a per-instance secret `$ARIGAMI_DIR/share-secret` (32 random bytes, 0600,
auto-generated). `verify(token,{kind,id})` compares the MAC with
`timingSafeEqual` BEFORE parsing the payload, then checks kind+id, expiry and
the revocation list `$ARIGAMI_DIR/share-revoked.json` (nonce → exp, GC'd once
the token would have expired anyway). `kind` is `'artifact'` today and
`'webhook'` for C3 — same module, same secret, `id` = webhook name. Expiry:
`share.defaultDays` (7), capped at `share.maxDays` (90). An issued registry
`$ARIGAMI_DIR/share-tokens.json` keeps `{nonce,kind,id,exp,ver,label}` — never
the token — so the admin list works and a leaked file leaks no link.
`revokeAll()` rotates the secret (every token ever minted dies).

**Gate.** `auth.gate()` consults `artifacts.shareGate` only when the request
has NO principal and targets `/__artifacts/…`. A valid token sets `req.share`
(`{aid, version, nonce, exp}`) — never `req.auth` — so `/__api`, `/__ws`, pages
and the proxy stay 401 in the same browser. Invalid/expired/revoked/wrong-id →
401 "Link expired" page. `artifacts.serve()` then pins the grant: a bare path
gets `v<ver>/` prepended, an explicit different `v<N>/` is 403, another id is 403.

**Sub-resources.** The entry HTML's injected `<base>` would make assets load
without the token, so under a grant the base is rewritten to the **path form**
`/__artifacts/<id>/~t/<token>/v<N>/` (`rewriteBaseForShare`); `parseArtifactUrl`
strips `~t/<token>` and the same verification applies. `Referrer-Policy:
no-referrer` keeps the token out of outbound referers.

**URL shape.** `share_url = publicUrl(path + '?t=' + token)` — absolute only
when `ARIGAMI_PUBLIC_URL` is set; otherwise host-relative plus a warning ("set
ARIGAMI_PUBLIC_URL for external sharing"). The card always shows an absolute
link (`location.origin + url`). The artifact record carries
`shareExp/shareNonce/shareVersion` of the latest link. Re-sharing after a
re-publish mints a link to the new version; earlier links keep showing their
pinned version until they expire or `unshare` revokes all links of the artifact.

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
skill can carry on without screenshots). **When** (T9, machine-work skill):
only the required moments — first page loaded, right before `request_screen`,
right after it returns (verify), and the end / a failure — plus any frame the
agent itself needs to see to decide. Not after every step.

**Dedup (T9).** The server keeps the last recorded frame per session. A
capture whose sampled-pixel diff vs. that frame is ≤ `screen.snapshotChangeThreshold`
(0.03) is not written and adds no card: the tool gets
`{ok, duplicate:true, url:<previous>, ts}`. (x11 fallback path: byte-identical
PNG.) `frameDiffRatio()` in `server/lib/png.ts`, `judgeFrame()` in
`server/screenshots.ts`.

**Automatic (Watch mode).** **Off by default** — `screen.autoSnapshots`
(`ARIGAMI_AUTO_SNAPSHOTS=1`). When on, while a `request_screen` is pending the
server looks at the screen every `screen.snapshotIntervalMs` (10s) but records
a frame only if it changed materially (same threshold as dedup) **and** at
least `screen.snapshotMinIntervalMs` (30s) passed since the last recorded one;
recorded frames are tagged `auto:true, requestId` and downscaled 2×. Take over
posts `POST /__api/sessions/:id/screen-request/mode {requestId, mode:'control'}`
and the loop pauses — **nothing is recorded while the human drives** (privacy,
same rule as Operator); closing the modal without Done posts `mode:'watch'`
and it resumes. Answer / timeout / session death stop the loop.

**UI.** `ScreenshotCard` renders one screenshot as thumbnail + caption + time
(click → lightbox with ←/→). ChatPane folds a run of consecutive `screenshot`
events — auto or manual, with nothing but the `capture_screen` tool rows in
between — into one card: a collapsed strip ("12 screenshots") that expands to
the full grid. The `capture_screen` tool-use/tool-result rows themselves are
hidden (the card is the tool's visible output); a failed call still shows its
tool-result.

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
| a cron trigger's isolated run reports (M2, `deliver.push`) | `POST /__api/sessions/:id/report` → `triggers.onCronReport` → `deliverCronResult` | `<cron job name>` (+ ` — <state>` on blocked/error) | the run's `summary`/`note`, `[SILENT]` prefix stripped |

Rules (`pushIntervention` in `server/api.ts`; cron's own `deliverCronResult` in
`server/triggers.ts` follows the same shape but isn't gated by the 15s cooldown
— a cron job fires far less often than a stuck agent retries):
- `tag` = `<kind>:<sessionId>` — the OS collapses repeats for the same session
  into one notification; `url` deep-links to the session and the service
  worker's `notificationclick` navigates there. Cron's tag is `cron:<jobId>`.
- Per session + kind cooldown of 15 s: a burst (e.g. an agent retrying
  `request_action`) does not buzz the phone repeatedly.
- Best-effort, fire-and-forget: no subscriptions or a push failure never fails
  the underlying request. `title` ≤ 80 chars, `body` ≤ 200.
- Status changes (`set_status`, `set_progress`, milestones) never push.
- Cron's SUCCESS push is suppressed when the reporting run's `summary`/`note`
  starts with `[SILENT]` — failures (`error`/`blocked`) always push regardless.

Agent-side convention for browser / desktop work — opening line, `capture_screen`
after each significant step, `request_screen` with `reason`+`hint` when blocked,
verify after Done, summary at the end — lives in `skills/machine-work/SKILL.md`.
Every skill that drives a browser should point to it.

## Proxy (server/proxy.js — ported from iframe-host-poc/server.js)

Keep verbatim behavior: per-tab targets via Service Worker (x-poc-target),
?__target= pinning, Location/Set-Cookie rewrites, WebSocket upgrade proxying,
Vercel bypass header, gzip handling. Strip: card overlay injection, old chat
relay, responder supervisor (replaced by claude.js). Keep host pages: /__ticket/<id>
(Linear renderer incl. GitHub PR view), /__ticket-img. (/__compare, the vs-prod
slider, has since moved out of the core into examples/extensions/compare.)
URL tabs iframe `http://localhost:3099/?__target=<url>` (SW per-iframe-client
targeting works as it does for PoC tabs today; each iframe is its own SW client).

## Web UI (web/ — React + Vite + Tailwind v4)

Light theme: yellow #F9D312 = host chrome accent, neutral surfaces,
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
- **URL tab content**: iframe via proxy. (The "compare to prod" toggle this line
  described is gone from the core — it is examples/extensions/compare, a trusted
  extension tab.)
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

## Instances (T5 — server/lib/instance.ts, hostlock.ts, children.ts)

One host == one **identity** = `ARIGAMI_DIR` (default `~/.arigami`) + port.
Every file, child process, port and X display the host creates or kills
belongs to that identity and nothing else — a second instance on the same
machine can't affect the first.

- **Single path root.** `server/lib/instance.ts` exports `ARIGAMI_DIR`;
  config.json, state.json, chat/, uploads/ (attachments + screens), children.json,
  run/host.{pid,json}, chrome-base/, chrome-sessions/, vapid-keys.json,
  sms.jsonl, secrets.env, *.json stores all live under it. Nothing in `server/`
  or `mcp/` spells out `~/.arigami` except `instance.ts` (enforced by a test).
  A config.json copied from the default instance whose `stateFile`/`chatDir`
  point into `~/.arigami` is remapped into the instance's own dir, with a warning.
- **Shifted defaults.** A non-default `ARIGAMI_DIR` shifts every default range
  by +1000 ports / +100 displays: port 4099, `devServerPorts` 4020–4030,
  `dispatcher.portRange` 4200–4299, `screen.portRange` 6901–6950 with
  `screen.displayBase` 200. Explicit config/env still wins.
- **Real occupancy.** `desktops.allocatePort` skips any display with a
  `/tmp/.X<n>-lock` or `/tmp/.X11-unix/X<n>` socket and any VNC port that
  fails a real bind probe — so two instances that were (mis)configured with the
  same range still never collide.
- **Global desktop** (`screen.vncPort`, `:99/5900`) is the default instance's.
  No instance ever spawns or kills an Xvfb/x11vnc it didn't allocate; an
  isolated instance whose global VNC is unreachable just reports
  `/__api/screen/status → available:false`.
- **Host lock.** Before anything destructive, startup calls `claimHost(port)`:
  (1) `run/host.json` naming a live pid on the same port → exit 2 ("same
  instance twice"); (2) the port is already bound (pm2/systemd hosts write no
  pidfile) → exit 2 without touching anything. Then it writes `run/host.json`
  `{pid, port, hostId, dir, startedAt}` + `run/host.pid`, removed on shutdown.
- **Safe sweep.** Every `children.json` record carries `hostId`
  (`<ARIGAMI_DIR>#<port>`) and `hostPid`. `sweepOrphans()` (`planSweep`, pure)
  kills only records with OUR hostId whose host is no longer alive; records of
  another host are never touched and are written back verbatim; a record whose
  hostPid is still alive is left alone. Pre-T5 records (no hostId) count as ours
  only if the legacy `run/host.pid` names a dead pid.
- **Running a second instance:** `ARIGAMI_DIR=/tmp/arigami-2 ARIGAMI_PORT=4099
  bun server/index.ts` (or `ARIGAMI_DIR=… bin/host start`). Out of scope: two
  hosts on one `ARIGAMI_DIR` (warned, unsupported), sharing sessions across instances.

## bin/host CLI

start | stop | restart | status | logs -f | doctor — same UX as PoC bin/host
(background, health check on /__api/config, pidfile in $ARIGAMI_DIR; honours ARIGAMI_DIR/ARIGAMI_PORT).

## Config ($ARIGAMI_DIR/config.json, default ~/.arigami — extend PoC lib/config.js)

{ port: 3099, defaultCwd: '~/Desktop/repos', reposDir, linearWorkspace,
  // `prodUrl` was removed with the compare slider; the baseline is now the
  // compare extension's own `baselineUrl` setting (migrated on first load).
  palette, devServerPorts: [3020..3030],
  screen: { enabled: true, vncHost: '127.0.0.1', vncPort: 5900, vncPassword?,
            display?, autoSnapshots: false, snapshotIntervalMs: 10000, snapshotMinIntervalMs: 30000,
            snapshotChangeThreshold: 0.03, screenshotRetentionDays: 7, screenshotMaxMb: 200,
            portRange: [5901, 5950], displayBase: 100, keepProfiles: false } }
`screen.*` is overridable via ARIGAMI_SCREEN_ENABLED / ARIGAMI_VNC_HOST /
ARIGAMI_VNC_PORT / ARIGAMI_VNC_PASSWORD; `screen.vncPassword` is the only
config key the UI writes back (Settings → Screen share).
Secrets via existing lib/secrets.js (Keychain → secrets.env → env).

## Skills (skills/ — adapted from repos/.claude/skills.disabled + your-plugin plugin)

v1 bundles `create-from-ticket` (worktree-setup + ticket adapted): given ENG-xxxx →
set_title/set_color/set_metadata → set_progress steps (worktree → bun install →
dev server :302x → open) → open_tab Linear (/__ticket/ENG-xxxx), App
(localhost:302x via proxy) → work the ticket → request_review().
Other skills (ship-it, feedback-loop, login…) copied + MCP-wired incrementally after v1.
Skills are made available to spawned sessions via --mcp-config + a settings dir
passed with --settings (skills/ mounted as a plugin dir or copied into cwd/.claude).

## Just-in-time setup (S1 — server/capabilities.ts, request_setup / report_setup)

Minimal onboarding: a fresh install needs only `pair` + `claude`; every other
capability is connected **from the chat, the moment a tool needs it**. Tools
never fail on a missing capability — they return `needs_setup` and the agent
calls `request_setup`, which posts a Setup card the human answers (or, with a
Google identity signed in on the session's Chrome, the agent connects it
itself via a `connect-<provider>` playbook skill).

### Capability ids (shared contract with web + skills)
`identity` (Google login in Chrome) · `claude` · `git` (gh/PAT) · `repo:<name>` ·
`whatsapp` · `mcp:<service>` (a vendor's own remote MCP server — linear/notion/
sentry/vercel/stripe/figma/cloudflare/supabase/atlassian/github; catalog in
`server/mcp-catalog.ts`) · `composio:<toolkit>` (gmail/googledrive/
googlecalendar/googledocs/slack/facebook) · `desktop` · `push` ·
`remote` (tailscale serve) · `telemetry`.
Validated by `isCapabilityId()` — `repo:` names `[A-Za-z0-9._-]`, toolkits
`[a-z0-9_-]`, services `[a-z0-9-]`.
M1: every capability also carries `provider: 'native-mcp'|'composio'|'local'` —
where the token lives and who the calls go through. See docs/INTEGRATIONS.md.

### Registry (`server/capabilities.ts`)
```
Capability { id, title, group:'core'|'code'|'messaging'|'integrations'|'machine'|'host',
             check(): {ok, detail, data?},          // reuses onboarding.ts gates (defaultProbes)
             manual: {kind:'token'|'oauth'|'qr'|'toggle'|'repo'|'takeover', fields?, start?, help?},
             provider: 'native-mcp'|'composio'|'local',
             autoCapable: boolean, playbook?: 'connect-identity'|'connect-composio'|'connect-mcp'|'connect-claude'|'connect-tailscale'|'connect-github',
             events: string[] }                    // bus/funnel types after which status may change
listCapabilities() / getCapability(id) / capabilitiesStatus() / ensure(id, why) / needsSetup(id, why)
```
Manual kinds: identity=takeover · claude=oauth (+token) · git=token (+gh device flow) ·
repo=repo · whatsapp=qr · composio:*=oauth · mcp:*=oauth (bearer rows: token) ·
desktop/push/remote/telemetry=toggle.
autoCapable: claude, git, remote, composio:*, mcp:* with `auth:'oauth'` (only ever
`auto` when `identity.json` exists). `mcp:<service>` resolves agent-first like
`composio:*`: the grant name is `<service>` for the host and `<service>--<slug>`
for an agent, and `data.tools` is the `mcp__<grant>__*` pattern an A3 allowlist
needs.
`composio:<toolkit>` probes Composio's connected accounts (ACTIVE, cached 60 s; no
key → "not connected", offline → unknown/not ok). Probes are injectable (tests).

`bun server/capabilities.ts doctor` (run by `bin/host doctor`) prints the same list offline.

### `needs_setup` — the shape every wrapped tool/route returns (HTTP 200)
```
{ needs_setup: 'composio:gmail', why: 'read your inbox', hint: 'call request_setup' }
```
Wrapped: `POST /__api/sessions` with a `cwd` that does not exist → `repo:<name>`
(registered repo dir/name, else the basename) · `POST /__api/sessions/:id/listeners {type:'whatsapp'}`
when the bridge is not connected → `whatsapp` · `POST /__mcp/screen-request` and
`…/screenshot` when screen share is disabled → `desktop` · `POST /__api/onboarding/repos/:name/clone`
of a remote repo without git credentials → `git` · `check_setup` / `GET /__api/setup/capabilities/:id`
for anything not connected (use it before provider MCP tools such as Composio, which
cannot answer needs_setup themselves).

### MCP tools (mcp/host-mcp.js)
```
request_setup({capability, why, mode?:'auto'|'manual'|'ask', session_id?})
   → already connected:  {state:'done', already:true, capability, detail, mode:'manual', id:''}
   → otherwise BLOCKS (≤15 min) until the human acts on the card:
        manual connection landed → {state:'done', id, capability, detail, mode, evidence}
        "Not now"                → {state:'skipped', …}      nobody → {state:'timeout', …}
        "Connect automatically"  → {state:'auto', id, capability, detail, mode:'auto', playbook}
   // Rule 3 — no auto without a click: `mode` only PRESELECTS the card's switch
   // (default 'auto' iff identity.json exists AND autoCapable, else 'manual').
   // A second request_setup for the same {session, capability} attaches to the
   // open card (pending/auto/failed) — used after a failed auto → manual hand-off.
report_setup({capability, ok?, line?, evidence?:'/__artifacts/<id>/', detail?, id?, session_id?})
   → {line} (no ok)  → appends a narration line to the card (`lines`), {ok, closed:false, lines}
   → ok:true         → card done (green, evidence shown), audit, funnel setup.completed,
                       identity.providers[cap] stamped (agent-run auto only)
   → ok:false        → card state:'failed', mode:'manual', detail=reason (rule 5); {closed:false, state:'failed'}
check_setup({capability, why?}) → {ok:true, detail, status} | needs_setup shape
```

### Chat events (S2 renders `kind:'setup'`, merges `setup-update` by `requestId`)
```
{kind:'setup',        requestId:'setup_…', id:<same>, capability, why, mode, state:'pending', evidence:null, detail, lines:[],
                      title, manual:{kind,fields?,start?,help?}, autoCapable, playbook?, identity:{email}|null}
{kind:'setup-update', requestId, id, capability, why, mode, state:'pending'|'auto'|'done'|'failed'|'skipped'|'timeout',
                      evidence, detail, lines, failed?:true}
```
Bus: `{type:'setup', sessionId, …card}` for the initial card, `{type:'setup-update', sessionId, requestId, …patch}` on
every transition, `{type:'setup.changed', capability}` after a manual connect/disconnect (Settings re-fetches).
`session.claude.setupRequest = {id, capability}` while an agent is blocked (state `awaiting-input`), like
`screenRequest`. Push: "<session> — needs <title>" with the relative session link (same cooldown as request_action).

### REST (`/__api/setup/*`) — the routes `web/src/lib/setup-api.js` calls
```
GET    /__api/setup/capabilities            → {identity, capabilities:[CapabilityStatus], audit:[…last 50]}
GET    /__api/setup/capabilities/:id?why=   → {ok:true, detail, status} | needs_setup
GET    /__api/setup/pending?session=        → {pending:[card payloads]}                      // web reload
POST   /__api/setup/:capability  (admin or session bearer) — manual payload per manual.kind:
         token    {token}                       (claude / git / composio:* accept token|key)
         oauth    {action:'start'} → {id, url}   claude PKCE: {action:'code', id, code} / {action:'poll', id} / {action:'cancel', id}
                                                  git device: {action:'device'} → {device:{state,code,url,error}}, {action:'poll'} → {ok, device}
                                                  composio:x: {action:'start'} → {url, id}, {action:'poll'} → {ok}
                                                  mcp:x:      {action:'start'} → {name, url:<vendor authorize URL>, domains, docs},
                                                              {action:'paste'|'code', code:'<…/callback?code=…>'}, {action:'poll'} → {ok, connection},
                                                              {action:'cancel'}; bearer rows (github): {token?} — empty reuses `gh auth token`
         qr       {action:'connect'|'poll'|'disconnect'} → {ok, status:'starting'|'qr'|'connected'|…, qr, qrUrl, user}
         toggle   {enable}                      (desktop / remote / telemetry; push: hint only)
         repo     {entry:{name, source, …}}     (registers if unknown, then the clone job)
         takeover {action:'verify', email}      → identity.json (skills/connect-identity, TakeoverStep)
       → {ok, …, capability, status:CapabilityStatus, closed:<open cards resolved>}; on a green re-check
         every open card for that capability resolves state:'done' (human:true) + bus setup.changed.
POST   /__api/setup/:id/skip {note?}         → agent gets state:'skipped'
POST   /__api/setup/:id/mode {mode}          → preselect only (informational); →'auto' refused for non-auto ids
POST   /__api/setup/:id/start {mode:'auto'}  → CONSENT: mode auto, state auto, agent released with state:'auto'
                                               (400 when not autoCapable / no identity)
POST   /__api/setup/:id/report {ok?|line, evidence?, detail?, human?}   // same as report_setup; human:true from the card
DELETE /__api/setup/:capability              → disconnect via the existing implementation + audit 'disconnected':
         identity → identity.json removed · composio:x → connected accounts deleted ·
         mcp:x → `claude mcp logout` + `remove` + the ownership record dropped · remote → serve off ·
         git → github.com line dropped from ~/.git-credentials (+env) · whatsapp → bridge stopped ·
         telemetry → off · desktop → screen disabled · claude / repo:* → 400 (use their own views)
GET    /__api/setup/identity                 → {identity|null}       (DELETE = DELETE /__api/setup/identity)
GET    /__api/setup/connections?limit=50     → {identity, audit:[…newest last]}
POST   /__api/onboarding/wizard/mode {mode:'minimal'|'full'}   // "Run full setup" / back
```
Pinned by test/setup-contract.test.ts (route set cross-checked against S2's client when reachable).

### Files
`$ARIGAMI_DIR/identity.json` — `{email, provider:'google', connectedAt, chromeProfile:'base', providers:{'composio:gmail':{at},…}}`,
mode 0600, never a secret (writer refuses token-looking values).
`$ARIGAMI_DIR/connections.log` — JSONL `{at, sessionId, capability, mode, result:'requested'|'done'|'failed'|'skipped'|'timeout'|'disconnected', evidence:'/__artifacts/<id>/'|null, human, detail?}`.
`$ARIGAMI_DIR/mcp-connections.json` / `agents/<slug>/connections.json` (M1) —
`[{cap:'mcp:<service>', slug, name:'<service>[--<agent>]', url, auth, at, byIdentity}]`,
mode 0600. Ownership only: the grant itself lives in Claude Code's
`$CLAUDE_CONFIG_DIR/.credentials.json` (`mcpOAuth`, plaintext, machine-local) and
is never exported.

### Minimal onboarding mode (default)
`onboarding.json.mode` ('minimal' default, 'full'; env `ARIGAMI_ONBOARDING_MODE`). `wizard()` →
`{…, mode, required:['pair','claude']}` and **persists the effective `mode`** into the file (F8) so a
fresh install reads `mode:"minimal"`; `done` = every REQUIRED step settled; `current` = first
unsettled required step. Optional steps stay `todo` without blocking. `cfg.defaultCwd` defaults to
`$ARIGAMI_DIR/workspace`, created on host start, so "Connect Claude → Start" opens a session with zero repos.

Web contract (F8): after pairing, `!done && mode!=='full'` routes to the Setup screen's hero
(Connect Claude → Start) — the 8-step wizard opens only in `mode:'full'` ("Run full setup" POSTs
`/__api/onboarding/wizard/mode {mode:'full'}`, never a reset). In the wizard, `done` renders a Start
panel (creates the first session, navigates to it) instead of falling back to step 1; only
`required` steps are listed in minimal mode. First screen with zero sessions = one prompt box +
three chips (screenshot a site / connect WhatsApp / clone a repo) + "Advanced"; the launcher's ticket
tab exists only when Linear is connected; Pending/Triggers/Usage rail items appear once a session exists.

### WhatsApp just-in-time (F8)
host-mcp exposes one `whatsapp({tool, args, why})` tool (list_chats, list_messages, search_contacts,
search_messages, get_chat, get_message_context, get_recent_messages, send_message) →
`POST /__api/whatsapp/tool`. Bridge not `connected` → the `needs_setup:"whatsapp"` shape (→
request_setup → QR card); connected → proxied to the WhatsApp MCP server (`server/whatsapp-proxy.ts`,
stdio client, spawned lazily from `ARIGAMI_WA_MCP_DIR`). The first turn of every session carries an
identity reminder ("the agent inside Arigami", answer in the human's language) plus the cached
connectable-capabilities line (`refreshCapabilitiesHint()` in claude.js), so the model knows WhatsApp,
Gmail… exist before they are connected.

### Claude PKCE without pasting (F8)
Session Chrome starts with `--remote-debugging-port=0` (loopback; port in `<profile>/DevToolsActivePort`).
`server/lib/chrome-cdp.ts` lists real tabs / inserts text; `oauth-login.js` binds a flow to the
session that started it (`X-Arigami-Session` / `sessionId`) and polls that browser for the
`platform.claude.com/oauth/code/callback?code=…&state=…` tab, exchanging automatically.
`POST /__api/accounts/oauth/read-browser {id, sessionId?}` (= setup action `read-browser`) does it on
demand; `POST /__api/sessions/:id/desktop/type {text, enter?}` types into the desktop (CDP
`Input.insertText`, XTEST fallback). Acceptance #1 (pair → Connect Claude → Start < 60 s) and #4
(WhatsApp QR card from "read my WhatsApp") are covered by `test/f8-fresh-setup.test.ts`.

### Funnel
`setup.requested {capability, mode}` · `setup.completed {capability, mode}` · `setup.skipped {capability, mode, timeout?}` · `setup.first_request` (once).

### Automation rules (enforced by skills, audited here)
The agent never types passwords / 2FA / OTP (→ `request_screen`); playbooks navigate only their
domain allowlist; the card states exactly what will happen before "Connect automatically";
one final screenshot published as evidence + one audit line; failure → manual with reason, ≤2 attempts.

## Out of scope v1

Multi-user/auth, Tauri wrapper, tab drag-reorder, session pop-out windows,
mobile, Söhne fonts, claudecodeui code reuse (AGPL — inspiration only).
