#!/usr/bin/env bash
# Arigami installer — B1 (SPEC-ARIGAMI-DISTRIBUTION).
#
#   curl -fsSL https://raw.githubusercontent.com/maor700/arigami/master/install.sh | bash
#   bash install.sh [--server|--desktop|--no-desktop] [--unattended] [--dir DIR]
#                   [--user USER] [--profile <name|dir|git-url>] [--no-service]
#                   [--dry-run] [--repo URL] [--branch B] [update]
#
# Idempotent: every step checks before it acts, so re-running is a no-op and
# `install.sh update` is exactly what POST /__api/host/upgrade runs (git pull
# --ff-only → bun install → web build → restart). Debian/Ubuntu, Fedora, macOS
# and WSL are detected; anything else gets the plan printed and stops.
#
# Environment (all optional; `--unattended` persists the secrets to
# $ARIGAMI_DIR/env, mode 0600, which the systemd unit loads):
#   ARIGAMI_DIR          data dir           (default: <user home>/.arigami)
#   ARIGAMI_PORT         host port          (default: 3099)
#   ARIGAMI_PUBLIC_URL   external origin    (e.g. https://arigami.example.com)
#   ARIGAMI_ADMIN_EMAIL  admin user created by pairing
#   ARIGAMI_PROFILE      same as --profile
#   CLAUDE_CODE_OAUTH_TOKEN | ANTHROPIC_API_KEY | COMPOSIO_API_KEY | GH_TOKEN
set -euo pipefail

# ---- defaults ----------------------------------------------------------------
REPO_URL="${ARIGAMI_REPO:-https://github.com/maor700/arigami.git}"
BRANCH="${ARIGAMI_BRANCH:-master}"
MODE=""                 # server | desktop | "" (auto)
DESKTOP=""              # 1 | 0 | ""(auto: 0 on --server, 1 on desktop OSes)
UNATTENDED=0
NO_SERVICE=0
DRY_RUN=0
ACTION="install"        # install | update
INSTALL_DIR="${ARIGAMI_INSTALL_DIR:-}"
TARGET_USER="${ARIGAMI_USER:-}"
PROFILE="${ARIGAMI_PROFILE:-}"
PORT="${ARIGAMI_PORT:-3099}"

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server) MODE=server; [ -z "$DESKTOP" ] && DESKTOP=0 ;;
    --desktop) MODE=desktop; DESKTOP=1 ;;
    --no-desktop) DESKTOP=0 ;;
    --unattended) UNATTENDED=1 ;;
    --no-service) NO_SERVICE=1 ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --dir) INSTALL_DIR="${2:?--dir needs a path}"; DIR_EXPLICIT=1; shift ;;
    --dir=*) INSTALL_DIR="${1#*=}"; DIR_EXPLICIT=1 ;;
    --user) TARGET_USER="${2:?--user needs a name}"; shift ;;
    --user=*) TARGET_USER="${1#*=}" ;;
    --profile) PROFILE="${2:?--profile needs a source}"; shift ;;
    --profile=*) PROFILE="${1#*=}" ;;
    --repo) REPO_URL="${2:?--repo needs a URL}"; shift ;;
    --branch) BRANCH="${2:?--branch needs a name}"; shift ;;
    update|upgrade) ACTION=update ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 2 ;;
  esac
  shift
done

# ---- output helpers ----------------------------------------------------------
if [ -t 1 ]; then
  C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_D=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_G=""; C_Y=""; C_R=""; C_D=""; C_B=""; C_0=""
