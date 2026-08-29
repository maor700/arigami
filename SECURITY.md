# Security Policy

Arigami runs AI agents with real access to your files, shell, browser and
desktop. Please treat security reports as high priority, and please report
responsibly.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities through **GitHub private vulnerability reporting**:
open the repository's *Security* tab → *Report a vulnerability*. This
creates a private advisory that only maintainers can see.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal config, request, skill or session flow).
- The commit / version you tested against.

## What to expect

- Acknowledgement within **7 days**.
- A fix or mitigation plan within **90 days** of the report (coordinated
  disclosure). We will credit you in the advisory unless you prefer not to
  be named.
- If we cannot fix the issue in that window we will tell you why and agree
  on a new date.

## Scope and threat model

- The cockpit (`/__host/`, `/__api/`, `/__ws`, `/__vnc`) is designed for
  **localhost / private-network (tailnet) use** and must never be exposed
  to the public internet without the host's authentication layer enabled.
- **The cockpit is never funnelled**: signed share links and webhook
  endpoints are the only surfaces intended to be reachable without a
  cockpit session.
- Skills, memory writes and cron jobs are human-gated by design; a bypass
  of any of those gates is in scope.
- Prompt-injection that leads to unauthorized file/shell/browser actions
  is in scope when it crosses a documented gate.

The technical security model (auth modes, bind defaults, share tokens) is
documented in `docs/SECURITY.md` once available, and in `docs/SPEC.md`.

## Supported versions

Only the `master` branch and the latest tagged release receive security
fixes.
