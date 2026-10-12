---
id: T-101
title: FEM core — Hex8, problem setup, matrix-free Jacobi-PCG, stress, connectivity
status: todo
phase: 0
depends: [T-002]
owns:
  - crates/fem/**
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
- [ ] Public API exactly as in solver.md (names/signatures); rustdoc on public items.
- [ ] `Ke1` symmetric, positive semi-definite with exactly 6 zero eigenvalues (test via
      rigid-body modes: `Ke1 · r = 0` for 3 translations + 3 rotations).
- [ ] Validation tests 1–5 from solver.md pass (patch test, cantilever vs Timoshenko
      within 15 %, symmetry, soft-kill invariance + disconnected load, no NaN).
- [ ] Player mode: active set = solid ∧ face-connected to a supported cell; DOF masking
      as specified; `floating()` and `loads_connected()` correct (unit tests).
- [ ] Optimizer mode: `set_density` + `element_energy` (needed by T-203).
- [ ] Warm start: re-solving after removing one surface voxel takes far fewer
      iterations than a cold solve (assert in a test).
- [ ] `examples/cantilever.rs` prints, for grids 24×8×4, 32×8×8, 32×12×12, 40×12×12:
      cold iterations/time and warm (one 3×3 surface patch removed) iterations/time.
- [ ] No `unsafe` unless measured to matter (then justify in a comment). No new deps
      without noting why in the log.

## Notes
- Element loop: gather 24 DOFs → `Ke1 · x_e` (24×24) → scale `E_e·h` → scatter-add.
  Inactive elements may be skipped (document the choice).
- Keep everything `f64`. Allocate work vectors once in `Solver::new`.
- Supports must remove all rigid-body modes; if a stage does not, CG may not converge —
  return `done = true` with the residual instead of looping forever (max_iters).

## Log
