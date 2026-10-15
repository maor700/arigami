# Redesign branch `redesign/linear-shadcn` — change log

This file lists what changed against `master`, organised by area. Rule of the branch: **no feature disappears**. Every control that exists on `master` is still reachable; a control that moves is listed as "moved". The branch is `master` + the Phase 1 foundation + the four Phase 2 areas (shell, chat, changes, settings) merged and integrated.

## Index of moved controls (everything that is not where it was on `master`)

| Control | Was | Now | Decision |
|---|---|---|---|
| Simple / Terminal chat view | session header (segmented) | header `…` menu, radio group "Chat view" | D9 |
| Engine name, ticket · branch | session header row | title tooltip + top of the header `…` menu | D11 |
| Account chip ("runs on …") | session header | header `…` menu (opens the accounts page) | D11 |
| Model, effort, permission mode | header gear pickers | composer pill (one popover); the gear keeps ONE row "Model, effort, permissions" that opens the pill (gear keeps its own pickers only where no composer is mounted, e.g. an agent home page) | D7 / D10 (open) |
| Context meter | gear row only | chip next to the composer pill (gear row kept) | D7 |
| Rail "Triggers" label | text link | bolt icon button in the Pending header (tooltip + aria-label) | D5 |
| "+ New agent" | text button | "+" icon button in the Team header | D5 |
| Open in VS Code (Changes) | Changes header row | Changes `⋯` menu | D2 |
| Changes file / feature list (phone) | inline collapsible | bottom sheet from the same "Files · n" bar | — |
| Machine / Summary | header chips | stay in the header (ghost buttons) | D9 C |
| Terminal-controls gear (context, direction, theme, restart, clear) | session header gear | **removed from the session header** (D10): context % is a chip that opens Context / Compact; Restart + Clear + "Display for this chat" (direction, chat theme) + chat view + text size are in the header `…` menu; default direction / chat theme / text size / accent are in Settings › General › Appearance (the gear remains only on an agent home page, which has no composer) | D10 (approved) |
| Model, effort, permissions row in the gear | gear | composer pill only | D10 |

Added (derived display only, no new capability): "Needs you" group pinned at the top of the rail; ⌘/Ctrl+J = next session that needs me; palette shows sessions + commands on an empty query, "Switch language" command; PR and branch chips on rail rows when the data exists; Plan card for `TodoWrite`; `@` button in the composer; Changes meta line with total +/−; Orchestration progress rollup and "Needs you" strip with Open.

Removed: nothing.

## Integration notes (Phase 3)

- Merge conflicts were resolved per area owner: shell owns Rail/SessionView header/TabBar/Usage/ContextModal/ShortcutsHelp/ExtLauncherPane/RoutineList/EngineToggle; changes owns Machine/MergeCard/ScreenModal; settings owns `setup/*` and `settings/*`; chat owns cards, composer, ExtCard.
- Dialogs of the shell/changes versions were kept where both areas had restyled the same file; the settings branch's `Dialog` version of `ScreenModal` was dropped on purpose (the Changes version keeps its own portal shell because it is the Fullscreen-API target and uses native titles).
- `DiffCard` (chat) now uses the shared `--diff-*` tokens, like the Changes diff.
- One source of truth for model / effort / permission: the composer pill. The header gear shows one row that opens the pill (`lib/composerPill.js`, event `arigami:open-composer-pill`); where no composer is mounted the gear keeps its three pickers. **D10 is still open** (see below).
- Accent budget enforced: the last mint fills (`VoiceHUD`, archived-session "Restore") are now `Button`s; Settings rows no longer carry a second primary (Integrations / Native MCP / Agent connections "Connect" are neutral); `test/redesign-integration-web.test.js` fails on any `bg|text|border|ring|fill|stroke-brand` outside the logo, wizard logo bars and the style guide.
- Locales: every master i18n key still exists (4794 → 4816 keys, none missing, no value changed); 8 keys are no longer referenced by code (`rail.triggers`, `rail.command`, `rail.activeAccountSuffix`, `rail.chatModeHint`, `chat.explain`, `chat.reExplain`, `chat.autoReview`, `chat.reReview`) because their controls were re-labelled with `…Menu` variants or tooltips; they are kept in the locale files.

## Open decisions for the owner

