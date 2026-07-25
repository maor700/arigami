#!/usr/bin/env bash
# Assemble PNG frame(s) into a .gif — Playwright-era replacement for the
# claude-in-chrome gif_creator. Frames come from mcp__plugin_playwright_playwright__browser_take_screenshot.
#
# Usage:
#   frames-to-gif.sh OUT.gif FRAME.png [FRAME2.png ...]   # explicit frame list (1 frame = static gif)
#   frames-to-gif.sh OUT.gif --dir DIR [--fps N]          # all *.png in DIR, lexically sorted (default fps 2)
#
# Notes:
# - A single frame yields a 1-frame (static) GIF, matching the old "screenshot mode".
# - Multiple frames yield an animated GIF, matching the old "video mode".
# - Two-pass palettegen/paletteuse keeps quality high and size small (PR/Slack embeddable).
set -euo pipefail

OUT="${1:?output .gif path required}"; shift
FPS=2
FRAMES=()

if [[ "${1:-}" == "--dir" ]]; then
  DIR="${2:?dir required}"; shift 2
  if [[ "${1:-}" == "--fps" ]]; then FPS="${2:?fps value}"; shift 2; fi
  while IFS= read -r f; do FRAMES+=("$f"); done < <(ls -1 "$DIR"/*.png 2>/dev/null | sort)
else
  FRAMES=("$@")
fi

[[ ${#FRAMES[@]} -gt 0 ]] || { echo "frames-to-gif: no input frames" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
i=0
for f in "${FRAMES[@]}"; do
  [[ -f "$f" ]] || { echo "frames-to-gif: missing frame $f" >&2; exit 1; }
  printf -v n "%04d" "$i"; cp "$f" "$TMP/$n.png"; i=$((i+1))
done

mkdir -p "$(dirname "$OUT")"
PAL="$TMP/palette.png"
ffmpeg -y -framerate "$FPS" -i "$TMP/%04d.png" \
  -vf "palettegen=stats_mode=full" "$PAL" >/dev/null 2>&1
ffmpeg -y -framerate "$FPS" -i "$TMP/%04d.png" -i "$PAL" \
  -lavfi "paletteuse=dither=bayer:bayer_scale=3" -loop 0 "$OUT" >/dev/null 2>&1

echo "$OUT"
