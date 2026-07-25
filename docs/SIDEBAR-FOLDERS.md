# Sidebar Folders & Project Folders — Decision Record

Interview-driven design (2026-07-21). Every decision below was explicitly approved.

## 1. Architecture

- **Folders are first-class server entities** (option B). Not client-side/localStorage: the controller session sees the world through MCP→REST, `wireWorker()` must auto-place workers, sortOrder is already server-side, multiple clients sync over the existing WS broadcast, and sessions are created headlessly (triggers/cron).
- **Tree mode is deleted.** Folders replace it. Grouped-by-status mode remains.
- Folders live in `db.folders`, persisted in the same debounced JSON state file (`server/state.ts` `persist()`/`load()`) — they survive restarts exactly like sessions.

## 2. Data model

- Membership lives on the session: **`session.folderId?: string`** — a typed field (NOT inside free-form `metadata`), added to the `PATCHABLE` whitelist (`state.ts:339`).
- Folder record is thin:

```ts
interface Folder {
  id: string
  name: string
  collapsed: boolean
  sortOrder?: number           // same numeric axis as root-level sessions
  controllerSessionId?: string // present ⇒ project folder
  createdAt: number
  updatedAt: number
}
```

- **One nesting level only**: root holds folders + free sessions; a folder holds sessions only. `parentId` can be added later without breakage.
- Inside a folder, children order reuses the existing `session.sortOrder` as an internal axis.

## 3. Drag & drop

Zones per row (Notion-style), replacing the current whole-row `ring-1 ring-brand` highlight:

- **Top 25%** → gap *before* the row: 2px brand-colored horizontal line between rows (small dot at the edge).
- **Bottom 25%** → gap *after* the row.
- **Middle 50%** → "onto" the row (existing ring highlight): onto a free session = "create folder with both" modal; onto a folder header or a session inside a folder = move into that folder (no modal).
- Rows inside a folder: gaps = reorder within the folder.
- Empty area at list bottom → end of root (also the drag-out path: sets `folderId = null`).
- **Folders drag as a unit** (root-level reorder only, gap zones only — no folder-onto-folder since no nesting). Children move with it.
- Removing a session from a folder: drag to a root gap, or ⋯ menu "Remove from folder".
- Drag stays flat-mode-only, disabled while searching (existing `canDragSessions`).
- Phase 1 also fixes the Pending-tasks list which uses the same highlight-the-row pattern.

## 4. Reorder API — atomic

Extend `POST /__api/sessions/reorder` (or add `/__api/rail/reorder`) to accept the whole drop result in one atomic call → one broadcast, no intermediate state:

```ts
{ root: [{type:'session'|'folder', id}...],   // full root order
  folders: { [folderId]: [sessionIds...] },    // internal order per changed folder
  moves: [{sessionId, folderId|null}] }        // membership changes caused by the drop
```

Client does optimistic update as today, reconciles from broadcast.

## 5. Folder lifecycle

**Create (drop session onto session):** dialog on the existing `Dialogs.jsx` `Overlay` pattern — "Create folder?", both sessions shown with their `Dot`s, autofocused name input. Default name: shared `metadata.ticket` prefix if any, else "New folder" (text pre-selected). Enter confirms / Escape cancels (cancel = total no-op, no reorder). Internal order: target first, dragged second. Folder inherits the target's root position. No folder color in v1 (`faFolder` icon).

**Create (manual):** small + button in the list header → empty folder at top with the same name dialog.

**Edit:** folder ⋯ menu (RowMenu pattern): Rename / Delete / Make project folder.

**Delete — options dialog** (new component alongside `DeleteDialog`):
- "Delete folder only" (default): ungroup — children return to root at the folder's position, keeping relative order.
- "Delete folder and all N sessions" (danger): kills every session inside, incl. the controller of a project folder. **Differential cleanup:** `runCleanup` only for sessions owning their worktree (`metadata.kind === 'mutating'` / own `metadata.worktree`) — readonly workers' cwd is the master's worktree and must never be cleaned (learned the hard way). Kill order: workers first, controller last (avoids watchdog wakes on dead children).
- Empty folder: deleted instantly, no dialog.
- A folder emptied by session deletion is NOT auto-deleted (legitimate state for a project folder between waves of workers).
- Server: `DELETE /__api/folders/:id` with `{mode:'ungroup'|'purge'}`, atomic, `folder-deleted` broadcast.

## 6. Badges & delegation

- **Count chip** (active children only) always visible on the right.
- **Collapsed-only rollup from children:** attention pill `? N` (any child `needsAttention`), listener-error triangle, working spinner (spinner suppressed when a `?` shows). Selected child excluded from rollup (consistent with `needsAttention && !selected`).
- **Expanded:** header clean — children render their own badges.
- **Delegated vs own — two redundant cues:**
  - *Fill:* own indicator = solid + pulse (existing); delegated = **hollow/outline**, same hue family, no/soft pulse, with count.
  - *Position:* next to the name = this entity itself; on/next to the count chip = the children. Clicking the chip expands the folder (and scrolls to the relevant child).