1. ~~D10~~ DONE in QA round 1 — gear removed (see the moved index). Was: gear vs composer pill. Current: pill is the source of truth; gear keeps Context, Direction, Theme, Restart, Clear plus one row that opens the pill. Recommended (consolidation C): drop the gear entirely, make the context chip open Context/Compact, move Restart and Clear to the header `…`, move Direction/Theme to Settings. See: any session, gear icon in the header and the pill in the composer.
2. D9 — Simple/Terminal now lives in the header `…` menu (2 clicks). Recommended: keep (C). See: session header `…`.
3. ~~D12~~ DONE in QA round 1 — inline Approve / Deny / Answer / Review on the Needs-you rows via the existing permission answer. Was: Orchestration has the rollup + Needs-you strip but no inline "Approve" (a new capability). Recommended: C with context shown before acting. See: a project controller session → Orchestration tab.
4. D14 — rows show branch and PR chips but no `+a −d` or CI dot (not on the session data). Recommended: add only when the data exists.
5. D15 — no working timer, tool durations or Retry-on-error in chat (need defined semantics). Recommended: defer.
6. D8 — permission card keeps Allow / Deny only (no "Always allow", no "Undo"). Recommended: keep as is.
7. ~~DONE~~ only the newest waiting card keeps the accent button (QA round 1). Was: Several pending cards in one chat each carry their own primary button (e.g. "Create agent" and "Connect automatically" at once). Recommended: only the newest waiting card is primary.
8. ~~DONE~~ chat follows the app theme by default; Settings › Appearance has Follow app / Light / Dark (QA round 1). Was: Chat pane keeps its own light/dark (`termTheme`), independent of the app theme (V12). Recommended: follow the app theme by default.

## RTL / Hebrew text alignment (fix pass)

- **One markdown component** (`components/Md.jsx`) for chat prose, ext/OpenUI cards, skills, launcher and content tabs: every paragraph, list, heading, quote and table cell gets its own `dir` from its first strong character (inline code ignored), code blocks stay LTR. Bullets, numbers, indents and quote bars now sit on the side of the text, not of the app language; a list item in the other script stays flush with its list.
- **Truncating text** (`Truncate.jsx`) reads its own direction off the text, so an ellipsis cuts the tail (not the head) of an English title in a Hebrew UI and vice versa, while rail titles, folder names, tab titles and quick-switcher rows still align to the UI's start edge (`.ui-start`) next to the identity dot and chips.
- **Text fields**: `Input`/`Textarea` with `dir="auto"` and the composer use `fieldDir()` — own direction once there is a strong character, the app's direction while empty or neutral ("/", "123"), so the caret and a Hebrew placeholder start on the right. The composer paragraphs order themselves (`unicode-bidi: plaintext`).
- Todo rows take their label's direction (icon on the text side). Logical-property guard test keeps `ml-/mr-/pl-/pr-/text-left/text-right/border-l/border-r` out of the app.

## Phase 1 — foundation

#### Moved
- *(nothing)* — Phase 1 changes look and primitives only; no control changed place.

#### Removed
- *(nothing)*

#### Added (infrastructure, not product features)
- `web/src/components/ui/` — the shadcn/ui kit on Radix (Button, DropdownMenu, ContextMenu, Popover, Tooltip + `Tip`, Dialog, AlertDialog, Sheet, Tabs, Collapsible, Command, ScrollArea, Select, Switch, Checkbox, Input/Textarea, Label, Badge + StatusDot, Separator, Skeleton, Kbd, Toast view, Direction provider).
- `web/src/lib/utils.js` (`cn`), `web/components.json`, `web/jsconfig.json`, Vite alias `@` → `src/`.
- `UiProvider` at the app root (Radix direction fed from the language preference + tooltip provider).
- Living style guide at `#/styleguide` (not linked from the product UI).
- Self-hosted Inter (Latin) next to Rubik (Latin + Hebrew).
- Dependencies: `radix-ui`, `cmdk`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `tw-animate-css`, `@fontsource-variable/inter`.

