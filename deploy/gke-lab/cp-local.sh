#!/usr/bin/env bash
# Run the control plane on a machine OUTSIDE the cluster (used with chisel.yaml/tunnel.sh) — the lab shortcut for when
# you cannot create the ClusterRole the in-cluster chart needs. Reads its settings from the environment:
#   DOMAIN             public hostname (the apex serves this process)
#   OIDC_CLIENT_ID / OIDC_CLIENT_SECRET   a Google OAuth *web* client whose redirect URI is https://$DOMAIN/auth/callback
#   ALLOWED_DOMAINS    comma-separated e-mail domains allowed to sign up (the consent screen should be "Internal")
#   KUBECONFIG         pointing ONLY at the lab cluster (the control plane installs/deletes namespaces there)
#   DB                 sqlite path (default ./control-plane.db) — a fresh DB means the next sign-in becomes org-admin
set -euo pipefail
: "${DOMAIN:?}" "${OIDC_CLIENT_ID:?}" "${OIDC_CLIENT_SECRET:?}" "${ALLOWED_DOMAINS:?}" "${KUBECONFIG:?}"
cd "$(dirname "$0")/../../control-plane"
export CP_PORT="${CP_PORT:-18090}" CP_PUBLIC_URL="https://${DOMAIN}" CP_TRUST_PROXY=1 CP_DB_PATH="${DB:-$PWD/control-plane.db}"
export CP_OIDC_ISSUER="${OIDC_ISSUER:-https://accounts.google.com}" CP_OIDC_CLIENT_ID="$OIDC_CLIENT_ID" CP_OIDC_CLIENT_SECRET="$OIDC_CLIENT_SECRET"
export ALLOWED_EMAIL_DOMAINS="$ALLOWED_DOMAINS" CP_ORG_DOMAIN="$DOMAIN" CP_URL_SCHEME=https
export CP_INGRESS_NAMESPACES=edge # the tenant NetworkPolicy admits the edge namespace — and nothing else
export CP_HELM_CHART_PATH="$PWD/../deploy/helm/arigami-tenant" CP_HELM_EXTRA_VALUES="$PWD/../deploy/gke-lab/tenant-values.yaml"
export CP_IMAGE_REPOSITORY="${TENANT_IMAGE:-ghcr.io/maor700/arigami}" CP_IMAGE_TAG="${TENANT_TAG:-latest}"
[ -n "${PROFILE_BUNDLE:-}" ] && export CP_ARIGAMI_BUNDLE="$PROFILE_BUNDLE"   # git URL of the org profile repo
[ -n "${PROFILE_GIT_TOKEN:-}" ] && export CP_ARIGAMI_GIT_TOKEN="$PROFILE_GIT_TOKEN" # read-only token for it
exec bun src/index.ts