fi
step() { printf '\n%s==> %s%s\n' "$C_B" "$*" "$C_0"; }
ok()   { if [ "$DRY_RUN" = 1 ]; then printf '  %s→ would: %s%s\n' "$C_D" "$*" "$C_0"; else printf '  %s✓%s %s\n' "$C_G" "$C_0" "$*"; fi; }
skip() { printf '  %s·%s %s %s(already)%s\n' "$C_D" "$C_0" "$*" "$C_D" "$C_0"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*"; }
die()  { printf '%s✗ %s%s\n' "$C_R" "$*" "$C_0" >&2; exit 1; }
plan() { printf '  %s+ %s%s\n' "$C_D" "$*" "$C_0"; }

# run <cmd…> — print in dry-run, execute otherwise.
run() {
  if [ "$DRY_RUN" = 1 ]; then plan "$*"; return 0; fi
  "$@"
}

# ---- privilege + user plumbing ---------------------------------------------------
IS_ROOT=0; [ "$(id -u)" = 0 ] && IS_ROOT=1
have() { command -v "$1" >/dev/null 2>&1; }
SUDO=""
if [ "$IS_ROOT" = 0 ]; then
  if have sudo; then SUDO="sudo"; fi
fi
# as_root <cmd…> — package installs, unit files. Fails loudly without sudo.
as_root() {
  if [ "$DRY_RUN" = 1 ]; then plan "${SUDO:+$SUDO }$*"; return 0; fi
  if [ "$IS_ROOT" = 1 ]; then "$@"
  elif [ -n "$SUDO" ]; then sudo "$@"
  else die "need root or sudo for: $*"; fi
}
can_root() { [ "$IS_ROOT" = 1 ] || { [ -n "$SUDO" ] && sudo -n true 2>/dev/null; }; }

[ -z "$TARGET_USER" ] && { if [ "$IS_ROOT" = 1 ] && [ "${MODE:-}" = server ]; then TARGET_USER=arigami; else TARGET_USER="$(id -un)"; fi; }
SAME_USER=0; [ "$TARGET_USER" = "$(id -un)" ] && SAME_USER=1

user_home() {
  if [ "$SAME_USER" = 1 ]; then echo "$HOME"; return; fi
  if [ "$(uname -s)" = Darwin ]; then dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | awk '{print $2}'
  else getent passwd "$1" 2>/dev/null | cut -d: -f6; fi
}
# as_user <cmd…> — run as the target user (with their HOME + a PATH that sees bun/claude).
as_user() {
  local h; h="$(user_home "$TARGET_USER")"
  [ -z "$h" ] && h="/home/$TARGET_USER"
  if [ "$DRY_RUN" = 1 ]; then
    if [ "$SAME_USER" = 1 ]; then plan "$*"; else plan "sudo -u $TARGET_USER $*"; fi
    return 0
  fi
  if [ "$SAME_USER" = 1 ]; then
    HOME="$h" PATH="$h/.bun/bin:$h/.local/bin:$PATH" "$@"
  elif [ "$IS_ROOT" = 1 ]; then
    # shellcheck disable=SC2016  # the $1/$2… are for the child shell on purpose
    su -s /bin/bash "$TARGET_USER" -c 'HOME="$1" PATH="$1/.bun/bin:$1/.local/bin:$PATH" ARIGAMI_DIR="$2" ARIGAMI_PORT="$3" exec "${@:4}"' -- "$h" "$ARIGAMI_DIR" "$PORT" "$@"
  else
    sudo -u "$TARGET_USER" -H env "PATH=$h/.bun/bin:$h/.local/bin:$PATH" "ARIGAMI_DIR=$ARIGAMI_DIR" "ARIGAMI_PORT=$PORT" "$@"
  fi
}

# user_has <bin> — is <bin> on the TARGET user's PATH? Real check, even in --dry-run.
user_has() {
  local h; h="$(user_home "$TARGET_USER")"; [ -z "$h" ] && h="/home/$TARGET_USER"
  [ -x "$h/.bun/bin/$1" ] || [ -x "$h/.local/bin/$1" ] || command -v "$1" >/dev/null 2>&1
}
user_ver() { # user_ver <bin> [args] — first line of the version output (read-only, runs even in --dry-run)
  local h; h="$(user_home "$TARGET_USER")"; [ -z "$h" ] && h="/home/$TARGET_USER"
  HOME="$h" PATH="$h/.bun/bin:$h/.local/bin:$PATH" "$@" 2>/dev/null | head -1 || true
}

# ---- OS detection --------------------------------------------------------------
OS="unknown"; PKG="none"; ARCH="$(uname -m)"; WSL=0
case "$(uname -s)" in
  Darwin) OS=macos; PKG=brew ;;
  Linux)
    grep -qi microsoft /proc/version 2>/dev/null && WSL=1
    if [ -r /etc/os-release ]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      case "${ID:-} ${ID_LIKE:-}" in
        *debian*|*ubuntu*) OS=debian; PKG=apt ;;
        *fedora*|*rhel*|*centos*) OS=fedora; PKG=dnf ;;
      esac
    fi
    ;;
