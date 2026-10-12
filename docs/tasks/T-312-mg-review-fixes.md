---
id: T-312
title: Multigrid review follow-ups — odd-grid fallback, symmetry guards, rebuild cost, tests
status: review
phase: 1
depends: [T-201]
owns:
  - crates/fem/src/mg/**
  - crates/fem/tests/multigrid.rs
touches:
  - docs/perf-budget.json   # re-recorded perf-gate baseline (item 5)
  - crates/fem/src/hex8.rs  # item 5: `#[inline(never)]` on mul24 (one attribute + doc)
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
5. **Native slowdown** (added by main, traced by T-204 to mg commit b97e3cd): on native the
   Jacobi path got ~2.1× slower (W4 warm 91 → 199 ms) and MG ~1.4× slower, while WASM got
   faster (22 → 14 ms). operator.rs / pcg.rs / precond.rs / hex8.rs are unchanged; reverting
   `crates/fem/src/mg` to 5a6dcd3 restores native speed; forcing `mul24` inline does not.
   Suspected LTO/codegen interaction with the near-identical `mg::Level::apply` loop.
   Reproduce with `cargo run -p fem-bench --release -- --grid 40x12x12 --precond both`; fix
   without losing the WASM gain, re-record `node scripts/bench-gate.mjs --record`, commit
   `docs/perf-budget.json`. If a full fix is out of reach, document the cause as a follow-up.

## Acceptance criteria
- [x] All four items done; timings for odd grids in the Log; WASM smoke still green.
- [x] Item 5: native slowdown found and fixed, WASM unchanged, perf baseline re-recorded.

## Log

### 2026-10-12 — T-312 (T-201 author, branch worktree-agent-a82c97b27192153bb)
Merged main (c25d68f, then again after T-204 / perf gate landed).

1. **Symmetry guards** — `Multigrid::new` corrects unsafe options (documented on the
   `MgOptions` fields): `sweeps` 0 → 1, `omega` ≤ 0 / non-finite → 0.6, `omega_cap` clamped to
   `MAX_OMEGA_CAP = 1.99` (non-positive / non-finite → 1.9). `options()` returns the effective
   values. Clamping, not asserting: the options are public and a panic in the browser worker
   is worse than a corrected value. Test: `unsafe_options_are_corrected_and_vcycle_stays_symmetric`
   (dense V-cycle with `sweeps: 0` requested is symmetric).
2. **Rebuild cost** — `lambda_max_bound` only when `!l1_damping`. Full build (best of 3,
   native): 40×12×12 7.3 → 5.0 ms, 60×20×20 35.5 → 26.1 ms (this matters for every
   `set_density` in topopt).
3. **Odd grids: chose "coarsen odd axes"** — every axis with n > 1 cells → ⌈n/2⌉ coarse cells;
   for odd n the last coarse cell is one fine cell wide (its nodes coincide with fine nodes,
   so interpolation there is injection). The element-wise Galerkin product handles the
   non-uniform coarse grid exactly (27 child kinds instead of 8; `grid::AxisCoarsening`).
   Even grids get the identical hierarchy as before (stage numbers unchanged). Rejected the SPD
   smoother / Jacobi-style coarse fallback: it would make odd grids converge like Jacobi.
   Timings (`cargo test -p fem --release --test multigrid -- --ignored --nocapture`, tol 1e-4,
   warm = median of 5 3×3 carves; machine shared with other workers):

   | grid | DOFs | lv | MG cold ms (it) | MG warm ms (it) | Jacobi warm ms (it) ≈ fallback | old 1-level refactor/carve ms |
   | --- | --- | --- | --- | --- | --- | --- |
   | 31×11×11 | 13824 | 3 | 22.8 (12) | **16.0 (10)** | 103 (208) | 545 |
   | 32×12×12 | 16731 | 3 | 24.3 (10) | 17.6 (9) | 119 (205) | 963 |
   | 33×9×7 | 8160 | 2 | 12.3 (9) | **12.1 (10)** | 90 (349) | 96 |
   | 32×8×8 | 8019 | 2 | 11.0 (9) | 9.9 (9) | 62 (227) | 94 |
   | 25×9×5 | 4680 | 2 | 6.3 (9) | 4.9 (9) | 40 (288) | 28 |
   | 24×8×4 | 3375 | 2 | 4.5 (9) | 3.7 (11) | 26 (281) | 11 |

   Target met: 31×11×11 carve 0.91× of 32×12×12, 33×9×7 1.22× of 32×8×8 (before: one level,
   ~0.55–0.67 s per carve for 31×11×11). `odd_grids_get_full_hierarchies` asserts the same
   level count and iterations ≤ 1.5× + 2 of the nearest even grid.
4. **Regression tests** (`mg/tests.rs`): (a) `galerkin_coarse_operator_equals_dense_triple_product`
   now checks `P_lᵀA_lP_l = A_{l+1}` on every level of 4×2×2, 4×3×2 (empty coarse cell →
   6 masked coarse DOFs), **8×3×4 (3 levels)** and 5×3×3 (3 levels, odd); (b)
   `null_pivots_on_clamped_plate_give_correct_solution` (x = 0 one-voxel plate, 16×8×8 and
   8×4×4: null pivots > 0, true relative residual < 1e-10); (c)
   `incremental_rebuild_add_back_density_and_floating` (carve, add back, coef-only, floating
   removed / re-attached: masks, smoother and `apply` bit-identical to a fresh build).
5. **Native slowdown — cause and fix.** A/B with the bench binary built with `mg/` at 5a6dcd3
   vs HEAD (40×12×12, Jacobi cold 92–102 vs 177–189 ms) and disassembly (`otool -tV`): in the
   slow binary `hex8::mul24` no longer exists as a function. b97e3cd changed mg's call sites
   (closure-based element loop), and LTO then inlined `mul24` into every caller, including
   `Operator::apply`. Inlined into gather → mul24 → scatter, the SLP vectoriser keeps the 24
   accumulators as scalars for the scatter and repacks them every column (`mov.d v[1]` +
   `fadd.2d` + `ext.16b` per pair, plus stack spills), roughly 2× the inner-loop work. Out of
   line, the accumulators stay in `.2d` registers. That is why forcing inline didn't help.
   **Fix:** `#[inline(never)]` on `hex8::mul24`, with a doc comment explaining why. That is
   one attribute in T-101's file, added to `touches`. Native 40×12×12: Jacobi cold
   86–97 ms / warm 103–115 ms (= pre-regression), MG cold 13.7–14.5 / warm 12.4–14.0 ms (better
   than both before and after). WASM unchanged (node smoke 40×12×12: warm median 13.6 ms, 9 it;
   gate W4 13.6 ms). Gate re-recorded (`node scripts/bench-gate.mjs --reuse --record` after a
   passing full run): `docs/perf-budget.json`. Native gate now: 40×12×12 Jacobi warm 94.8 ms,
   MG warm 10.4 ms; 60×20×20 MG warm 45.3 ms.

Follow-ups: T-401 (SIMD) should keep the element kernel out of line, or write it so the
scatter does not defeat the vectoriser, and check native and WASM separately. A codegen-only
change in one module can move another module's hot loop under fat LTO, so the perf gate's
native time check (same-CPU baseline) is what caught this. Keep it.

