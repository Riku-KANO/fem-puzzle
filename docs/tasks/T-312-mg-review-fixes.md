---
id: T-312
title: Multigrid review follow-ups — odd-grid fallback, symmetry guards, rebuild cost, tests
status: doing
phase: 1
depends: [T-201]
owns:
  - crates/fem/src/mg/**
  - crates/fem/tests/multigrid.rs
verify:
  - cargo test -p fem --release
  - cargo clippy -p fem --all-targets -- -D warnings
  - cargo run -p fem --release --example cantilever
---
## Goal
Address the T-201 post-merge review (2026-10-12). Core numerics were verified correct (l1-damped
V-cycle SPD on every level; null-pivot dropping only costs efficiency).

## Requirements
1. **Symmetry guards** (mg/mod.rs:430-455): `sweeps = 0` makes the V-cycle nonsymmetric —
   enforce `sweeps ≥ 1` and `omega_cap < 2` in `new` (assert or clamp, documented).
2. **Rebuild cost** (mod.rs:316-317): compute `lambda_max_bound` only when `!l1_damping`
   (measured 23 of 54 ms full build on 60×20×20; hits SIMP throughput).
3. **Odd grids** (mod.rs:160-170): when coarsening stops far above `coarse_max_dofs` (all axes
   odd, e.g. 31×11×11 → one level, 13.8k DOFs, 0.58 s per carve), do something bounded: coarsen
   odd axes (e.g. ceil(n/2) with a clamped last cell) *or* fall back to an SPD smoother /
   Jacobi-style coarse solve above a size limit. Target: 31×11×11 and 33×9×7 carve ≤ 2× the
   time of the nearest even grid. Sandbox/daily (T-403/T-404) will create arbitrary sizes.
4. **Tests that catch regressions**: (a) dense P₁ᵀA₁P₁ vs A₂ on a 3-level 8×3×4 hierarchy;
   (b) null-pivot path end to end (x=0 clamped plate: null pivots > 0, PCG true residual < 1e-10);
   (c) incremental rebuild for add-back, coef-only (density) and floating-component steps
   (bit-identical `apply` vs fresh build). The reviewer's probe tests are in
   `/private/tmp/claude-501/-Users-kanoriku-develop-fem-puzzle/dc21758e-f524-454d-89b5-e4b7c70b23b0/scratchpad/t201/crates/fem/src/mg/tests.rs` (`review_*`).

## Acceptance criteria
- [ ] All four items done; timings for odd grids in the Log; WASM smoke still green.

## Log
