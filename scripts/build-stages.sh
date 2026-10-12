#!/usr/bin/env bash
# Build stage JSON from Blender sources (T-103). Authoring guide: tools/blender/README.md.
#
#   bash scripts/build-stages.sh            # stages/src/<id>.{py,blend} → stages/<id>.json
#   bash scripts/build-stages.sh --check    # rebuild into a temp dir and diff with stages/*.json
#   bash scripts/build-stages.sh --test     # run tools/blender/tests/ inside Blender
#   BLENDER=/path/to/blender bash scripts/build-stages.sh ...
#
# Blender always runs headless (-b --factory-startup), one process per source.
# Per-source logs: .artifacts/stages/<id>.log (output is kept short on purpose).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
EXPORTER="$ROOT/tools/blender/export_stage.py"
SRC_DIR="$ROOT/stages/src"
LOG_DIR="$ROOT/.artifacts/stages"
MODE="${1:-build}"

die() {
  echo "build-stages: $*" >&2
  exit 1
}

if [ ! -x "$BLENDER" ] && ! command -v "$BLENDER" >/dev/null 2>&1; then
  die "Blender not found at '$BLENDER' (set BLENDER=/path/to/blender)"
fi

run_blender() { "$BLENDER" -b --factory-startup -noaudio --python-exit-code 1 "$@"; }

# Export every stages/src source into $1 (one <id>.json each; id = source basename).
export_all() {
  local out="$1" src id log failed=0
  local -a sources args
  shopt -s nullglob
  sources=("$SRC_DIR"/*.py "$SRC_DIR"/*.blend)
  shopt -u nullglob
  [ ${#sources[@]} -gt 0 ] || die "no sources in stages/src/"
  mkdir -p "$LOG_DIR"
  for src in "${sources[@]}"; do
    id="$(basename "${src%.*}")"
    log="$LOG_DIR/$id.log"
    if [[ "$src" == *.py ]]; then
      args=(-P "$EXPORTER" -- --source "$src" --out "$out" --expect-id "$id")
    else
      args=("$src" -P "$EXPORTER" -- --out "$out" --expect-id "$id")
    fi
    if run_blender "${args[@]}" >"$log" 2>&1; then
      grep '^\[stage\]' "$log" | grep -v ': wrote ' || true
    else
      echo "── $id failed (log: $log) ──"
      tail -n 30 "$log"
      failed=1
    fi
  done
  return "$failed"
}

# >>> T-203 hook: chain topopt calibrate here
# Runs after export_all on the freshly exported dir ($1, a temp dir in every mode), before
# anything is copied into or compared with stages/. Must be deterministic so --check holds.
#
# topopt (crates/topopt/README.md) scales loads and writes targets/benchmark. It reuses the
# committed stages/<id>.json as a cache when only calibrated data differs (one verification
# solve per stage); TOPOPT_FORCE=1 reruns the full SIMP sweep (e.g. after a solver change).
calibrate_hook() {
  local out="$1"
  local -a flags=(--write --quiet --cache "$ROOT/stages")
  [ "${TOPOPT_FORCE:-0}" = 1 ] && flags+=(--force)
  cargo run --release -q --manifest-path "$ROOT/Cargo.toml" -p topopt -- \
    calibrate "${flags[@]}" "$out"/*.json || die "topopt calibrate failed"
}
# <<< T-203 hook

# Compare the fresh build in $1 with the committed stages/*.json.
check_drift() {
  local out="$1" f name drift=0
  shopt -s nullglob
  for f in "$out"/*.json; do
    name="$(basename "$f")"
    if [ ! -f "$ROOT/stages/$name" ]; then
      echo "missing: stages/$name (run: bash scripts/build-stages.sh)"
      drift=1
    elif ! cmp -s "$f" "$ROOT/stages/$name"; then
      echo "drift: stages/$name differs from a fresh build (run: bash scripts/build-stages.sh)"
      diff -u "$ROOT/stages/$name" "$f" | head -n 40 || true
      drift=1
    fi
  done
  for f in "$ROOT"/stages/*.json; do
    if [ ! -e "$out/$(basename "$f")" ]; then
      echo "orphan: stages/$(basename "$f") has no source in stages/src/"
      drift=1
    fi
  done
  shopt -u nullglob
  return "$drift"
}

case "$MODE" in
  build | --check)
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    export_all "$tmp" || die "export failed"
    calibrate_hook "$tmp"
    if [ "$MODE" = "--check" ]; then
      check_drift "$tmp" || die "stages/*.json out of date"
      echo "✓ stages up to date ($(ls "$tmp"/*.json | wc -l | tr -d ' ') stages)"
    else
      cp "$tmp"/*.json "$ROOT/stages/"
      check_drift "$tmp" >/dev/null || echo "warning: stages/ has JSON without a source (see --check)"
      echo "✓ built $(ls "$tmp"/*.json | wc -l | tr -d ' ') stages → stages/"
    fi
    ;;
  --test)
    run_blender -P "$ROOT/tools/blender/tests/run_tests.py"
    ;;
  *)
    die "unknown option '$MODE' (use: [--check | --test])"
    ;;
esac
