---
id: T-204
title: Phase 0 performance gate — native + WASM benchmarks, budget, report
status: doing
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
- [ ] `node scripts/bench-gate.mjs` passes on this machine (or the task stays `blocked`
      with a written analysis and a proposed follow-up task).
- [ ] `verify.sh full` picks the gate up automatically (it does when the script exists).

## Log