#### Restyled globally through tokens (no call site changed)
- `index.css` token layer rewritten: neutral oklch ramps (light + dark), shadcn semantic tokens as aliases of the existing `--hb-*`, type scale 11/12/13/14/16/20, radii 4/6/8/12, elevation, motion. Every existing token name still works.
- Chat pane palette (`--term-*`) is neutral; the "you" bubble and the question/permission/action cards no longer use mint fills.
- Legacy-look neutralisers (unlayered, attribute-based): `border-2` / `border-[1.5px]` → 1px hairline; `border-ink` → hairline; hard offset shadows → none / hairline card / soft overlay; `font-mono` on chrome → sans (mono stays on `whitespace-pre*`, diffs, `code`/`pre`); `font-bold` → 600; 8–10.5px text classes → 11px floor; accent chips (`bg-chip`) → neutral; the waiting pulse is amber.
- Segmented "selected" fills that were solid ink (`bg-ink`) are a pressed neutral.
- Reduced-motion support; global 2px focus ring in the accent colour.

#### Migrated primitives (behaviour unchanged)
- `ui.jsx` `YellowButton` → `ui/Button variant="primary"`; `GhostButton` → `variant="outline"` (same props); `Dot` border is a hairline.
- `Toaster` → `ui/toast.jsx` (same store `lib/toast.js`, same API, same bottom-left stack, auto-dismiss, action, manual dismiss).
- `ConfirmHost` → Radix `AlertDialog` (Enter confirms with the confirm button focused, Esc cancels, focus trap + restore).
- `Dialogs.jsx` `Overlay` backdrop restyled (still portaled, Esc/backdrop close).

#### Left for Phase 2 (not touched)
Rail, session header, tab bar, chat cards and composer, Changes tab, launcher, settings, wizard/setup, the hand-rolled menus in Rail/AgentView/TermControls, other hand-written dialogs, `title=` tooltips, remaining mint fills (`bg-brand` is used ~85 times for selected segments and toggles).

## Shell — rail, session header, tab bar, palette, navigation, launcher

Rule: no feature disappears. Everything below is still reachable.

### Moved
- Simple / Terminal view toggle: from the session header to the header "…" menu, a radio group "Chat view" (decision D9). 2 clicks.
- Engine name, ticket · branch: from the header row to the title tooltip and the top of the "…" menu (D11).
- Account chip ("runs on …"): from the header to the "…" menu; selecting it opens the accounts page (D11).
- Rail "Triggers" label: now a bolt icon button (tooltip + aria-label "Manage triggers") in the Pending header.
- "+ New agent": now a "+" icon button in the Team header (tooltip + aria-label).
- Row / folder / agent "···" menus: now ui DropdownMenu; rows and folders also open the same actions on right-click.
- Phone rail drawer: now a ui Sheet on the start edge (focus trap, Esc, backdrop tap).
- Add-tab "+" popover: ui Popover anchored to the button (⌘T still toggles it).
- Machine / Summary stay as ghost buttons in the header (D9 C); the terminal-controls gear stays (D10: the composer popover belongs to the chat area).

### Added
- "Needs you" group pinned at the top of the flat rail (D3 C); the sessions also stay in their own place below.
- ⌘/Ctrl+J: jump to the next session that needs you (D13 C); palette entry "Go to the next session that needs me"; cheat-sheet row.
- Palette entry "Switch language"; the palette shows sessions and commands on an empty query (was: sessions only).
- Row: PR badge (`#n` from metadata.pr / prNumber) and branch chip, when present. +/- totals and CI dot are not on the session data today, so not shown (D14).
- Rows are keyboard focusable (Enter/Space select); i18n keys `rail.needsYouGroup`, `rail.sessionsGroup`, `rail.commandsGroup`, `rail.scNextNeedsYou`, `chrome.palette.nextNeedsYou(.kw)`, `chrome.palette.language(.kw)`.

### Removed
- (nothing)

### Restyled (behaviour unchanged)
Rail (rows, folders, team, pending, archive, usage and machine mini, footer, profile menu), tab bar, session header, summary popover, listeners row and panel, progress strip, terminal controls menu and its pickers, context window dialog, ⌘K palette (cmdk), shortcuts dialog, pending/ticket previews, phone top bar, Launcher + extension pane + routine list (see launcher commits).