esac
HAVE_SYSTEMD=0; [ -d /run/systemd/system ] && have systemctl && HAVE_SYSTEMD=1
# Auto desktop: on a workstation OS default to the Xvfb stack; `--server` opts out.
if [ -z "$DESKTOP" ]; then
  if [ "$OS" = macos ] || [ "$WSL" = 1 ]; then DESKTOP=0; else DESKTOP=1; fi
fi
[ "$OS" = macos ] && [ "$DESKTOP" = 1 ] && { warn "the Xvfb desktop stack is Linux-only — skipping on macOS"; DESKTOP=0; }

# ---- paths ------------------------------------------------------------------------
if [ -z "$INSTALL_DIR" ]; then
  if [ "$IS_ROOT" = 1 ]; then INSTALL_DIR=/opt/arigami; else INSTALL_DIR="$HOME/.local/share/arigami"; fi
fi
TARGET_HOME="$(user_home "$TARGET_USER")"; [ -z "$TARGET_HOME" ] && TARGET_HOME="/home/$TARGET_USER"
ARIGAMI_DIR="${ARIGAMI_DIR:-$TARGET_HOME/.arigami}"
ENV_FILE="$ARIGAMI_DIR/env"
URL="http://127.0.0.1:$PORT"

step "Arigami ${ACTION} — plan"
printf '  os: %s%s (%s)%s   packages: %s   systemd: %s\n' "$OS" "$([ "$WSL" = 1 ] && echo '/WSL')" "$ARCH" "" "$PKG" "$([ "$HAVE_SYSTEMD" = 1 ] && echo yes || echo no)"
printf '  install dir: %s   data dir: %s   user: %s   port: %s\n' "$INSTALL_DIR" "$ARIGAMI_DIR" "$TARGET_USER" "$PORT"
printf '  desktop: %s   service: %s   unattended: %s   profile: %s%s\n' "$([ "$DESKTOP" = 1 ] && echo yes || echo no)" "$([ "$NO_SERVICE" = 1 ] && echo no || echo yes)" "$([ "$UNATTENDED" = 1 ] && echo yes || echo no)" "${PROFILE:-none}" "$([ "$DRY_RUN" = 1 ] && printf '   %sDRY RUN — nothing will change%s' "$C_Y" "$C_0")"
[ "$OS" = unknown ] && { warn "unsupported OS — install bun, node 22, git, gh, ripgrep, python3, ffmpeg and claude by hand, then re-run with --dry-run to see the rest"; [ "$DRY_RUN" = 1 ] || exit 1; }

# =================================================================================
# update — the B4-lite upgrade path, from the shell
# =================================================================================
do_update() {
  [ -d "$INSTALL_DIR/.git" ] || die "$INSTALL_DIR is not a git checkout — run install first"
  step "update $INSTALL_DIR"
  if [ "$DRY_RUN" = 0 ] && [ -n "$(git -C "$INSTALL_DIR" status --porcelain | grep -v '^??' || true)" ]; then
    die "repo has uncommitted changes — commit or stash them before upgrading"
  fi
  as_user git -C "$INSTALL_DIR" fetch --quiet --prune
  as_user git -C "$INSTALL_DIR" pull --ff-only --quiet
  build_repo
  step "restart"
  if [ "$NO_SERVICE" = 1 ]; then warn "--no-service: not restarting"; return 0; fi
  if [ "$HAVE_SYSTEMD" = 1 ] && systemctl cat arigami >/dev/null 2>&1; then
    as_root systemctl restart arigami
  else
    as_user "$INSTALL_DIR/bin/host" restart || warn "host restart failed — see bin/host logs"
  fi
  wait_healthy && ok "host back on $URL"
}

