---
description: Explain this session's git changes in the host Changes tab — a summary per changed file plus cross-file "feature" write-ups, in the language the user asked. Read-only; run from the main session.
---

# Explain Changes

Generate human explanations of the session's uncommitted changes and surface them
in the host **Changes** tab: one summary per changed file, plus cross-file
**feature** write-ups that group related edits into the story of what was built.
Run inside the session whose worktree holds the changes — the host injects
`ARIGAMI_SESSION_ID`, which the MCP tool uses automatically.

## Language

Write every explanation (`summary`, `title`, `details`) in the language the user
used to ask — Hebrew request → explain in Hebrew, Spanish → Spanish, etc. If they
named a language explicitly, use that. Set the `language` field to the human name
of that language (e.g. `"Hebrew"`). Leave file paths, identifiers, and code
tokens unchanged. For right-to-left languages (Hebrew, Arabic, Farsi) set
`dir: "rtl"` on each file/feature entry so it renders right-aligned; otherwise
omit `dir` (defaults to auto-detect).

## Comparison base

By default you explain the **uncommitted** changes (working tree vs `HEAD`). If
the user asks to compare against something else — "explain what changed vs main",
"…vs commit abc1234", "…since branch X" — use that ref as the base: diff against
it, and pass it as `base` to the MCP tool so the Changes tab opens on that
comparison. Base `HEAD` (or omitted) = uncommitted.

## Steps

1. **Read the changes** — run git in the session's **worktree** (where you've
   been working; the host records it as `metadata.worktree`), which may differ
   from the spawn cwd. For uncommitted (default):
   ```bash
   git status --porcelain=v1
   git diff HEAD            # staged + unstaged vs HEAD
   ```
   For a comparison base `<ref>` (e.g. `main`):
   ```bash
   git diff --stat <ref>    # files changed working-tree-vs-<ref>
   git diff <ref>           # the full diff
   git ls-files --others --exclude-standard   # new untracked files (also "different")
   ```
   Untracked / new files are additions — read them to see what they add. Read
   enough of each diff to understand *intent*; open the full file when ambiguous.

2. **Per file** — for every changed file, write 1–3 sentences: what changed and
   why (the purpose, not a line-by-line restatement).

3. **Per feature (cross-file)** — group related files into coherent features. A
   feature is one capability that spans several files (e.g. "Background-process
   panel" = server registry + API route + React panel). For each, give a `title`,
   a `summary` (what it does / why), the `files` it touches, and optional
   `details` (a longer walkthrough of how the pieces fit together). A file may
   appear in more than one feature; a file with no cross-file story can be omitted
   from features (its per-file summary still shows).

4. **Publish** with a single MCP call:
   ```
   mcp__arigami__set_changes_explanation({
     language: "<language name>",
     base:     "<ref>",   // omit or "HEAD" for uncommitted; else the compared branch/commit
     files:    [{ path, summary }, ...],
     features: [{ title, summary, files: ["path", ...], details? }, ...],
   })
   ```
   This stores the explanations and opens the Changes tab. The user then sees each
   file's summary above its diff, and the feature write-ups in a Features list.

## Notes

- Explanations reflect the diff at the moment you run — re-run after further edits.
- Read-only: do **not** commit, push, stage, or modify files.
- If `git status` is clean, tell the user there's nothing to explain and stop.