### Shared files touched (for the integrator)
- `ui/tooltip.jsx`: `Tip` also works without a TooltipProvider (adds its own), so SSR tests and isolated renders don't throw.
- `ui/command.jsx`: `CommandItem` keeps full opacity when cmdk sets `data-disabled="false"`.
- `lib/prefs.js`: default `railWidth` 248 → 264.
- `locales/{en,he}/rail.js` and `chrome.js`: appended keys at the end.
- Tests updated for the new markup (behaviour unchanged): rail-containment, agents-web, agents-ux1, agents-ux4 (menu items rendered with stand-in parts), plus the ones listed in the final report.

## Chat — messages, tool rows, cards, composer, setup/connect cards

Rule of the branch: **no feature disappears**. Everything below is a restyle unless listed under *moved* / *added*.

### Moved
- **moved: model / effort / permission mode** — one pill in the composer (`ComposerPill`, popover with three sections, same endpoints, same "stop and switch" confirmation while a turn runs, Claude-only "refresh models" + CLI-update chip kept) (D7). After integration the header gear shows a single row that opens this pill instead of repeating the three pickers (see Integration notes; D10 open).
- **moved: context meter** — a small `63%` chip with a status dot next to the pill (opens the same Context modal as before). The gear keeps its own entry.
- **moved: composer code** — `PendingPromptsPanel` and `ChatFooter` moved from `SessionView.jsx` to the new `Composer.jsx` (behaviour unchanged; `SessionView` imports `ChatFooter`). Two tests that grep source (B26 phone font size, agents-ux2 `/agent new`) now read `Composer.jsx`.

### Added
- `@` button in the composer (inserts `@` and opens the agent palette; typing `@` still works) — decision D7 asks `@` to stay visible.
- **Plan card**: a `TodoWrite` call renders as "Plan 2/4" with a checklist (D15 "Plan card (if a todo/plan event exists)"); in Simple mode it still folds into the summary row.
- Working indicator has a quiet shimmer (static under reduced motion). No timer, no Retry button (D15: needs defined semantics).
- Chat column is centred, max 48rem.

### Removed
- *(nothing)* — the "YOU" label above a user message is now visually hidden (`sr-only`), the recap tint of a turn's last message is gone (cosmetic).

### Restyled (per piece)
- **Messages** — assistant prose: Inter/Rubik 15px, no bubble; user message: neutral surface, hairline, no mint; hover row (time · copy · quote) is always visible on touch; attachment chips on the message.
- **Tool calls** — one muted row per call (lucide glyph per tool, name, target, `+N −M`, chevron; Radix Collapsible); Simple mode keeps ONE summary row per turn ("What happened behind the scenes · N actions" with the kind glyphs) that expands to the individual calls, and the "Edited N files" row. Thinking is a collapsible. Output: LTR monospace block, 5 lines then "more" / "show full (N KB)". Full mode shows the rows inline (the Simple/Terminal difference is unchanged — no group wrapper in Full).
- **Diff card** (`DiffCard.jsx`, behaviour unchanged: path, new-file badge, +/−, 14-line preview, show more/collapse, "not applied", 400-line cap link, copy path, lazy highlight) — Linear look: file glyph, tinted rows from the status tokens, sans header.
- **Cards** — `openui/primitives.jsx` (`CardFrame`, `Btn`, `ReceiptLine`, `ErrorNote`…) is now neutral: hairline card, small status dot (amber + pulse while it waits for you, green/red for outcomes), buttons are `ui/Button` (ONE `primary` per card). This restyles Permission, Question, Action (card + sticky bar), Setup, Screen request, Screenshot, Artifact, Merge, Agent draft, Ext, Delegated/adopt/auto lines, OpenUI blocks. Permission stays exactly as today: Allow / Deny, Enter-y / Esc-n, closed / expired states — **no "Always allow", no "Undo" (D8)**.
- **Setup / connect cards** (`setup/*`, `EngineConnect`): neutral surface, status as a dot (`Pill`), the two engine cards are equal and neutral (no double accent), `BTN`/`BTN2` in `setup/shared.jsx` are `ui/Button` classes. Glyphs go through `ChatIcon.jsx` (FontAwesome constants resolve to lucide).
- **Composer** — rounded card: textarea · attach · `@` · `/` (capabilities) · pill · context chip … Stop (while working) · Queue (while working) · mic · Send. Send is the only accent fill in the chat and only when there is something to send. Attachment chips, quote preview, drop zone, queue panel (count pill, auto-play switch, drag reorder, ▶ now, ✕), slash / mention palettes all kept and restyled (`SlashCommands.jsx`).
- **Chat mode switch** (Simple | Terminal) — neutral segmented control.
- **Chat text size** — pref `chatTextSize` (px of prose, 12–20, default 15; replaces `termFontSize`, a custom legacy value migrates). `applyBranding` sets `--chat-scale` (= px/15) on `<html>`; the transcript (`.term-events`), the composer field and the slash/mention menus scale with `zoom`, so line-height follows and `--ui-scale` stays separate. Controls: Settings › General › "Chat text size" (A−/slider/A+, reset, he+en live preview), the session header "…" › Text size ▸, and ⌘/Ctrl + / − / 0 while focus is in the chat (`lib/chatText.js`, `lib/chatTextShortcuts.js`; a toast shows the size). On touch the composer field never drops under 16px.

