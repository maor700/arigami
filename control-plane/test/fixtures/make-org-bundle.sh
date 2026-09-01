#!/usr/bin/env bash
# Build the FAKE org profile bundle the K8S-3 pilot proof seeds tenants with —
# a stand-in for a real company's bundle repo (never the operator's private
# profiles). Output: <outdir>/fake-org-bundle.git, a bare repo prepared for
# dumb-HTTP cloning (git update-server-info), servable by any static file
# server — the pilot serves it to the cluster via serve-dir.ts on
# host.k3d.internal.
#
#   ./make-org-bundle.sh <outdir> [bundle-url-for-repos-entry]
set -euo pipefail
OUT="${1:?usage: make-org-bundle.sh <outdir> [bundle-url]}"
BUNDLE_URL="${2:-http://host.k3d.internal:18092/fake-org-bundle.git}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/skills/org-onboarding" "$WORK/memory-seed" "$WORK/agents/org-helper"

cat > "$WORK/profile.json" <<JSON
{
  "name": "fake-org",
  "version": "1.0.0",
  "title": "Fake Org (K8S-3 pilot fixture)",
  "description": "Throwaway org bundle for the k3d pilot proof. Placeholder content only.",
  "repos": [
    { "name": "org-handbook", "source": "$BUNDLE_URL" }
  ],
  "plugins": [],
  "workflows": [],
  "issueSource": "none",
  "settings": { "voiceLang": "en" }
}
JSON

cat > "$WORK/skills/org-onboarding/SKILL.md" <<'MD'
---
description: Fake Org's onboarding checklist skill (K8S-3 pilot fixture, placeholder content)
---

# Org onboarding

Welcome to Fake Org. This skill exists to prove org bundles land in tenants.
MD

cat > "$WORK/memory-seed/MEMORY.md" <<'MD'
- Fake Org's memory seed marker: FAKE-ORG-SEED-1 (K8S-3 pilot fixture)
MD
cat > "$WORK/memory-seed/USER.md" <<'MD'
- A Fake Org employee (placeholder profile seeded by the org bundle).
MD

cat > "$WORK/cron.json" <<'JSON'
[
  {
    "name": "org-daily-checkin",
    "prompt": "Post the Fake Org daily check-in (placeholder task).",
    "schedule": { "kind": "cron", "value": "0 9 * * *" },
    "enabled": true
  }
]
JSON

cat > "$WORK/agents/org-helper/agent.json" <<'JSON'
{ "slug": "org-helper", "name": "Org Helper", "description": "Fake Org's shared helper agent (pilot fixture)" }
JSON
cat > "$WORK/agents/org-helper/persona.md" <<'MD'
You are Fake Org's helper agent. Placeholder persona for the K8S-3 pilot proof.
MD

cat > "$WORK/README.md" <<'MD'
# Fake Org bundle (K8S-3 pilot fixture)

Applied to every pilot tenant via ARIGAMI_BUNDLE on first boot. Placeholders only.
MD

git -C "$WORK" init -q -b main
git -C "$WORK" -c user.email=pilot@fake-org.test -c user.name="Fake Org Pilot" add -A
git -C "$WORK" -c user.email=pilot@fake-org.test -c user.name="Fake Org Pilot" commit -qm "fake-org bundle v1.0.0 (pilot fixture)"

mkdir -p "$OUT"
rm -rf "$OUT/fake-org-bundle.git"
git clone -q --bare "$WORK" "$OUT/fake-org-bundle.git"
git -C "$OUT/fake-org-bundle.git" update-server-info
echo "org bundle ready: $OUT/fake-org-bundle.git (serve $OUT over HTTP; clone URL: $BUNDLE_URL)"
