# Phase 2 — `changes` area (Changes tab, machine, project / orchestration)

Branch `redesign/redesign-changes-vuh0`. Rule of the branch: **no feature disappears**. Decisions D1/D2 (consolidation.md): the review-and-merge model is KEPT — Request changes / Comment / Approve, the local merge, Explain, Auto review, Features, Work mode — restyled and organised only.

## Moved
- moved: **Open in VS Code** from the Changes header row to the `⋯` overflow menu (decision D2, option C). Still one menu click away; hidden on a phone as before.
- moved: Changes header, one row → two. Row 1 keeps actions (back/forward, mode switch, compare-against, Explain, Auto review, split/inline, refresh, `⋯`); the facts (branch, merge pill, `n files`, `explained`, `outdated`) moved to a quiet context line under it.
- moved: phone **file/feature list** from an inline collapsible panel to a bottom sheet (opened from the same "Files · n" bar).
- moved: the **Merge** control's primary-ness: when a review is approved and the Merge strip is showing, Merge is the view's one primary button and **Approve** steps back to a neutral button (accent budget: one primary per view). Both stay.

## Restyled (behaviour unchanged)
- **Changes tab** (`ChangesTab.jsx`): ui Button/Tabs/Badge/DropdownMenu/Popover+Command/Sheet/Tip; mode switch and split/inline and Local/Remote-PR are segmented controls; base picker is a Popover + Command (same search, groups, Default entry, Enter picks the first match); file rows use the list-row convention + `row-selected`; status letters coloured by status token, `+a −d` neutral-tokened; C/U markers, staged dot, comment count, explanation wand all kept; duplicate base names show their folder.
- **Diff** (`DiffView.jsx`): unified/split as before; line-number gutter with hairline; quieter add/del tints that work in light and dark through the new `--diff-*` tokens; long lines now **wrap** (indent kept) instead of scrolling every row on its own; split columns stay old-left/new-right in RTL; syntax colours are the shared `.diff-syntax` palette (same as the chat DiffCard); per-line "+" is always visible on touch.
- **Review comments** (`Comments.jsx`): quiet cards, ghost text actions (edit / reply / resolve / reopen / accept / reject / delete all kept), suggestion = violet-dot badge, resolved = ok-dot badge, replies nested under a 1px start hairline; composer is a ui Textarea with ⌘↵ / Esc as before.
- **Merge** (`MergeCard.jsx`): `MergePill` → `Badge` with a status dot; `MergePanel` uses ui Select / Checkbox / Button / Tip (strategy, delete-branch, Merge, Re-check, optional dismiss, disabled reason, conflict text). The `dark` (chat) face keeps native controls on the terminal palette so the chat card is unchanged in structure.
- **Orchestration** (`OrchestrationTab.jsx`): node cards with neutral status dots, relative time of the last report, deps chips, worker row (jump, branch, merge pill, Retry, Kill), result nested under a 1px hairline, group headers with dot + count.
- **Machine** (`Machine.jsx`): the rail strip and the Settings › Host panel use neutral numbers; pressure shows as a status dot and the bar fill only.
- **Screen panel / modal** (`ScreenSidePanel.jsx`, `ScreenModal.jsx`, `ScreenView.jsx` chrome): ui Button / Input / Badge / StatusDot; same controls (enlarge, collapse, Cancel, Take over, type-into-desktop, note, Done, setup verify Done, fullscreen, close, status labels, "browser window only" chip). The modal keeps its own portal shell and native `title`s on purpose — it is the Fullscreen-API target, and a kit tooltip portals to `<body>` and would sit behind a fullscreen element.

## Added (derived display only — no new product capability)
- Changes meta line: total `+added −deleted` across files (sum of the per-file counts already shown).
- Orchestration header: a progress rollup (`n of m done` + thin bar + per-state counts) and a **Needs you** strip listing blocked / errored / awaiting-input workers with an **Open** button that jumps to the worker (same jump as `→ worker`). No inline Approve (that is a new capability, D12 — not done here).
- i18n: `chat.orchProgress`, `chat.orchOpen` (en + he).
- Tokens (`index.css`, shared file, one block): `--diff-add-bg`, `--diff-del-bg`, `--diff-add-gutter`, `--diff-del-gutter`, `--diff-add-mark`, `--diff-del-mark`, `--diff-gap-bg`, `--diff-hunk-bg` (light + dark).

## Removed
- *(nothing)*

## For the integrator
- `index.css`: only the `--diff-*` block next to the `.diff-syntax` palette was added.
- `DiffCard.jsx` (chat) was **not** edited; it still carries its own literal `ADD_BG / DEL_BG / GAP_BG` and `#5fb56a / #d98078` marks. To make chat and Changes read identically, point those at `var(--diff-add-bg)`, `var(--diff-del-bg)`, `var(--diff-gap-bg)`, `var(--diff-add-mark)`, `var(--diff-del-mark)`.
- `MergePanel` is also rendered in the chat (`dark`), by ChatPane — its API did not change.
- Tests updated for intentional markup changes only: `bugs1-web.test.js` (B18 diff row sign glyph `−`, ChangesTab mode-switch wiring string).
- Phone tap targets: every control in the Changes / Orchestration / panel views measures ≥ 44px under a coarse pointer except the per-line "+" in the diff gutter (28px, rows are 28px tall on touch) and the checkbox glyph (its hit area is 40px via `after:-inset-3`).
