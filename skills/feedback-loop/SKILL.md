---
description: Iterate on a fix with a strict edit → reload → verify → measure loop; catch regressions and virtual-list-style render loops early
---

# Feedback Loop

Use this when implementing or debugging a UI fix. Every change must be visually + structurally confirmed before being declared done.

## Pick the reproduction surface

Prefer in this order:

1. **Storybook story** — fastest, no auth, no backend. Either:
   - Modify an existing story to expose the case, or
   - Add a new story that renders the component in its real container.
2. **`bun run dev`** — only if Storybook can't reproduce. Backend is production; require user to log in.
3. **`app.example.com` tab** — last resort, read-only (changes won't take effect there).

Check what's already running before starting anything. In a worktree, ports are assigned in `.env.development.local` — read them first, fall back to the canonical 3000/6006:

```bash
# Read assigned ports if present
DEV_PORT=$(sed -n 's/^DEV_PORT=//p' .env.development.local 2>/dev/null)
STORYBOOK_PORT=$(sed -n 's/^STORYBOOK_PORT=//p' .env.development.local 2>/dev/null)
lsof -i :"${STORYBOOK_PORT:-6006}" -i :"${DEV_PORT:-3000}" 2>/dev/null
```

Use the worktree-assigned port for every URL in the loop — never assume 3000/6006.

## The loop

For every fix attempt:

1. **Edit** the code (small, focused change).
2. **Reload** Storybook/dev (Vite HMR usually handles it).
3. **Screenshot** the relevant area via `browser_take_screenshot`.
4. **Hover / interact** to trigger the state under test (`browser_hover` / `browser_click`).
5. **Measure the DOM** with `browser_evaluate` — don't trust the screenshot alone:
   - `scrollWidth > clientWidth` for truncation
   - `getComputedStyle(el)` for cursor/text-overflow
   - `data-state` for Radix open/closed
   - `[role="tooltip"]` presence + `data-side`
6. **Check console** for regressions:
   - Look for repeated `correction`, `getMeasurements`, or `calculateRange` from `react-virtual` — these mean a virtual-list height loop.
   - Look for React `Warning:` lines.
7. **Decide**: shipped → stop. Not shipped → adjust and loop.

## Anti-patterns the loop catches

- **Truncate set but no visible ellipsis** — `text-overflow: ellipsis` doesn't apply across flex children. Move `truncate` to a block-level child.
- **Tooltip on every item in a virtualized list** — Radix Tooltip per item with state changes during scroll causes height oscillation. Keep DOM structure stable across `open` flips: render the Tooltip wrapper always, compute `open` lazily via `onOpenChange`.
- **ResizeObserver + setState on mount** — combined with virtualization, items unmount with 0×0 dimensions and flip state back. Prefer a lazy `() => boolean` measurement called on hover, not a continuous observer.
- **Million.js / React Compiler quirks** — if state isn't updating where you expect, set a `window.__dbg = ...` from the callback and verify the function runs.

## Forcing UI states that the live data won't reach

Some bugs only manifest in states the dev environment never hits — e.g. an empty-state icon when the demo account always has data, an error state when the API never fails, a long-loading state. To visualize without code-path detective work:

**Recipe A — Storybook first** (preferred):

If the component takes the state via props, drive it from a story. No app edits needed. The Storybook tab is theme-aware via the existing `ModeDecorator` (light/dark toggle in the top-right).

**Recipe B — `browser_evaluate` patch** (no code edit):

For state that lives in React Query / Zustand / Redux, set the cache key directly from devtools. Example:

```ts
// Force empty agents list
window.__queryClient.setQueryData(['agents', { account: 'demo' }], [])
```

Requires the app to expose the store (most do in dev). Reverts on next refetch — perfect for one-off screenshots.

**Recipe C — Temporary file edit** (last resort):

If neither A nor B works, edit the rendering site to force the variant, capture, then revert **before commit**. Conventions:

1. Mark the edit with a `// TEMP: force <state> for visual check — revert before commit` comment so a missed revert shows up in code review.
2. Do the screenshot capture in the same loop iteration as the edit. Don't let the edit linger.
3. **Always** `git restore <file>` before staging anything. If `git status` shows the file still modified at ship-it time, you forgot to revert.

For the dashboard empty state specifically: the gate is in `src/modules/dashboardv2/components/dashboard-panels.tsx` at the conditional `!isLoading && dashboard.emptyState !== undefined`. Forcing it requires bypassing the `!== undefined` check — short edit, easy to revert.

## When stuck

- If two consecutive iterations don't reduce the diff between expected and actual, **stop and reconsider the approach** instead of tweaking more.
- If the issue might be virtualization-related: `lsof -i :6006` Storybook story for the same component (without the wrapper) to isolate.
- Always compare against the baseline: `git stash` your fix and re-run the same measurement — that tells you what your change actually affects.

## Capture AFTER (on successful exit)

Capture PNG frames with `browser_take_screenshot` and assemble them with `frames-to-gif.sh` — same shape as locate-ui used for BEFORE. The `.gif` artifact and canonical path (`/tmp/<issue>/after.gif`) are unchanged.

> **Screenshot path rule (verified):** `browser_take_screenshot` only writes inside the repo / `.playwright-mcp/` roots, won't create parent dirs, and resolves `filename` relative to the Playwright server cwd (the main repo, **not** the worktree). `mkdir` the frames dir under `.playwright-mcp/` first, pass a relative `.playwright-mcp/...` filename, then `frames-to-gif.sh` writes the `.gif` to `/tmp/<issue>/`.

```bash
source "${ARIGAMI_SKILLS:-$HOME/Desktop/repos/arigami/skills}/_lib/config.sh"
ISSUE_LOWER=$(git symbolic-ref --short HEAD | sed -n 's/^\(dem-[0-9]*\).*/\1/p' | tr '[:upper:]' '[:lower:]')
FRAMES="$PW_FRAMES_ROOT/${ISSUE_LOWER}/frames-after"
mkdir -p "$FRAMES" "/tmp/${ISSUE_LOWER}"
```

**Screenshot mode** (single-frame, static):

```
mcp__plugin_playwright_playwright__browser_take_screenshot(filename: ".playwright-mcp/<issue-lower>/frames-after/0000.png")
```

```bash
"$SKILLS_LIB"/frames-to-gif.sh "/tmp/${ISSUE_LOWER}/after.gif" "$FRAMES/0000.png"
```

**Video mode** — repeat the SAME interaction sequence the BEFORE recording used so the comparison is meaningful; one screenshot per step:

```
mcp__plugin_playwright_playwright__browser_take_screenshot(filename: ".playwright-mcp/<issue-lower>/frames-after/0000.png")  # initial
# ... same trigger interaction as BEFORE (browser_click / browser_type / browser_hover) ...
mcp__plugin_playwright_playwright__browser_take_screenshot(filename: ".playwright-mcp/<issue-lower>/frames-after/0001.png")  # final
```

```bash
"$SKILLS_LIB"/frames-to-gif.sh "/tmp/${ISSUE_LOWER}/after.gif" --dir "$FRAMES" --fps 2
```

**Animation mode** — for autoplaying / CSS-driven animations the user doesn't trigger (loading spinners, skeleton shimmers, fade-ins). Burst-fire screenshots with short `browser_wait_for` pauses between them to synthesize a real timeline:

```
mcp__plugin_playwright_playwright__browser_take_screenshot(filename: ".playwright-mcp/<issue-lower>/frames-after/0000.png")
mcp__plugin_playwright_playwright__browser_wait_for(time: 0.3)
mcp__plugin_playwright_playwright__browser_take_screenshot(filename: ".playwright-mcp/<issue-lower>/frames-after/0001.png")
mcp__plugin_playwright_playwright__browser_wait_for(time: 0.3)
# ... repeat screenshot + wait ~6 times; ~6 frames covers one full spinner rotation at 300ms ...
```

```bash
"$SKILLS_LIB"/frames-to-gif.sh "/tmp/${ISSUE_LOWER}/after.gif" --dir "$FRAMES" --fps 3
```

Gotchas:

- Pick the interval to be a non-integer fraction of the animation period — e.g. 300ms for a 1.2s spin lands frames ~90° apart rather than the same position every time.
- Number frames in capture order (`0000`, `0001`, …); the helper assembles them lexically.

The helper writes `/tmp/<issue>/after.gif` directly — overwrite any existing one (only the final iteration matters). Skip the capture entirely for non-UI tickets (pure refactor, chore).