- Selecting a session that lives in a collapsed folder (search, URL nav) **auto-expands** the folder.

## 7. Project folders

- **Header IS the controller** (no controller row inside): clicking the folder *name* selects the controller session; the *chevron* toggles collapse. Distinct icon (`faFolderTree`/crown) marks it vs a regular folder. Controller's own badges render next to the name **always** (even expanded); selected-session colored border moves to the header.
- **Creation paths:**
  - (a) Manual: ⋯ → "Make project folder" → creates a NEW dedicated controller session; cwd chosen in the dialog (default: most common repo among current children); seeded with the dispatch master role + the current children list ("these are the sessions you manage").
  - (b) Automatic: `wireWorker()` (`api.ts:598`) — when a session spawns a worker and doesn't already control a project folder, the server auto-creates one (named after the master's title), sets master as controller, places master + worker inside. Subsequent workers join it. Every existing dispatch flow gets the new UI for free.
  - (c) Promoting an existing session to controller: **deferred** (injecting "you're now a master" mid-conversation is dubious; path (b) covers the organic case).
- **Controller dies/deleted/archived** → folder drops `controllerSessionId`, reverts to a regular folder; children untouched. Safety fallback — no folder locked to a ghost.

## 8. App capabilities vs. user methodology (core principle)

**The human can do everything with a child session as with any regular session.** The controller is an *additional* authority, not a replacement. The human sees and approves all changes — `request_review` always targets the human; the controller cannot approve/merge on anyone's behalf (app-level enforcement, not skill guidance).

- **App layer (methodology-agnostic):** folder model, `controllerSessionId`, CRUD, ordering, badges, auto-folder, `create_session` (incl. full-child mode), `task_session`, `report_to_master`, orchestration read, listeners, authority enforcement.
- **Skill layer (user's methodology):** a new "project manager" skill — decomposition, task ordering, when to spawn children, instructing each child to run **create-from-ticket** (own worktree/port/dev server via the existing skill) and then the master's task, bird's-eye progress tracking, never reading children's code.

## 9. Inter-session communication — three rigid paths

- **Downstream (controller→child): new MCP tool `task_session(sessionId, message)`.** Child idle → immediate `sendMessage`; child busy → enqueued into the child's existing **pending-prompts** queue with auto-play. Controller never interrupts a turn. **No `interrupt` flag in v1.** Server-enforced authority: caller must be the controller of the target's folder (or its `metadata.master`).
- **Upstream (child→controller): `report_to_master` only** (thin, capped, wake-when-idle). No second channel.
- **Sideways (child↔child): forbidden.** All coordination flows through the controller.
- **Knowledge transfer (vs control):** short summaries in `metadata.result` (capped), heavy artifacts as files with paths in `artifacts[]`, plan in `ORCHESTRATION.json` owned by the controller. `task_session` is a command channel, not a file channel.
- Human (UI/REST) and controller (`task_session`) converge on the same pending-prompts queue — no collision.

## 10. Full children vs thin workers

- `wireWorker()`'s current behavior (thin worker: `dispatch/<subtask>` branch policy, readonly-in-master-cwd, watchdog) **remains** as an option for cheap scans.
- `create_session` gains a **"full child" mode**: `{folderId, master, prompt}` — port allocation yes, no thinning/branch policy. Worktree/branch policy moves to the skill (the child runs create-from-ticket which handles it).
- **Caps apply to full children too** (machine guardrail — e.g. separate `maxChildren` alongside `maxMutating`/`maxReadOnly`).

## 11. Secondary views

- **Grouped-by-status:** ignores folders entirely (flat sessions in status buckets). Folders are a flat-mode feature.
- **Search:** flattens; matching session rows show a small gray folder breadcrumb (`📁 <name>`); folders whose *name* matches appear as a lone header row. DnD stays disabled while searching.
- **Archive:** archiving keeps `folderId` (restore returns to the folder); Archived section stays flat; count chip counts active children only. No whole-folder archiving in v1.

## 12. Adoption / abandonment (authority follows membership)

- **`folderId` is the source of truth for `task_session` authority.** `metadata.master` stays for compat (old report_to_master, watchdogs) but enforcement checks the folder only.
- **Drag a session INTO a project folder:** controller gains authority immediately + thin wake `enqueueWake(controller, "adopted: <id> — <title>")`.
- **Drag OUT / to root:** authority revoked immediately — `task_session` returns a clear error ("no longer in your folder"); already-queued pending prompts remain; thin wake "removed: <id>".

## 13. Delivery phases

1. **Drop-zone indicator fix** (standalone): 25/50/25 zones + gap line; middle zone inert until phase 2. Also fix the Pending-tasks list indicator.
2. **Folders:** server model + atomic reorder + CRUD dialogs + Rail UI (collapse, count, hollow/solid badge rollup) + secondary-view behavior + tree-mode removal.
3. **Project folders:** `controllerSessionId`, Make-project flow, auto-folder in `wireWorker`, header-as-controller, `task_session` + enforcement, full-child mode + caps, adoption/abandonment wakes, project-manager skill.
