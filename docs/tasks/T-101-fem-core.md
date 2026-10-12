---
id: T-101
title: FEM core — Hex8, problem setup, matrix-free Jacobi-PCG, stress, connectivity
status: done
phase: 0
depends: [T-002]
owns:
  - crates/fem/**
  - '!crates/fem/src/mg/**'   # T-201 develops multigrid in parallel
verify:
  - cargo test -p fem
  - cargo clippy -p fem --all-targets -- -D warnings
  - cargo run -p fem --release --example cantilever
---
## Goal
Implement the public API of `docs/specs/solver.md` in `crates/fem` with a matrix-free
**Jacobi**-preconditioned CG. Multigrid comes in T-201, so design the preconditioner as
a pluggable component (e.g. a `trait Precond { fn rebuild(&mut self, op: &Operator); fn apply(&self, r: &[f64], z: &mut [f64]); }`);
`Preconditioner::Multigrid` may fall back to Jacobi until T-201 lands (log it).

## Read first
- `docs/specs/solver.md` (numerics + API — normative)
- `docs/specs/stage-format.md` (indexing, supports, loads, keep semantics)
- `crates/stage/src/lib.rs` (`Stage`, `effective_keep`, `cases`)

## Suggested layout
`grid.rs` (indexing), `hex8.rs` (`Ke1`, centroid `B`, `D₁`), `problem.rs`
(`Problem::from_stage`), `connectivity.rs` (6-neighbour components, floating set),
`operator.rs` (matrix-free `K·x`, diagonal, masks), `pcg.rs` (resumable PCG state so
`iterate(n)` can stop and continue), `solver.rs`, `stress.rs`. Re-export the API from `lib.rs`.

## Acceptance criteria
- [x] Public API exactly as in solver.md (names/signatures); rustdoc on public items.
- [x] `Ke1` symmetric, positive semi-definite with exactly 6 zero eigenvalues (test via
      rigid-body modes: `Ke1 · r = 0` for 3 translations + 3 rotations).
- [x] Validation tests 1–5 from solver.md pass (patch test, cantilever vs Timoshenko
      within 15 %, symmetry, soft-kill invariance + disconnected load, no NaN).
- [x] Player mode: active set = solid ∧ face-connected to a supported cell; DOF masking
      as specified; `floating()` and `loads_connected()` correct (unit tests).
- [x] Optimizer mode: `set_density` + `element_energy` (needed by T-203).
- [x] Warm start: re-solving after removing one surface voxel takes far fewer
      iterations than a cold solve (assert in a test).
      *Relaxed by main on 2026-10-12 for Jacobi to "warm ≤ cold solve of the same carved
      design" (test asserts that); "far fewer" moves to T-201. See Log.*
- [x] `examples/cantilever.rs` prints, for grids 24×8×4, 32×8×8, 32×12×12, 40×12×12:
      cold iterations/time and warm (one 3×3 surface patch removed) iterations/time.
- [x] No `unsafe` unless measured to matter (then justify in a comment). No new deps
      without noting why in the log.

## Notes
- Element loop: gather 24 DOFs → `Ke1 · x_e` (24×24) → scale `E_e·h` → scatter-add.
  Inactive elements may be skipped (document the choice).
- Keep everything `f64`. Allocate work vectors once in `Solver::new`.
- Supports must remove all rigid-body modes; if a stage does not, CG may not converge —
  return `done = true` with the residual instead of looping forever (max_iters).

## Log
- 2026-10-12 (T-101 worker): implemented `crates/fem`; commits 8d44d07 (API skeleton,
  announced to T-201/T-202/T-203), 5fd36c5 (validation + example), 20503f5, + log commit.
  - **Layout**: `grid.rs` (indexing, local node order, face neighbours), `hex8.rs` (`ke1`,
    `b_matrix`/`b_centroid`, `d1`, `mul24`, `von_mises`), `problem.rs` (`Problem`,
    `from_stage`, `validate`, `FemError`), `connectivity.rs` (`connected_to_seeds` flood
    fill), `operator.rs` (`Operator`, `OperatorView`), `precond.rs` (`Precond`, `Jacobi`),
    `pcg.rs` (resumable PCG, private), `solver.rs` (API + post-processing; stress lives
    here, no separate `stress.rs`). Tests: unit tests per module, `tests/validation.rs`
    (solver.md 1–5), `tests/solver.rs` (behaviour), `tests/smoke.rs`; helpers in
    `tests/common/mod.rs`. Examples: `cantilever` (benchmark), `solve_stage` (solve stage
    JSON files, prints judged results).
  - **Inactive elements are skipped** (coef 0), not given `E_min`, in player mode — exact
    soft-kill invariance; masking already removes nodes that would only see `E_min`.
    Optimiser mode assembles every domain element with `E_min + ρ^p (E₀ − E_min)`,
    `E_min = 1e-9 E₀` (`solver::E_MIN_RATIO`); non-domain elements never.
  - **Masked operator** `A = M K M + (I − M)`; the gather multiplies by the mask, so
    `apply` is correct for any `x`. Free DOF = not fixed ∧ node touches an element with
    coef ≠ 0. `Operator::update` returns whether coef/mask changed; the preconditioner is
    rebuilt only then.
  - **Precond trait (agreed with T-201)**: `trait Precond: Send { fn rebuild(&mut self,
    op: &OperatorView); fn apply(&mut self, r, z); fn levels(&self) -> usize { 0 } }`,
    `OperatorView { nx, ny, nz, ke1: &[f64; 576], coef: &[f64] /* E_e·h, 0 = skipped */,
    free: &[bool] }`; `apply` must return `z = r` on non-free DOFs; MG diffs coef/free
    internally for incremental rebuilds (no change list). Wiring point: `make_precond` in
    `solver.rs`; `Preconditioner::Multigrid` **falls back to Jacobi** until T-201, and
    `SolverOptions::default()` uses Jacobi (T-201 flips `#[default]` to Multigrid).
    `Solver::levels()` exposes `Precond::levels` for the worker's `ready.levels`.
  - **PCG**: state (`r z p q`, `rᵀz`) kept in `Pcg`, allocated once; the iteration loop
    allocates nothing. Convergence `‖r‖/‖M f‖ ≤ tol`, confirmed with the true residual
    (≤ 4 restarts if it disagrees). `pᵀAp ≤ 0` / non-finite → case stops (done, not
    converged); `max_iters` is per case. `M f = 0` (e.g. load fully disconnected) → `u = 0`,
    converged immediately. Warm start: masked previous `u`, rescaled by the energy-optimal
    `α = xᵀf / xᵀAx` (never increases the A-norm error; helped up to 2× in some cases,
    neutral otherwise).
  - **Semantics** (told T-202/T-203): `SolveStatus.iterations` = iterations since `begin`
    summed over cases; `rel_residual` = current case's (max over cases once done); `case`
    = case in progress (last once done). `iterate` calls `begin` itself after
    `set_solid`/`set_density`. `set_solid` ignores out-of-range and non-domain indices.
    `active`/`floating`/`loads_connected` reflect the last `begin`. `loads_connected` =
    every load cell of every case active. `element_energy` = `u_eᵀKe1u_e·h`, 0 for inactive
    elements (so `Σ E_e·energy_e = fᵀu`; FD-checked sensitivity). Extras: `Solver::{levels,
    converged, status, stress, operator, options}`.
  - **`supported`** = domain element with ≥ 1 node fixed by a support (literal solver.md).
    For `cells` supports this includes neighbours sharing a fixed node (e.g. diagonal
    cells touching one fixed node) — such a region can be "active" while only hinged.
  - **Mechanisms** (supports that leave rigid modes, e.g. a part hanging on a roller only):
    PCG stalls within ~50 iterations (detected via `pᵀAp`), `done = true`, not converged,
    `u` finite but huge → judged as failure. Tested (`unsupported_rigid_modes_terminate`).
  - **Validation numbers**: patch test (triaxial, rollers) exact to < 1e-8; cantilever L/d
    = 8, end shear, δ = fᵀu/P vs Timoshenko 7.403e-4 m: 32×4×4 → 7.069e-4 (−4.5 %),
    64×8×8 → 7.266e-4 (−1.9 %), converging from below. Main's stages w1-01..w2-03 (T-103)
    all load and solve: 107–177 iterations, 16–45 ms native at tol 1e-4, max util ≈ 0.05–0.14
    (loads not calibrated yet).
  - **`examples/cantilever.rs`** (native release, single thread, best of 3; clamped x-,
    load on the top tip edge, 3×3 top patch at mid-span; "carved" = cold solve of the carved
    design), Jacobi:
    ```
    grid       tol   cold it/ms   warm it/ms   carved it/ms   ms/it
    24x8x4     1e-6  154/16.6     321/28.1     317/27.9       0.108
    24x8x4     1e-4  138/12.2     302/26.4     297/25.9       0.088
    32x8x8     1e-6  200/47.0     374/87.1     372/86.1       0.235
    32x8x8     1e-4  182/42.5     240/55.9     349/80.9       0.233
    32x12x12   1e-6  221/115.4    304/158.3    382/198.6      0.522
    32x12x12   1e-4  192/101.6    219/114.3    354/183.9      0.529
    40x12x12   1e-6  263/171.6    385/250.0    472/306.3      0.653
    40x12x12   1e-4  234/152.3    274/178.2    441/286.4      0.651
    ```
    Element kernel ≈ 0.11 µs per element per matvec (~10 GFlop/s native).
  - **Warm start finding**: with Jacobi the initial guess barely helps. The intact block
    is symmetric and the load excites few modes (fast cold solve); any carve breaks the
    symmetry and the warm residual (internal force of the removed elements, often ≥ ‖f‖)
    excites the whole spectrum, so PCG needs about as many iterations as a cold solve of
    the carved design (24×8×4: warm 302 vs carved 297 at 1e-4 — marginally worse; at
    40×12×12: 274 vs 441). Test `warm_start_after_small_carve_is_not_slower_than_cold`
    (40×12×12, tol 1e-4, one voxel: 149 vs 244, 3×3 patch: 257 vs 414; ν = 0.3) asserts
    warm ≤ cold per main's relaxed criterion. Not tuned beyond using the perf-gate grid.
  - **Unmet / caveats**: solver.md test 4 (Jacobi vs MGCG) is Jacobi vs Jacobi until
    T-201 plugs in (test exists: `jacobi_and_multigrid_agree`). Perf: one warm carve on
    40×12×12 at 1e-4 is 274 it / 178 ms native with Jacobi → likely > 0.5 s in WASM; the
    phase-0 gate needs multigrid (T-201).
  - **Follow-ups**: (1) T-201: flip default to Multigrid, re-check warm vs cold ("far
    fewer"), add MG columns to `examples/cantilever.rs` (`PRECONDS`). (2) Contract question
    for main: stage-format.md says "Supported cells are implicitly protected (keep)", but
    `stage::Stage::effective_keep` only protects cells listed in `support.cells`; for face
    supports without `cells` the boundary cells stay carvable (the solver handles both:
    fixed nodes come from the initial solid set, so a carved face cell's nodes stay fixed
    and are simply masked once no active element touches them). Decide and align
    spec/crate. (3) Possibly tighten "supported" for `cells` supports to the listed
    cells only (spec change). (4) T-401: SIMD kernel; `Operator::apply` is the hot loop.
  - No `unsafe`; no new dependencies.
- 2026-10-12 (T-101 review fixes, after review verdict APPROVE): merged main (contract
  fixes 27fa266 / c395fdf).
  - `Problem::supported` now comes from `Stage::supported_cells()`: the listed support
    cells, or every initially solid cell on a face-only support's face. A cell that merely
    shares a fixed node is no longer supported (this replaces the "≥ 1 fixed node" bullet
    above). Active = solid ∧ 6-connected to a supported cell, unchanged.
  - `keep` = `Stage::effective_keep()`, which now includes face-support root cells, so the
    clamped wall layer is excluded from judging. `judged_utilization_excludes_keep_cells`
    asserts this, and the face-support unit test checks `keep` on the root layer.
  - New test `edge_contact_does_not_connect_loads_to_a_cell_support` (reviewer probe:
    6×1×2, y- clamped cell (0,0,0), carve (2,0,0)+(1,0,1), load ±y at x = 5 ⇒
    `loads_connected() == false`, floating = far part). It also covers a variant where
    (1,0,1) shares a fixed node with the support cell but is only edge-adjacent: inactive.
  - Mechanism test: `max_iters: 1_000_000`, asserts `iterations < 500`. Stall detection
    stops at 53.
  - Benchmark numbers unchanged. Follow-ups (2) and (3) above are resolved by main's
    contract fix.
