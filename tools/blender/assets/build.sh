#!/usr/bin/env bash
# Environment assets (T-307): procedural Blender scripts -> apps/web/public/assets.
#
#   bash tools/blender/assets/build.sh                 # glb + decal + manifest + icons + previews
#   bash tools/blender/assets/build.sh --no-previews   # skip the review renders
#   bash tools/blender/assets/build.sh --check         # rebuild into a temp dir and compare with the
#                                                      # committed files byte for byte (+ size budget)
#
# BLENDER overrides the Blender binary (default: the macOS app bundle). Always headless.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/tools/blender/assets"
OUT="$ROOT/apps/web/public/assets"
PREV="$HERE/previews"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"

MODE=build
PREVIEWS=1
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --no-previews) PREVIEWS=0 ;;
    -h | --help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -x "$BLENDER" ] && ! command -v "$BLENDER" >/dev/null 2>&1; then
  echo "Blender not found at '$BLENDER' (set BLENDER=/path/to/blender)" >&2
  exit 2
fi
VERSION="$("$BLENDER" --version 2>/dev/null | head -n 1)"
case "$VERSION" in
  "Blender 5.2"*) ;;
  *) echo "warning: built with Blender 5.2.x, found '$VERSION': --check may report byte differences" >&2 ;;
esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/stress-carve-assets.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
LOG="$TMP/blender.log"

blender_run() {
  if "$BLENDER" -b --factory-startup --python-exit-code 1 -P "$HERE/build_assets.py" -- "$@" >"$LOG" 2>&1; then
    grep '^\[assets\]' "$LOG" || true
  else
    grep '^\[assets\]' "$LOG" || true
    if ! grep -q 'CHECK FAIL' "$LOG"; then
      echo "── blender failed (last 40 lines of the log) ──" >&2
      tail -n 40 "$LOG" >&2
    fi
    return 1
  fi
}

verify_three() {
  if command -v node >/dev/null 2>&1; then
    node "$HERE/verify_three.mjs" "$ROOT/apps/web"
  else
    echo "[three] skipped: node not found"
  fi
}

if [ "$MODE" = check ]; then
  blender_run --out "$TMP/out" --check-against "$OUT"
  verify_three
  exit 0
fi

ARGS=(--out "$TMP/out" --icons)
if [ "$PREVIEWS" = 1 ]; then
  mkdir -p "$TMP/previews"
  ARGS+=(--previews "$TMP/previews")
fi
blender_run "${ARGS[@]}"

# replace the published assets (removes files that are no longer produced)
mkdir -p "$OUT"
find "$OUT" -mindepth 1 -delete
cp -R "$TMP/out/." "$OUT/"
if [ "$PREVIEWS" = 1 ]; then
  mkdir -p "$PREV"
  find "$PREV" -name '*.png' -delete
  cp "$TMP/previews/"*.png "$PREV/"
fi

python3 "$HERE/glbstat.py" "$OUT"/*.glb
verify_three
echo "all files in ${OUT#"$ROOT"/}: $(find "$OUT" -type f -exec cat {} + | wc -c | tr -d ' ') bytes (budget 1500000)"