# =================================================================================
# packages
# =================================================================================
pkg_install() { # pkg_install <apt-names…> — installs the ones missing (dpkg/rpm/brew aware)
  local missing=() p
  for p in "$@"; do
    case "$PKG" in
      apt) dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p") ;;
      dnf) rpm -q "$p" >/dev/null 2>&1 || missing+=("$p") ;;
      brew) brew list --formula "$p" >/dev/null 2>&1 || brew list --cask "$p" >/dev/null 2>&1 || missing+=("$p") ;;
    esac
  done
  [ ${#missing[@]} -eq 0 ] && { skip "$*"; return 0; }
  case "$PKG" in
    apt) [ "${APT_UPDATED:-0}" = 1 ] || { as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq; APT_UPDATED=1; }
         as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}" ;;
    dnf) as_root dnf install -y -q "${missing[@]}" ;;
    brew) run brew install "${missing[@]}" ;;
  esac
  ok "installed: ${missing[*]}"
}

# Without root/sudo we cannot install packages: report what is missing and go on
# (the --no-service / tests path on a box that already has the toolchain).
NO_PKG=0
if ! can_root; then NO_PKG=1; fi
require_bins() { # require_bins <bin…> — warn about the missing ones
  local b missing=()
  for b in "$@"; do have "$b" || missing+=("$b"); done
  if [ ${#missing[@]} -gt 0 ]; then warn "no root/sudo — not installing packages; missing: ${missing[*]}"; else skip "toolchain present (no root/sudo, packages untouched)"; fi
}

install_base() {
  step "base packages"
  if [ "$NO_PKG" = 1 ] && [ "$PKG" != brew ]; then require_bins curl git rg python3 ffmpeg gh; return 0; fi
  case "$PKG" in
    apt) pkg_install ca-certificates curl git unzip ripgrep python3 ffmpeg
         # gh: Ubuntu ≥22.04 / Debian ≥12 ship it; older releases need GitHub's apt repo.
         if have gh; then skip gh; elif apt-cache show gh >/dev/null 2>&1; then pkg_install gh; else warn "gh not in apt — install it from https://cli.github.com later (only needed for GitHub auth inside sessions)"; fi ;;
    dnf) pkg_install ca-certificates curl git unzip ripgrep python3 gh
         if have ffmpeg; then skip ffmpeg; else pkg_install ffmpeg-free; fi ;;
    brew) have brew || die "Homebrew is required on macOS: https://brew.sh"
          pkg_install git gh ripgrep python ffmpeg ;;
  esac
}

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
install_node() {
  step "node 22 (claude CLI + whatsapp-mcp need it)"
  if have node && [ "$(node_major)" -ge 22 ] 2>/dev/null; then skip "node $(node -v)"; return 0; fi
  if [ "$NO_PKG" = 1 ] && [ "$PKG" != brew ]; then warn "no root/sudo — install node ≥22 yourself (https://nodejs.org)"; return 0; fi
  case "$PKG" in
    apt)
      if [ "$DRY_RUN" = 1 ]; then plan "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -"; plan "apt-get install -y nodejs"; return 0; fi
      curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash -
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs ;;
    dnf) pkg_install nodejs22 || pkg_install nodejs ;;
    brew) run brew install node@22; run brew link --overwrite --force node@22 ;;
  esac
  ok "node $(node -v 2>/dev/null || echo '(dry-run)')"
}

install_bun() {
  step "bun"
  if user_has bun; then skip "bun $(user_ver bun --version)"; return 0; fi
  if [ "$DRY_RUN" = 1 ]; then plan "curl -fsSL https://bun.sh/install | bash   (as $TARGET_USER)"; return 0; fi
  as_user bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null
  ok "bun $(as_user bun --version)"
}

