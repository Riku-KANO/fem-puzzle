---
id: T-201
title: Geometric multigrid preconditioner (MGCG) with Galerkin coarse operators
status: review
phase: 0
depends: [T-101]
owns:
  - crates/fem/src/mg/**
touches:
  - crates/fem/src/solver.rs   # wiring only
  - crates/fem/src/lib.rs
  - crates/fem/tests/**
  - crates/fem/examples/cantilever.rs
verify:
  - cargo test -p fem
  - cargo clippy -p fem --all-targets -- -D warnings
  - cargo run -p fem --release --example cantilever
---
## Goal
Make `Preconditioner::Multigrid` real and the default, as specified in
`docs/specs/solver.md` (Linear solve → Multigrid). Reference: Amir, Aage & Lazarov 2014
(MGCG for topology optimisation).

## Requirements
- Hierarchy with per-axis 2× coarsening (only even, > 1 axes), trilinear prolongation,
  Galerkin coarse element matrices `Σ P_eᵀ (M_e Ke M_e) P_e` stored per coarse element.
- Symmetric V-cycle (equal pre/post Jacobi or Chebyshev sweeps), coarsest level direct
  (banded Cholesky, bandwidth-minimising ordering), masked DOFs handled at every level.
- Incremental rebuild after `set_solid`: only coarse elements whose children changed.
- Works for every stage grid (24×8×4, 32×8×8, 32×12×12, 40×12×12) and 60×20×20.

## Acceptance criteria
- [x] Solver.md validation test 4 (Jacobi vs MGCG agree to tolerance) + all existing tests.
- [x] On 40×12×12 solid cantilever, cold solve iterations ≥ 5× fewer than Jacobi and
      wall time lower; same on a randomly carved (≈50 %, still connected) design.
- [x] Warm re-solve after a 3×3 carve on 40×12×12 at `tol = 1e-4`: report iterations and
      time in the log (native release). Target ≤ 0.1 s native.
- [x] Preconditioner is SPD in practice: CG residual decreases monotonically in A-norm
      sense on the test problems (no breakdown); add a test that `zᵀr > 0`.
- [x] `examples/cantilever.rs` prints Jacobi vs MG columns.

## Log

### 2026-10-12 — T-201 worker (branch worktree-agent-a82c97b27192153bb)
Early start against T-101 (merged its branch up to 952ba34), then merged **main @ 2b17d1a**
(T-101 integrated incl. review fixes 0e4fdd6, T-202 done); all checks re-run on the merge.

**What**
- `crates/fem/src/mg/`: `grid.rs` (coarsening rule, node→elements), `transfer.rs` (trilinear
  `M P` / `Pᵀ M`, per-child 8×8 weights, sparse element Galerkin product), `level.rs` (level
  operator: matrix-free fine level / stored 24×24 Galerkin matrices, node-wise diagonal +
  damping), `banded.rs` (banded Cholesky), `spectral.rs` (rigorous element `λ_max` bounds),
  `mod.rs` (`Multigrid`, `MgOptions`, `MgStats`, V-cycle, incremental rebuild), `tests.rs`.
- Wiring: `solver.rs` `make_precond` builds `Multigrid::default()`; `Preconditioner::Multigrid`
  is now `#[default]`. `lib.rs`: `pub mod mg` + re-exports. `tests/multigrid.rs` (new),
  `examples/cantilever.rs` (Jacobi vs MG for every row + a carved-50 % / 60×20×20 table).
- `tests/solver.rs`: `chunked_iteration_is_resumable_and_identical` and
  `max_iters_stops_with_done_but_not_converged` now pin `Preconditioner::Jacobi`: their grids
  (≤ 2000 DOFs) are solved *directly* by MG in 1 iteration, so the tests' iteration mechanics
  need Jacobi; the MG variant of the chunked test is in `tests/multigrid.rs`.

**Design decisions**
- Precond trait agreed with T-101 (`rebuild(&OperatorView)` + `apply(&mut self, r, z)`); MG
  diffs `coef`/`free` against its own copy, so no change list crosses the API.
- Masked prolongation `P' = M P` ⇒ `P'ᵀ A P' = Pᵀ M K M P` exactly = `Σ P_eᵀ(M_e K_e M_e)P_e`
  (dense triple-product test). Coarse DOFs with zero diagonal masked (rows are exactly zero).
  Unmasked fine children reuse a precomputed `P_cᵀ Ke1 P_c` per child position.
- Smoother: damped Jacobi, 1 pre + 1 post sweep (symmetric). **Fixed ω = 0.6 is not safe**:
  Galerkin elements built from sparse (carved / low-density) children have
  `λ_max(D⁻¹K) ≫ 3.3`, the V-cycle becomes indefinite and CG crawls (40×12×12 carved: 1082 it
  vs 804 Jacobi). A global Gershgorin cap is safe but over-damps (ω ≈ 0.35). Chosen: rigorous
  **per-DOF** damping `wᵢ = min(0.6, 1.9/λᵢ)`, `λᵢ = Σⱼ|Aᵢⱼ|/Aᵢᵢ` (assembled l1 ratio; 3.93 in
  a solid interior vs true `λ_max(D⁻¹A) ≈ 3.09`) ⇒ `λ_max(WA) ≤ 1.9 < 2` on every level ⇒ SPD
  V-cycle. Alternative per-element spectral bound (`tr(S¹⁶)^{1/16}`) kept behind
  `MgOptions::l1_damping = false` (Ke1 element bound 5.32 is looser; 3–14 % more iterations).
- Coarsening stops at ≤ 2000 DOFs: 24×8×4 → 2 levels, 32×8×8 → 2, 32×12×12 / 40×12×12 /
  60×20×20 → 3 (coarsest 528 / 1728 DOFs, bandwidth 65 / 131). Grids ≤ 2000 DOFs get 1 level
  = exact banded-Cholesky solve.
- Coarsest: banded Cholesky, nodes renumbered with the largest axis slowest. Galerkin
  coarse operators **can be singular** in carved designs (fine nodes on a strut interpolating
  identically from several coarse nodes); such directions lie in `null(M P)`, so null pivots
  (`< 1e-11·A_ii`) are dropped → symmetric PSD generalised inverse (tested).
- Incremental rebuild: changed elements (+ elements touching nodes whose mask changed) →
  parents re-assembled level by level; diagonal/damping recomputed node-wise only for nodes
  of re-assembled elements (bit-identical to a fresh build — tested); coarsest refactored.

**Measurements** (native release, 1 thread, Apple; other workers were compiling, so absolute
ms are ~1.5–2× an idle machine — ratios are stable). `cargo run -p fem --release --example cantilever`:

| 40×12×12, tol | Jacobi cold it/ms | MG cold it/ms | Jacobi warm 3×3 it/ms | MG warm 3×3 it/ms |
| --- | --- | --- | --- | --- |
| 1e-6 | 263 / 179 | 15 / 32.9 | 385 / 255 | 14 / 31.3 |
| 1e-4 | 234 / 156 | 11 / 24.6 | 274 / 182 | **10 / 22.7** |

| cold solve | tol | Jacobi it/ms | MG it/ms | it × | time × |
| --- | --- | --- | --- | --- | --- |
| 40×12×12 random carve (≈ 50 % active) | 1e-6 | 878 / 316 | 80 / 106 | 11.0 | 3.0 |
| 40×12×12 random carve | 1e-4 | 825 / 296 | 61 / 83 | 13.5 | 3.6 |
| 60×20×20 solid | 1e-6 | 398 / 1095 | 15 / 142 | 26.5 | 7.7 |

- Warm re-solve after 3×3 carve on 40×12×12 at tol 1e-4: **10 iterations, 22.7 ms** (17 ms on
  an idle machine; T-204's bench at 5a6dcd3: median 9 it, 16.1 ms native / 19.5 ms WASM;
  60×20×20 62.6 / 74.8 ms). Target ≤ 0.1 s met. Note: warm ≈ cold-of-carved (10 vs 11): MG's
  cold solve is already ~10 iterations and a carve leaves a residual that is not small relative
  to `f`, so "far fewer than cold" is not attainable; `tests/multigrid.rs` asserts warm ≤ cold and ≤ 15.
- Profile (idle): V-cycle ≈ 2.45 fine matvecs; MG iteration ≈ 3.5 matvecs ≈ 4× a Jacobi
  iteration. Rebuild after 3×3 carve: 0.35 ms (40×12×12), 3.5 ms (60×20×20, dominated by the
  coarsest factorisation). Full build (every `set_density` in optimiser mode): 8 ms / 37 ms.
- WASM (`node crates/fem-wasm/tests/node-smoke.mjs` after merging main, tol 1e-4): 24×8×4
  `lv 2`, cold 1.8 ms (10 it), warm median 2.5 ms (12 it); 40×12×12 `lv 3`, cold 15.7 ms
  (11 it), warm median 14.0 ms (9 it). All six stage JSONs solve (9–10 it cold).
- SIMP (optimiser mode, E_min = 1e-9, `tests/multigrid.rs`, 32×8×8, tol 1e-8): random ρ³
  37 it vs Jacobi 584; random 0/1 densities 108 vs 1751.
- SPD evidence: dense V-cycle operator symmetric (1e-12) and Cholesky-PD on a 3-level carved
  grid; `zᵀr > 0` on solid / carved / SIMP / 0-1-contrast designs; unit PCG asserts
  `pᵀAp > 0`, `rᵀz > 0` and monotone energy `½xᵀAx − fᵀx` (A-norm error) every iteration.

**Follow-ups**
- Chebyshev smoother (rigorous upper bound available from the l1 ratio) could cut carved/SIMP
  iterations (61–108 it) further; worth trying for T-203 throughput.
- T-401 (SIMD): `mg/level.rs` has its own fine-level kernel (`Level::apply`, same loop as
  `Operator::apply`) and the stored-matrix coarse kernel — both should get the SIMD path.
- T-204: perf-gate baseline should be (re-)recorded from this branch's final commit.
- `validation.rs::jacobi_and_multigrid_agree` (16×4×4) only exercises the 1-level direct
  path; the multi-level equivalence is `tests/multigrid.rs::jacobi_and_multigrid_agree_on_multilevel_grids`.

