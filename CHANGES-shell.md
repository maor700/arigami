# Phase 2 — shell (rail, header, tab bar, palette, navigation, launcher)

Rule: no feature disappears. Everything below is still reachable.

## Moved
- Simple / Terminal view toggle: from the session header to the header "…" menu, a radio group "Chat view" (decision D9). 2 clicks.
- Engine name, ticket · branch: from the header row to the title tooltip and the top of the "…" menu (D11).
- Account chip ("runs on …"): from the header to the "…" menu; selecting it opens the accounts page (D11).
- Rail "Triggers" label: now a bolt icon button (tooltip + aria-label "Manage triggers") in the Pending header.
- "+ New agent": now a "+" icon button in the Team header (tooltip + aria-label).
- Row / folder / agent "···" menus: now ui DropdownMenu; rows and folders also open the same actions on right-click.
- Phone rail drawer: now a ui Sheet on the start edge (focus trap, Esc, backdrop tap).
- Add-tab "+" popover: ui Popover anchored to the button (⌘T still toggles it).
- Machine / Summary stay as ghost buttons in the header (D9 C); the terminal-controls gear stays (D10: the composer popover belongs to the chat area).

## Added
- "Needs you" group pinned at the top of the flat rail (D3 C); the sessions also stay in their own place below.
- ⌘/Ctrl+J: jump to the next session that needs you (D13 C); palette entry "Go to the next session that needs me"; cheat-sheet row.
- Palette entry "Switch language"; the palette shows sessions and commands on an empty query (was: sessions only).
- Row: PR badge (`#n` from metadata.pr / prNumber) and branch chip, when present. +/- totals and CI dot are not on the session data today, so not shown (D14).
- Rows are keyboard focusable (Enter/Space select); i18n keys `rail.needsYouGroup`, `rail.sessionsGroup`, `rail.commandsGroup`, `rail.scNextNeedsYou`, `chrome.palette.nextNeedsYou(.kw)`, `chrome.palette.language(.kw)`.

## Removed
- (nothing)

## Restyled (behaviour unchanged)
Rail (rows, folders, team, pending, archive, usage and machine mini, footer, profile menu), tab bar, session header, summary popover, listeners row and panel, progress strip, terminal controls menu and its pickers, context window dialog, ⌘K palette (cmdk), shortcuts dialog, pending/ticket previews, phone top bar, Launcher + extension pane + routine list (see launcher commits).

## Shared files touched (for the integrator)
- `ui/tooltip.jsx`: `Tip` also works without a TooltipProvider (adds its own), so SSR tests and isolated renders don't throw.
- `ui/command.jsx`: `CommandItem` keeps full opacity when cmdk sets `data-disabled="false"`.
- `lib/prefs.js`: default `railWidth` 248 → 264.
- `locales/{en,he}/rail.js` and `chrome.js`: appended keys at the end.
- Tests updated for the new markup (behaviour unchanged): rail-containment, agents-web, agents-ux1, agents-ux4 (menu items rendered with stand-in parts), plus the ones listed in the final report.