### Not done / decisions
- Syntax highlighting: **kept the existing lowlight highlighter** (not swapped to Shiki).
- The message list is **not virtualised** (windowing as before).
- `setup/shared.jsx`, `Wizard.jsx` consumers: `BTN`, `BTN2`, `PILL`, `Pill` — the Settings version won the merge (shared by Settings → Connections, wizard, Setup page and the chat setup cards).
- `MicButton` default box restyled (the rail passes its own className and keeps its size).
- Shared files touched: `index.css` (`.term`, `.md`, shimmer, chat column), `openui/primitives.jsx`, `SessionView.jsx` (ChatFooter removed, `ChatModeToggle` classes), `MicButton.jsx`, `locales/{en,he}/chat.js` (+`chat.plan`).
- Tests: `redesign-chat-web.test.js` added; `setup-web.test.js` (xmlns is not a link), `bugs1-web`, `agents-ux2-web` retargeted.

## Changes — Changes tab, diff, merge, orchestration, machine, screen panel

Branch `redesign/redesign-changes-vuh0`. Rule of the branch: **no feature disappears**. Decisions D1/D2 (consolidation.md): the review-and-merge model is KEPT — Request changes / Comment / Approve, the local merge, Explain, Auto review, Features, Work mode — restyled and organised only.

### Moved
- moved: **Open in VS Code** from the Changes header row to the `⋯` overflow menu (decision D2, option C). Still one menu click away; hidden on a phone as before.
- moved: Changes header, one row → two. Row 1 keeps actions (back/forward, mode switch, compare-against, Explain, Auto review, split/inline, refresh, `⋯`); the facts (branch, merge pill, `n files`, `explained`, `outdated`) moved to a quiet context line under it.
- moved: phone **file/feature list** from an inline collapsible panel to a bottom sheet (opened from the same "Files · n" bar).
- moved: the **Merge** control's primary-ness: when a review is approved and the Merge strip is showing, Merge is the view's one primary button and **Approve** steps back to a neutral button (accent budget: one primary per view). Both stay.

