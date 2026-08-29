# Contributing to Arigami

Thanks for helping. This document covers the ground rules; the design docs
live in `docs/` (start with `docs/SPEC.md` and `docs/PLATFORM.md`).

## Developer Certificate of Origin (DCO) — required

Every commit **must** be signed off. By signing off you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the change or otherwise have the right to submit it under
the project license (Apache-2.0).

Add the sign-off with `git commit -s`, which appends a line like:

    Signed-off-by: Your Name <you@example.com>

Pull requests with unsigned commits will not be merged. Use
`git rebase --signoff` to fix existing commits.

## Licensing

- All contributions are licensed under **Apache-2.0** (see `LICENSE`).
  The copyright holder line used across the project is
  "Arigami contributors".
- **SPDX header policy:** new source files *may* start with
  `// SPDX-License-Identifier: Apache-2.0`. Headers are not required on
  every file — the repository-level `LICENSE` governs — but if you add
  one, use exactly that identifier.
- Do not add dependencies with copyleft licenses that would change the
  effective license of the distributed product (GPL/AGPL). MPL-2.0
  (file-level, e.g. noVNC) and permissive licenses are fine. Record
  vendored or ported code in `NOTICE`.

## Dev setup

Requirements: [Bun](https://bun.sh) ≥ 1.2, Node-compatible toolchain,
Git.

```sh
bun install                 # server deps
(cd web && bun install)     # cockpit UI deps
bun run dev                 # server on localhost:3099 (bun --watch)
(cd web && bun run dev)     # Vite dev server for the UI
```

Useful commands:

| Command | What |
|---|---|
| `bun test test/` | test suite |
| `bun run typecheck` (`npx tsc --noEmit`) | TypeScript check |
| `bun run build:web` | production UI build |
| `scripts/check-public-readiness.sh` | licensing / metadata sanity |

See `docs/DOCKER.md` for the container flow and `docs/ONBOARDING.md` for
first-run setup.

## Workflow

1. Branch from `master` (`feat/<topic>`, `fix/<topic>`). Working in a
   `git worktree` per task is the house style — it keeps the running
   instance on `master` untouched.
2. Keep changes focused. Add or update tests under `test/` for behaviour
   changes, and update `docs/SPEC.md` when you change a REST/MCP contract.
3. Before opening a PR make sure `bun test test/` and the typecheck pass
   (or don't regress), and that `scripts/check-public-readiness.sh` is
   green.
4. Open a PR against `master`. CI runs tests and the readiness check.
5. Never commit secrets, hostnames, IPs, tokens or personal data. `.env*`
   files and anything under your data dir are ignored on purpose.

## Reporting bugs and proposing features

Use GitHub Issues. For security problems follow `SECURITY.md` instead.
