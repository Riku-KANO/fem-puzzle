---
id: T-201
title: Geometric multigrid preconditioner (MGCG) with Galerkin coarse operators
status: todo
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
- [ ] Solver.md validation test 4 (Jacobi vs MGCG agree to tolerance) + all existing tests.
- [ ] On 40×12×12 solid cantilever, cold solve iterations ≥ 5× fewer than Jacobi and
      wall time lower; same on a randomly carved (≈50 %, still connected) design.
- [ ] Warm re-solve after a 3×3 carve on 40×12×12 at `tol = 1e-4`: report iterations and
      time in the log (native release). Target ≤ 0.1 s native.
- [ ] Preconditioner is SPD in practice: CG residual decreases monotonically in A-norm
      sense on the test problems (no breakdown); add a test that `zᵀr > 0`.
- [ ] `examples/cantilever.rs` prints Jacobi vs MG columns.

## Log