### Restyled (behaviour unchanged)
- **Changes tab** (`ChangesTab.jsx`): ui Button/Tabs/Badge/DropdownMenu/Popover+Command/Sheet/Tip; mode switch and split/inline and Local/Remote-PR are segmented controls; base picker is a Popover + Command (same search, groups, Default entry, Enter picks the first match); file rows use the list-row convention + `row-selected`; status letters coloured by status token, `+a −d` neutral-tokened; C/U markers, staged dot, comment count, explanation wand all kept; duplicate base names show their folder.
- **Diff** (`DiffView.jsx`): unified/split as before; line-number gutter with hairline; quieter add/del tints that work in light and dark through the new `--diff-*` tokens; long lines now **wrap** (indent kept) instead of scrolling every row on its own; split columns stay old-left/new-right in RTL; syntax colours are the shared `.diff-syntax` palette (same as the chat DiffCard); per-line "+" is always visible on touch.
- **Review comments** (`Comments.jsx`): quiet cards, ghost text actions (edit / reply / resolve / reopen / accept / reject / delete all kept), suggestion = violet-dot badge, resolved = ok-dot badge, replies nested under a 1px start hairline; composer is a ui Textarea with ⌘↵ / Esc as before.
- **Merge** (`MergeCard.jsx`): `MergePill` → `Badge` with a status dot; `MergePanel` uses ui Select / Checkbox / Button / Tip (strategy, delete-branch, Merge, Re-check, optional dismiss, disabled reason, conflict text). The `dark` (chat) face keeps native controls on the terminal palette so the chat card is unchanged in structure.
- **Orchestration** (`OrchestrationTab.jsx`): node cards with neutral status dots, relative time of the last report, deps chips, worker row (jump, branch, merge pill, Retry, Kill), result nested under a 1px hairline, group headers with dot + count.
- **Machine** (`Machine.jsx`): the rail strip and the Settings › Host panel use neutral numbers; pressure shows as a status dot and the bar fill only.
- **Screen panel / modal** (`ScreenSidePanel.jsx`, `ScreenModal.jsx`, `ScreenView.jsx` chrome): ui Button / Input / Badge / StatusDot; same controls (enlarge, collapse, Cancel, Take over, type-into-desktop, note, Done, setup verify Done, fullscreen, close, status labels, "browser window only" chip). The modal keeps its own portal shell and native `title`s on purpose — it is the Fullscreen-API target, and a kit tooltip portals to `<body>` and would sit behind a fullscreen element.

### Added (derived display only — no new product capability)
- Changes meta line: total `+added −deleted` across files (sum of the per-file counts already shown).
- Orchestration header: a progress rollup (`n of m done` + thin bar + per-state counts) and a **Needs you** strip listing blocked / errored / awaiting-input workers with an **Open** button that jumps to the worker (same jump as `→ worker`). No inline Approve (that is a new capability, D12 — not done here).
- i18n: `chat.orchProgress`, `chat.orchOpen` (en + he).
- Tokens (`index.css`, shared file, one block): `--diff-add-bg`, `--diff-del-bg`, `--diff-add-gutter`, `--diff-del-gutter`, `--diff-add-mark`, `--diff-del-mark`, `--diff-gap-bg`, `--diff-hunk-bg` (light + dark).

### Removed
- *(nothing)*

### For the integrator
- `index.css`: only the `--diff-*` block next to the `.diff-syntax` palette was added.
- `DiffCard.jsx` (chat) — resolved in integration: it now uses the same `--diff-*` tokens as the Changes diff.
- `MergePanel` is also rendered in the chat (`dark`), by ChatPane — its API did not change.
- Tests updated for intentional markup changes only: `bugs1-web.test.js` (B18 diff row sign glyph `−`, ChangesTab mode-switch wiring string).
- Phone tap targets: every control in the Changes / Orchestration / panel views measures ≥ 44px under a coarse pointer except the per-line "+" in the diff gutter (28px, rows are 28px tall on touch) and the checkbox glyph (its hit area is 40px via `after:-inset-3`).

## Settings — settings, onboarding wizard, agents, brain, skills, dialogs

### Moved
- *(nothing)* — every control stays where it was; Settings keeps its four categories (left list on desktop, tab row on phone) and the Advanced drawer.

### Removed
- *(nothing)*

### Added
- `AddConnectionPanel` export in `settings/AddConnection.jsx` (the panel body, testable without a portal).
- `aria-pressed` on wizard profile cards; `Tip` tooltips on icon-only controls.

### Changed
- Shared: `settings/shared.jsx` and `setup/shared.jsx` (BTN/INPUT constants are neutral ui-kit class strings; `Toggle` = ui `Switch`; `Segmented` neutral radio group; `StatusPill`/`Pill` = `Badge` with status dot; quiet section headings; hairline Advanced drawer).
- `ui/tooltip.jsx` (shared, minimal): `Tip` wraps itself in a `TooltipProvider` so it renders without `UiProvider` (SSR tests).
- Dialogs (`Dialogs.jsx` Overlay + six dialogs, ContextModal, BgProcesses, ScreenModal, ConnectDialog, AddConnection, Extensions install, ShortcutsHelp, AgentView delete) are ui `Dialog`; AgentView ⋯ menu and mobile tab switcher are `DropdownMenu`, details drawer a `Popover`; RepoPicker list is a `Popover`.
- Brain/Skills mode switches are `Tabs` (segmented); routines enable is a `Switch`.
- Accent now only on each view's primary button (+ logo bars in the wizard header).
- Native `<select>` kept where tests inspect options (Connections owner, AgentView model/kind/share days, language/mic selects), restyled with the INPUT class.
- Tests adjusted (behaviour unchanged): agent-page ⋯ menu, settings-audit2 Connections, f8, mcp-native, theme-tokens hero.

