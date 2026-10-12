#!/usr/bin/env bash
# Single entry point for every quality gate. Agents and CI run this; a task is not done
# until the relevant profile is green.
#
#   scripts/verify.sh            # = full
#   scripts/verify.sh fast       # tasks + rust fmt/clippy/test + ts typecheck/test + stage drift
#   scripts/verify.sh rust       # rust only
#   scripts/verify.sh web        # ts typecheck/test + web build
#   scripts/verify.sh full       # fast + Blender stage tests + wasm + web build + e2e + perf gate
#
# Logs: .artifacts/verify/<step>.log. Output is kept short on purpose (agent context).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PROFILE="${1:-full}"
LOG_DIR="$ROOT/.artifacts/verify"
mkdir -p "$LOG_DIR"

declare -a RESULTS=()
FAILED=0

step() {
  local name="$1"
  shift
  local log="$LOG_DIR/$name.log"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    RESULTS+=("PASS  $(printf '%-14s' "$name") $((SECONDS - start))s")
  else
    RESULTS+=("FAIL  $(printf '%-14s' "$name") $((SECONDS - start))s  → $log")
    FAILED=1
    echo "── $name failed (last 40 lines of $log) ──"
    tail -n 40 "$log"
  fi
}

skip() {
  RESULTS+=("SKIP  $(printf '%-14s' "$1") $2")
}

BLENDER_BIN="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
has_blender() { [ -x "$BLENDER_BIN" ] || command -v blender >/dev/null 2>&1; }
has_e2e() { [ -f apps/web/playwright.config.ts ]; }
has_bench_gate() { [ -f scripts/bench-gate.mjs ]; }

run_tasks() { step tasks node scripts/tasks.mjs check; }
run_rust() {
  step rust-fmt cargo fmt --all --check
  step rust-clippy cargo clippy --workspace --all-targets -- -D warnings
  step rust-test cargo test --workspace --quiet
}
run_ts() {
  [ -d node_modules ] || step pnpm-install pnpm install --frozen-lockfile
  step ts-typecheck pnpm -r --if-present typecheck
  step ts-test pnpm -r --if-present test
}
# Stage drift (committed stages/*.json == fresh Blender export). Local gate: CI has no Blender.
run_stages() {
  if has_blender; then step stages-check bash scripts/build-stages.sh --check; else skip stages-check "(no Blender)"; fi
}
run_stage_tests() {
  if has_blender; then step stages-test bash scripts/build-stages.sh --test; else skip stages-test "(no Blender)"; fi
}
run_wasm() {
  step wasm-build pnpm build:wasm
  step wasm-smoke node crates/fem-wasm/tests/node-smoke.mjs
}
run_web_build() { step web-build pnpm --filter @stress-carve/web build; }
run_e2e() {
  if has_e2e; then step e2e pnpm --filter @stress-carve/web e2e; else skip e2e "(no playwright config yet)"; fi
}
run_bench() {
  if has_bench_gate; then step perf-gate node scripts/bench-gate.mjs; else skip perf-gate "(no bench gate yet)"; fi
}

case "$PROFILE" in
  fast) run_tasks; run_rust; run_ts; run_stages ;;
  rust) run_rust ;;
  web) run_ts; run_web_build ;;
  full) run_tasks; run_rust; run_ts; run_stages; run_stage_tests; run_wasm; run_web_build; run_e2e; run_bench ;;
  *) echo "unknown profile '$PROFILE' (fast|rust|web|full)"; exit 2 ;;
esac

echo
echo "verify ($PROFILE):"
printf '  %s\n' "${RESULTS[@]}"
if [ "$FAILED" -ne 0 ]; then
  echo "✗ verify failed"
  exit 1
fi
echo "✓ verify passed"
