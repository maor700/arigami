#!/bin/sh
# Keep packages installed with `sudo apt-get install` across container restarts.
# The root filesystem is the image's and resets on every restart; the volume
# (/data) doesn't. So every .deb dpkg installs is copied to the volume, and the
# entrypoint reinstalls the ones that are missing at the next start.
#
#   cache   apt's DPkg::Pre-Install-Pkgs hook: stdin = the .deb files about to be
#           installed (dependencies included). Keeps one per package+arch.
#   prune   apt's DPkg::Post-Invoke hook: drops cached debs whose package is no
#           longer installed (`apt-get remove` sticks across restarts too).
#   replay  entrypoint, as root: installs the cached debs whose package is not
#           installed — never a downgrade of what the image (or a newer image)
#           already ships. Retries once after `apt-get update` for a dependency
#           the cache doesn't hold.
#
# Wired by /etc/apt/apt.conf.d/90arigami-persist (Dockerfile). Never fails an
# apt run: a cache problem only costs persistence, not the install.
DIR="${ARIGAMI_APT_DIR:-/data/.arigami/apt}"
DEBS="$DIR/debs"

pkg_of() { # <file> → "<package>:<arch>" from the cache file name <package>_<arch>.deb
  b=$(basename "$1" .deb)
  echo "${b%_*}:${b##*_}"
}

installed() { # <package>:<arch>
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'
}

case "$1" in
  cache)
    mkdir -p "$DEBS" 2>/dev/null || exit 0
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      p=$(dpkg-deb -f "$f" Package 2>/dev/null) || continue
      a=$(dpkg-deb -f "$f" Architecture 2>/dev/null) || continue
      [ -n "$p" ] && [ -n "$a" ] || continue
      cp -f "$f" "$DEBS/.${p}_${a}.deb.tmp" 2>/dev/null && mv -f "$DEBS/.${p}_${a}.deb.tmp" "$DEBS/${p}_${a}.deb" 2>/dev/null
    done
    exit 0
    ;;
  prune)
    for f in "$DEBS"/*.deb; do
      [ -f "$f" ] || continue
      installed "$(pkg_of "$f")" || rm -f "$f"
    done
    exit 0
    ;;
  replay)
    set --
    for f in "$DEBS"/*.deb; do
      [ -f "$f" ] || continue
      installed "$(pkg_of "$f")" || set -- "$@" "$f"
    done
    [ $# -gt 0 ] || { echo "apt-persist: nothing to reinstall"; exit 0; }
    echo "apt-persist: reinstalling $# package(s) from $DEBS"
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y --no-install-recommends "$@" && exit 0
    apt-get update && apt-get install -y --no-install-recommends "$@"
    ;;
  *)
    echo "usage: $0 cache|prune|replay" >&2
    exit 2
    ;;
esac
