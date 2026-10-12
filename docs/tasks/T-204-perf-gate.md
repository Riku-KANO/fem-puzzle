---
id: T-204
title: Phase 0 performance gate — native + WASM benchmarks, budget, report
status: review
phase: 0
depends: [T-201, T-202]
owns:
  - crates/fem-bench/**
  - scripts/bench-gate.mjs
  - scripts/bench-wasm.mjs
  - docs/perf-budget.json
  - docs/perf-results.md
touches:
  - Cargo.toml   # add crates/fem-bench to workspace members
verify:
  - cargo run -p fem-bench --release -- --json
  - pnpm build:wasm
  - node scripts/bench-gate.mjs
---
## Goal
Design doc: 性能見積もりと制約 / ロードマップ Gate 0. Replace the desk estimates with
measurements and make performance a regression gate that `scripts/verify.sh full` runs.

## Requirements
- `crates/fem-bench` (binary crate, separate so it can be built while `crates/fem` is in
  progress) `--json`: for 24×8×4, 32×8×8, 32×12×12, 40×12×12, 60×20×20: cold solve,
  warm re-solve after a 3×3 surface carve (median of 10 random carves), iterations, for
  Jacobi and MG, `tol = 1e-4`. JSON to stdout.
- `scripts/bench-wasm.mjs`: same scenarios through the built `crates/fem-wasm/pkg` in Node
  (single thread, SIMD on), JSON to `.artifacts/bench/wasm.json`.
- `docs/perf-budget.json`: limits per grid (start with: warm carve W1 ≤ 0.1 s,
  W4 ≤ 0.5 s in WASM) and an allowed regression ratio vs the last recorded baseline.
- `scripts/bench-gate.mjs`: runs both benches (or reads fresh artifacts), compares to the
  budget, prints a compact table, exits non-zero on violation.
- `docs/perf-results.md`: the table that replaces the design doc's estimate table, machine
  info, and the Gate 0 verdict (pass/fail + what to do if fail).

- Reuse T-202's Node smoke harness ideas (`crates/fem-wasm/tests/node-smoke.mjs`: cantilever
  generator, chunked iterate loop) for the WASM bench.
- Provide the perf signal early: as soon as the harness runs, tell T-201 (multigrid) how to run
  it so they can iterate against it.

## Acceptance criteria
- [x] `node scripts/bench-gate.mjs` passes on this machine (or the task stays `blocked`
      with a written analysis and a proposed follow-up task).
- [x] `verify.sh full` picks the gate up automatically (it does when the script exists).

## Log

### 2026-10-12 — T-204 worker (early start, then on main a527280)

**Merges into this branch:** T-202 branch `96917ae` (with T-101 `8d44d07`), T-101 `5fd36c5`,
T-201 `5a6dcd3`, `main` `2b17d1a` (T-101 + T-202 integrated), T-201 `cff41b2` / `21314d5`
(final), and `main` `a527280` (T-201 integrated). The only edit outside `owns` is the
workspace member `crates/fem-bench` in the root `Cargo.toml`.

**What was built**
- `crates/fem-bench` is a binary crate with a lib for its tests. It defines the scenarios:
  a solid cantilever per grid (same generator as T-202's node smoke), `tol` 1e-4, a cold
  solve (setup + solve, median of 3), and warm solves (`set_solid` of a 3×3 top-surface
  patch + `solve()`, warm-started, with the median and max over 10 mulberry32(42) patches;
  each patch is undone before the next). It also times post-processing. It requests
  Jacobi and Multigrid and reports what actually ran (`levels > 0` ⇒ multigrid).
  - `--json` writes JSON to stdout and the table to stderr. Filters: `--grid`, `--precond`,
    `--carves`, `--repeats`, `--tol`, `--seed`.
  - Seven unit tests, including a test that pins the Rust mulberry32 and the carve centres
    to the JS output, so native and WASM carve exactly the same voxels.
- `scripts/bench-wasm.mjs` is the same scenario through the `fem-wasm` `Session` in Node.
  It writes `.artifacts/bench/wasm.json`. It checks that SIMD is really in the binary
  (v128 locals in the code section: 15 functions). `FEM_WASM_PKG` overrides the pkg dir.
  It is separate from the smoke test, as main asked (smoke = correctness, bench = budget).
- `docs/perf-budget.json` has these WASM multigrid limits:
  - warm median: W1 ≤ 100 ms (task); W2 and W3 ≤ 500 ms (design doc: "up to W4/W5 within
    0.5 s"); W4 ≤ 500 ms (Gate 0);
  - W4 worst carve ≤ 500 ms and W4 stage load (setup + cold) ≤ 1 s.

  It also sets `requireMultigrid`, the regression thresholds and the recorded `baseline`.
- `scripts/bench-gate.mjs` runs both benches (or `--reuse` the artifacts) and checks four
  things: convergence, that multigrid really ran, the limits, and regression vs the
  baseline. Iteration counts are compared on any machine (×1.25 and +2). Times are compared
  only when the CPU model equals the baseline's (×2 and +5 ms), so CI's x86 runners check
  iterations and limits only.
  - It prints a compact table. `--markdown` prints the docs table and `--record` stores the
    baseline (it refuses on hard failures). `--only native|wasm` limits the targets.
  - It warns when `crates/fem-wasm/pkg` is older than the Rust sources.
  - Exit codes: 0 pass, 1 violation, 2 harness error. `PERF_BUDGET=<file>` overrides the
    budget.
  - The failure paths were checked: a 1 ms W1 limit gives exit 1, and a tampered baseline
    reports iteration and time regressions (and skips times on a different CPU).
  - A row with a time violation is re-measured once, and the gate judges the faster of the
    two runs. This was added after `verify.sh full` failed once on noise: 60×20×20 WASM
    Jacobi cold went ×2.85 while other agents' builds pushed the load average to 14.
    `verify.sh full` then passed (perf-gate 62 s).
- `docs/perf-results.md` holds the measured table that replaces the design doc's estimate
  table, the full results, machine/build info, the method, the gate description, what to do
  if it fails, a known issue and caveats.

**Measurements** (main `a527280`, Apple M5 Pro, WASM in Node 26, 1 thread). WASM MGCG warm
carve: W1 2.3 ms (12 it), W2 6.5 ms, W3 9.3 ms, W4 14.1 ms (9 it), 60×20×20 54 ms. W4 stage
load is 27 ms. **Gate 0 passes with about 35× headroom.** Jacobi alone would also pass
(W4 117 ms). Jacobi needs 260–320 iterations warm, which is more than cold, because a notch
hurts its conditioning. MG takes 9–12 iterations on every grid. A full gate run takes about
45 s.

**Found by the gate: native-only regression.** It came with T-201 `b97e3cd` (mg/level.rs
"faster element loops"). Native Jacobi-PCG got about 2.1× slower (W4 warm 91 → 199 ms) and
native MG about 1.4× slower (15 → 21 ms). WASM got faster (22 → 14 ms). Iterations did not
change, and neither did `operator.rs`, `pcg.rs`, `precond.rs` or `hex8.rs`.
- Restoring `crates/fem/src/mg` from `5a6dcd3` restores native speed.
  `#[inline(always)]` on `mul24` does not.
- `sample`: the time is in the out-of-line `Operator::apply`. Likely cause: an LTO
  inlining or layout interaction with the near-identical `mg::Level::apply` loop.
- Main and T-201 asked for the baseline from the final code, so **the baseline was recorded
  after the regression** and the gate is green. The pre-regression baseline is the
  `perf-budget.json` version at `db4aee4`, if the orchestrator prefers to keep the gate red
  until the regression is fixed.

**Follow-ups**
- New task (crates/fem, T-401 area): fix the native `Operator::apply` codegen regression.
  It matters for topopt throughput, not for players. Verify with
  `cargo run -p fem-bench --release -- --grid 40x12x12 --precond both`: Jacobi warm should
  return to about 100 ms on M5 Pro. Then run `node scripts/bench-gate.mjs --record`.
- Measure in real browsers: T-205 was asked (by message) to log per-carve timings as
  browser | OS/CPU | stage | precond/levels | load ms | warm median/max ms (it) |
  worker round-trip ms. Fold these into docs/perf-results.md.
- Multi-load-case scenario: W4/W5 stages have two cases, and the bench uses one. The
  expected cost is about 2×; the headroom covers it. A `--cases 2` option would make this
  explicit.
- After any intentional solver change, run `node scripts/bench-gate.mjs --record` and
  commit `docs/perf-budget.json`.