install_claude() {
  step "claude CLI (native installer, self-updating)"
  if user_has claude; then skip "claude $(user_ver claude --version)"; return 0; fi
  if [ "$DRY_RUN" = 1 ]; then plan "curl -fsSL https://claude.ai/install.sh | bash   (as $TARGET_USER)"; return 0; fi
  as_user bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null || warn "claude installer failed — install it later: https://docs.claude.com/en/docs/claude-code/setup"
  user_has claude && ok "claude $(user_ver claude --version)"
  return 0
}

install_desktop() {
  [ "$DESKTOP" = 1 ] || return 0
  step "desktop stack (Xvfb :99 + VNC + Chrome)"
  if [ "$NO_PKG" = 1 ]; then require_bins Xvfb x11vnc openbox tint2 xdpyinfo; return 0; fi
  case "$PKG" in
    apt)
      pkg_install xvfb x11vnc openbox tint2 x11-utils fonts-noto
      if have google-chrome-stable || have google-chrome; then skip "google-chrome"
      elif [ "$ARCH" = x86_64 ]; then
        if [ "$DRY_RUN" = 1 ]; then plan "curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && apt-get install -y /tmp/chrome.deb"
        else
          tmp="$(mktemp -d)"
          curl -fsSLo "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
          as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$tmp/chrome.deb"
          rm -rf "$tmp"
          ok "google-chrome-stable"
        fi
      else
        # Google ships no arm64 deb; Chromium is the documented fallback (§7.4, CHROME_BIN).
        pkg_install chromium || pkg_install chromium-browser
        warn "arm64: installed chromium instead of Chrome — set CHROME_BIN=chromium in $ENV_FILE if the host does not find it"
      fi ;;
    dnf)
      pkg_install xorg-x11-server-Xvfb x11vnc openbox tint2 xorg-x11-utils google-noto-sans-fonts
      if have google-chrome-stable; then skip "google-chrome"
      elif [ "$ARCH" = x86_64 ]; then
        if [ "$DRY_RUN" = 1 ]; then plan "dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm"
        else as_root dnf install -y -q https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm; ok "google-chrome-stable"; fi
      else pkg_install chromium; fi ;;
  esac
}

# =================================================================================
# repo
# =================================================================================
clone_or_pull() {
  step "source → $INSTALL_DIR"
  if [ -d "$INSTALL_DIR/.git" ]; then
    if [ "$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)" != "$BRANCH" ]; then
      warn "checkout is on $(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null) (not $BRANCH) — leaving it alone"
    else
      as_user git -C "$INSTALL_DIR" pull --ff-only --quiet && ok "pulled $BRANCH"
    fi
    return 0
  fi
  # When run FROM a checkout (bash install.sh) and no --dir given, use that checkout.
  local here=""
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || here=""
  if [ -z "${ARIGAMI_INSTALL_DIR:-}" ] && [ "${DIR_EXPLICIT:-0}" = 0 ] && [ -n "$here" ] && [ -f "$here/server/index.ts" ] && [ -d "$here/.git" ] && [ "$INSTALL_DIR" != "$here" ]; then
    INSTALL_DIR="$here"; ok "using this checkout: $INSTALL_DIR"; return 0
  fi
  [ -d "$(dirname "$INSTALL_DIR")" ] || as_root mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ "$SAME_USER" = 0 ]; then
    as_root mkdir -p "$INSTALL_DIR"; as_root chown "$TARGET_USER:" "$INSTALL_DIR"
  elif [ ! -w "$(dirname "$INSTALL_DIR")" ]; then
    as_root mkdir -p "$INSTALL_DIR"; as_root chown "$(id -un):" "$INSTALL_DIR"
  fi
  as_user git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  ok "cloned $REPO_URL ($BRANCH)"
}

build_repo() {
  step "dependencies + web build"
  local log="${TMPDIR:-/tmp}/arigami-install-build.log"
  if [ "$DRY_RUN" = 1 ]; then
    as_user bun install --frozen-lockfile; as_user bash -c "cd web && bun install --frozen-lockfile && bun run build"; return 0
  fi
  as_user bash -c "cd '$INSTALL_DIR' && bun install --frozen-lockfile" >"$log" 2>&1 || { tail -20 "$log"; die "bun install failed (full log: $log)"; }
  ok "bun install"
  as_user bash -c "cd '$INSTALL_DIR/web' && bun install --frozen-lockfile && bun run build" >>"$log" 2>&1 || { tail -20 "$log"; die "web build failed (full log: $log)"; }
  ok "web/dist"
}

