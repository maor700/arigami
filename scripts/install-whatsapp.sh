#!/usr/bin/env bash
# Shared by native install/update and Docker. Never removes pairing or data.
set -euo pipefail
WA_DIR="${ARIGAMI_WA_MCP_DIR:-$HOME/.local/lib/whatsapp-mcp}"
WA_REF=ce9b144a2327d44f4288ee400503e2dc06c7d2d5
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null && command -v npm >/dev/null || { echo 'WhatsApp requires Node >=22 and npm; rerun the Arigami installer.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1); require("node:sqlite")' >/dev/null
mkdir -p "$WA_DIR"
# A successful install is reusable offline; incomplete installs are repaired.
if [ -f "$WA_DIR/.arigami-bridge-v2" ] && [ -x "$WA_DIR/node_modules/.bin/tsx" ] && [ -f "$WA_DIR/node_modules/qrcode/package.json" ] && [ -f "$WA_DIR/src/arigami-status.ts" ] && [ -f "$WA_DIR/src/arigami-media.ts" ]; then
  echo 'WhatsApp bridge already installed'; exit 0
fi
if [ ! -f "$WA_DIR/src/main.ts" ]; then
  git -C "$WA_DIR" init -q
  git -C "$WA_DIR" fetch -q --depth 1 https://github.com/jlucaso1/whatsapp-mcp-ts "$WA_REF"
  git -C "$WA_DIR" checkout -q FETCH_HEAD
fi
node "$SCRIPTS/prepare-whatsapp.mjs" "$WA_DIR"
cd "$WA_DIR"
npm install --omit=dev --no-audit --no-fund --engine-strict=false
npm install --no-save --package-lock=false --omit=dev --no-audit --no-fund --engine-strict=false tsx@4.20.6 qrcode@1.5.4
node --input-type=module -e 'await import("@whiskeysockets/baileys"); await import("qrcode"); await import("node:sqlite")'
touch .arigami-bridge-v2
echo 'WhatsApp bridge installed; pairing and message data preserved'