## QA round 1 (astra-ux / astra-mobile / astra-rtl)

Finding numbers: UX = astra-ux.md, M = astra-mobile.md, R = astra-rtl.md.

**Fixed**
- UX4 request changes left Approve/Merge on (also on master): the local verdict now replaces the approval with `review.state = changes-requested`; merge is refused even when forced; the pill reads "Changes requested". Test in `test/merge.test.js`.
- M9 history stopped at ~700 of 2,000 (also on master): `getChatPage` widens its read window until a full page before the cursor exists. `test/chat-pagination.test.js`.
- M1 Send clipped with large Hebrew UI: the composer pill shrinks, Send keeps its box.
- UX1 disconnected GitHub picker vanished: it stays with "Connect GitHub" (→ Settings › Connections).
- M10 system light ignored: Theme is System / Light / Dark (System default); chat theme has "Follow app" (also answers UX8: the Settings label explains app vs chat theme; single Appearance block now holds theme, chat theme, UI size, chat text size, accent).
- UX10, M2 unnamed controls: Field labels name their control; palette, composer, agent forms, secrets, search boxes, radio groups named (audit script: 67 unnamed → 0 over 13 routes).
- UX5, M6, M7 composer popover and segmented groups: named dialog, radio groups with arrow keys / Home / End (RTL-aware), one tab stop, focus lands on the current model and returns to the pill.
- UX6, M3, M4 contrast: `--term-faint`, `--term-dim`, `--term-accent-dim`, diff line numbers, syntax type colour ≥ 4.5:1; light focus ring = accent mixed 30% toward black (≥ 3:1), dark unchanged.
- M5 tap targets: switch/checkbox hit areas 44px, coarse min-width on text buttons, settings segmented/tab controls, refresh, diff "+" comment, tab bar.
- R1 clipped settings fields: rows wrap on phones. R2 card shell follows UI direction. R3/R4/R5 skill lists get markers and tables render in their own start edge. R6 code strings/comments isolate each Hebrew run. R7 context ratio LTR unit. R8 agent connections name/detail split. R9 artifact/screenshot units and clock isolated. R10 gear values translated. R11 A+/A− stay Latin.
- M8 initial JS: noVNC, highlighter, Settings, Launcher, Setup, Skills, Brain, Agents, palette, shortcuts, dialogs load on demand.
- UX7 gear shows chat view + text size + direction + chat theme (shortcuts kept); UX9 "VS Code" visible button in Changes; UX11 Triggers / New agent show text; UX12 "Find a setting" jump list in Settings, accent beside theme; UX13 orchestration section renamed "Needs attention" with a scope hint; UX2/UX3 local repo adds say "copying", optional steps read "waiting" / "no env files needed", no double "+".

**Not reproducible / already fixed on this branch**
- R3 English inheriting RTL in Brain and Orchestration rows (Md per-block direction landed earlier); R12 duplicate mobile titles (documented in the integration report; left).

**Left as decisions**
- UX7/D10 gear vs pill consolidation; D9 Simple/Terminal in the header menu; M "Skills" title translation gap (R12).

**Owner decisions applied in QA round 1:** D10 gear removed (every item ≤ 2 clicks: context chip 1; Restart / Clear / chat view / text size / display-for-this-chat via `…` = 2; direction, chat theme, UI size, text size, accent in Settings › Appearance); D12 inline Approve/Deny (permission), Answer (question), Review (finished branch) on Orchestration "Needs attention" rows, using only `POST /sessions/:id/permission/answer` and the child's own chat read — the first row's action is the only accent button; newest waiting card keeps the accent in a chat; chat theme default "Follow app", contrast of all chat colours checked in both themes (scan: 0 failures at 4.5:1 on chat EN/HE, 1440/390). Kept as is: Simple/Terminal in `…`, permission card Allow/Deny only, tool durations / Retry deferred, row +/- and CI dot only with data (skipped).