# =================================================================================
# data dir, env, user
# =================================================================================
ensure_user() {
  [ "$SAME_USER" = 1 ] && return 0
  step "service user $TARGET_USER"
  if id "$TARGET_USER" >/dev/null 2>&1; then skip "$TARGET_USER"; return 0; fi
  [ "$OS" = macos ] && die "create the user '$TARGET_USER' first (System Settings → Users) or run without --user"
  if have useradd; then as_root useradd --create-home --shell /bin/bash "$TARGET_USER"
  else as_root adduser --disabled-password --gecos '' "$TARGET_USER"; fi
  ok "created $TARGET_USER"
}

write_env() {
  step "data dir $ARIGAMI_DIR"
  as_user mkdir -p "$ARIGAMI_DIR/run" "$ARIGAMI_DIR/logs"
  [ "$UNATTENDED" = 1 ] || { ok "$ARIGAMI_DIR"; return 0; }
  # Merge KEY=VALUE for the vars that are set; never print their values.
  local keys=(ARIGAMI_PORT ARIGAMI_PUBLIC_URL ARIGAMI_ADMIN_EMAIL CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY COMPOSIO_API_KEY GH_TOKEN) k v written=()
  if [ "$DRY_RUN" = 1 ]; then
    for k in "${keys[@]}"; do [ -n "${!k:-}" ] && written+=("$k"); done
    plan "write $ENV_FILE (0600) with: ${written[*]:-nothing set}"; return 0
  fi
  local tmp; tmp="$(mktemp)"
  [ -f "$ENV_FILE" ] && cat "$ENV_FILE" >"$tmp"
  # B3: tells the host to pre-complete the first-run wizard (skippable steps).
  export ARIGAMI_UNATTENDED=1; keys+=(ARIGAMI_UNATTENDED)
  for k in "${keys[@]}"; do
    v="${!k:-}"; [ -n "$v" ] || continue
    grep -v "^$k=" "$tmp" >"$tmp.n" || true; mv "$tmp.n" "$tmp"
    printf '%s=%s\n' "$k" "$v" >>"$tmp"
    written+=("$k")
  done
  if [ ${#written[@]} -gt 0 ]; then
    as_user install -m 0600 "$tmp" "$ENV_FILE"; ok "$ENV_FILE ← ${written[*]}"
  else skip "env (no ARIGAMI_*/token vars set)"; fi
  rm -f "$tmp" "$tmp.n"
}

# =================================================================================
# service
# =================================================================================
install_service() {
  step "service"
  if [ "$NO_SERVICE" = 1 ]; then
    warn "--no-service: not installing a supervisor. Start by hand:  ARIGAMI_DIR=$ARIGAMI_DIR $INSTALL_DIR/bin/host start"
    return 0
  fi
  if [ "$OS" = macos ]; then as_user "$INSTALL_DIR/bin/host" install; return 0; fi
  [ "$HAVE_SYSTEMD" = 1 ] || { warn "no systemd here (WSL1 / container?) — run:  $INSTALL_DIR/bin/host start   (docs/DEPLOY.md for other supervisors)"; return 0; }
  can_root || [ "$DRY_RUN" = 1 ] || { warn "no root/sudo — install the unit later:  $INSTALL_DIR/bin/host render-unit | sudo tee /etc/systemd/system/arigami.service; sudo systemctl enable --now arigami"; return 0; }
  if [ "$DRY_RUN" = 1 ]; then
    plan "bin/host render-unit → /etc/systemd/system/arigami.service (User=$TARGET_USER, ARIGAMI_DIR=$ARIGAMI_DIR)"
    plan "systemctl daemon-reload && systemctl enable --now arigami"; return 0
  fi
  # Render from deploy/systemd with the TARGET user's paths (bin/host render-unit
  # substitutes __USER__/__HOME__/__BUN_DIR__ from its own environment).
  local tmp; tmp="$(mktemp)"
  as_user "$INSTALL_DIR/bin/host" render-unit >"$tmp"
  # Non-default data dir: the unit hardcodes $HOME/.arigami, override it.
  if [ "$ARIGAMI_DIR" != "$TARGET_HOME/.arigami" ]; then
    sed -i.bak -e "s#^Environment=ARIGAMI_DIR=.*#Environment=ARIGAMI_DIR=$ARIGAMI_DIR#" -e "s#^EnvironmentFile=.*#EnvironmentFile=-$ENV_FILE#" "$tmp"; rm -f "$tmp.bak"
  fi
  as_root install -m 0644 "$tmp" /etc/systemd/system/arigami.service; rm -f "$tmp"
  as_root systemctl daemon-reload
  as_root systemctl enable --now arigami
  ok "systemd unit arigami.service enabled + started"
}

wait_healthy() {
  [ "$DRY_RUN" = 1 ] && return 0
  local i=0
  while [ $i -lt 120 ]; do
    curl -fsS -m 2 "$URL/__api/config" >/dev/null 2>&1 && return 0
    sleep 0.5; i=$((i + 1))
  done
  return 1
}

apply_profile() {
  [ -n "$PROFILE" ] || return 0
  step "profile bundle $PROFILE"
  # bin/host decides: host up → staged as $ARIGAMI_DIR/pending-profile for the
  # wizard; host down (--no-service) → applied in-process right now.
  as_user "$INSTALL_DIR/bin/host" profile apply "$PROFILE" || warn "profile not applied — retry later: bin/host profile apply $PROFILE"
}

finish() {
  step "done"
  if [ "$NO_SERVICE" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    printf '  start:   ARIGAMI_DIR=%s %s/bin/host start\n' "$ARIGAMI_DIR" "$INSTALL_DIR"
    printf '  doctor:  %s/bin/host doctor\n' "$INSTALL_DIR"
    return 0
  fi
  if ! wait_healthy; then
    warn "host did not answer on $URL/__api/config within 60s — check: journalctl -u arigami -n 50  /  $INSTALL_DIR/bin/host doctor"
    return 0
  fi
  local i=0 code="" public="${ARIGAMI_PUBLIC_URL:-}"
  while [ $i -lt 20 ] && [ -z "$code" ]; do code="$(cat "$ARIGAMI_DIR/run/pairing-code" 2>/dev/null || true)"; [ -z "$code" ] && sleep 0.5; i=$((i + 1)); done
  printf '\n  %sArigami is running.%s\n' "$C_G" "$C_0"
  printf '  cockpit:      %s/__host/\n' "${public:-$URL}"
  [ -n "$public" ] && printf '  local:        %s/__host/\n' "$URL"
  if [ -n "$code" ]; then printf '  pairing code: %s%s%s   (enter it once in the cockpit → creates the admin)\n' "$C_B" "$code" "$C_0"
  else printf '  pairing code: %s\n' "$([ -f "$ARIGAMI_DIR/users.json" ] && echo 'not needed (admin already paired)' || echo "run: $INSTALL_DIR/bin/host pair")"; fi
  [ -n "$PROFILE" ] && printf '  profile:      %s (finish in Setup → Profile, or: bin/host profile apply pending)\n' "$PROFILE"
  printf '  manage:       %s/bin/host status|logs -f|doctor|restart      update: bash %s/install.sh update\n' "$INSTALL_DIR" "$INSTALL_DIR"
  [ "$DESKTOP" = 0 ] && printf '  %sno desktop stack: request_screen / browser sessions need --desktop%s\n' "$C_D" "$C_0"
  return 0
}

# =================================================================================
main() {
  if [ "$ACTION" = update ]; then do_update; return 0; fi
  ensure_user
  install_base
  install_node
  install_bun
  install_claude
  install_desktop
  clone_or_pull
  build_repo
  write_env
  install_service
  apply_profile
  finish
}
main
