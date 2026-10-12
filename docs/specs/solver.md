# Solver spec (contract)

> **Contract file** for `crates/fem` (core), `crates/fem-wasm` (bindings) and
> `crates/topopt` (offline optimiser). The public Rust API below is what the other
> crates code against; keep it stable or update all users in the same task.

Indexing, units and the stage semantics are defined in
[stage-format.md](stage-format.md). This file defines the numerics.

## Discretisation

- 3D linear elasticity, isotropic material `(E, ν)`.
- **Hex8** trilinear brick, full 2×2×2 Gauss integration. Every voxel is the same cube,
  so a single reference stiffness `Ke1` (24×24, for `E = 1`, `h = 1`) is computed once
  for the given `ν`; the element matrix is `Ke = E_e · h · Ke1`.
- Local node order (offsets in `(x, y, z)`):
  `0:(0,0,0) 1:(1,0,0) 2:(1,1,0) 3:(0,1,0) 4:(0,0,1) 5:(1,0,1) 6:(1,1,1) 7:(0,1,1)`.
  Element DOF vector: `[n0x n0y n0z n1x … n7z]`.
- Material interpolation (SIMP): `E_e = E_min + ρ_e^p (E_0 − E_min)`,
  `E_min = 1e-9 · E_0`. The player uses `ρ ∈ {0, 1}`; the optimiser uses `ρ ∈ [0, 1]`.

## Active set and masking (soft-kill)

- *Domain* elements: initially solid (block voxels and voxels outside `solid` are
  never domain).
- *Active* elements (player mode): solid **and** in a face-connected component that
  contains a supported cell. Floating components are inactive (reported to the UI).
  In optimiser mode every domain element is active.
- A DOF is **free** iff it is not fixed by a support **and** its node touches at least
  one active element. Non-free DOFs are held at `u = 0` and removed from the
  system by masking (`M A M + (I − M)`). This avoids the conditioning blow-up from
  nodes that only touch `E_min` material.

## Linear solve

`K(ρ) u = f`, preconditioned conjugate gradients, matrix-free on the finest level:
`y = Σ_e E_e h · Ke1 · x_e` gathered/scattered per element.

- Convergence: `‖r‖₂ / ‖M f‖₂ ≤ tol` on the masked system, confirmed with the true residual
  (forces on fixed DOFs are reactions and do not count). Default `tol = 1e-6`; the game uses `1e-4`.
- A solve that stalls (e.g. a mechanism: `pᵀAp ≤ 0`) or hits `max_iters` ends with
  `done = true` and not converged; callers must treat "not converged" as a failed design.
- **Warm start**: the previous displacement is the initial guess (masked).
- **Preconditioners**: `Jacobi` (baseline, always available) and `Multigrid`
  (default once it exists):
  - Geometric hierarchy by 2× coarsening per axis; an axis is coarsened only when its
    element count is even and > 1 (semi-coarsening otherwise).
  - Prolongation `P`: trilinear interpolation, which is local to each coarse element,
    so the **Galerkin** coarse operator `Pᵀ A P` is assembled element-wise:
    `Kc_E = Σ_{children e} P_eᵀ (M_e Ke M_e) P_e` (24×24 per coarse element, stored).
    Coarse DOFs whose diagonal is 0 are masked.
  - Smoother: damped Jacobi (ω ≈ 0.6) or Chebyshev; same number of pre/post sweeps so
    the V-cycle is symmetric (CG requires an SPD preconditioner).
  - Coarsest level: direct solve (banded Cholesky, ordering chosen to minimise
    bandwidth). Stop coarsening when coarsest DOFs ≤ ~2000 or no axis can coarsen.
  - After `set_solid`, only coarse elements containing changed fine elements need
    rebuilding; the coarsest factorisation is redone.
- Later (not required for MVP): f64x2 SIMD element kernels, graph-coloured
  multithreading (wasm-bindgen-rayon), WebGPU f32 path.

## Post-processing

- Strain at the **element centroid**: `ε = B(0,0,0) u_e`; stress `σ = E_e D₁ ε`
  (`D₁` = isotropic elasticity matrix for `E = 1`).
- von Mises:
  `σ_vm = √(½[(σx−σy)² + (σy−σz)² + (σz−σx)²] + 3(τxy² + τyz² + τzx²))`.
- *Utilisation* `= σ_vm / allowable` per element; 0 for inactive elements.
- *Judged max utilisation*: max over active, non-keep elements.
- *Load displacement*: max ‖u‖ over nodes of all load cells.
- *Compliance* `fᵀu` and per-element `u_eᵀ Ke1 u_e` (for SIMP sensitivities).

## Public Rust API (`crates/fem`)

```rust
pub struct Grid { pub nx: usize, pub ny: usize, pub nz: usize, pub h: f64 }
pub struct Material { pub e: f64, pub nu: f64, pub allowable: f64 }

pub struct LoadCase { pub name: String, pub force: Vec<f64> /* per DOF */, pub load_cells: Vec<usize> }

pub struct Problem {
    pub grid: Grid,
    pub material: Material,
    pub domain: Vec<bool>,     // per element: initially solid
    pub keep: Vec<bool>,       // per element, incl. implicit support/load cells
    pub supported: Vec<bool>,  // per element: supported cell (Stage::supported_cells)
    pub fixed: Vec<bool>,      // per DOF
    pub cases: Vec<LoadCase>,  // ≥ 1
}
impl Problem { pub fn from_stage(stage: &stage::Stage) -> Result<Problem, FemError>; }

pub enum Preconditioner { Jacobi, Multigrid }
pub enum Mode { Player, Optimizer }
pub struct SolverOptions { pub tol: f64, pub max_iters: usize, pub preconditioner: Preconditioner, pub mode: Mode }

pub struct SolveStatus { pub case: usize, pub iterations: usize, pub rel_residual: f64, pub done: bool }

pub struct Solver { /* … */ }
impl Solver {
    pub fn new(problem: Problem, opts: SolverOptions) -> Solver;
    pub fn problem(&self) -> &Problem;
    pub fn set_solid(&mut self, changes: &[(usize, bool)]);   // player mode
    pub fn set_density(&mut self, rho: &[f64], penal: f64);  // optimiser mode
    pub fn solid(&self) -> &[bool];
    /// Recompute active set / masks / preconditioner; warm start from previous u.
    pub fn begin(&mut self);
    /// Run ≤ n PCG iterations on the current case; moves on to the next case when it
    /// converges. `done` = all cases converged (or max_iters hit).
    pub fn iterate(&mut self, n: usize) -> SolveStatus;
    pub fn solve(&mut self) -> SolveStatus; // begin + iterate until done
    pub fn displacement(&self, case: usize) -> &[f64];
    pub fn von_mises(&self, case: usize, out: &mut [f64]);
    pub fn utilization(&self, case: usize, out: &mut [f64]);
    pub fn judged_max_utilization(&self, case: usize) -> f64;
    pub fn load_displacement(&self, case: usize) -> f64;
    pub fn compliance(&self, case: usize) -> f64;
    pub fn element_energy(&self, case: usize, out: &mut [f64]); // u_eᵀ Ke1 u_e · h
    pub fn active(&self) -> &[bool];
    pub fn floating(&self) -> Vec<usize>;  // solid but not connected to a support
    pub fn loads_connected(&self) -> bool; // every load cell active
}
```

## Validation (must stay green)

1. **Patch test**: uniform tension on a solid block reproduces the exact linear
   displacement and uniform stress (rel. error < 1e-8).
2. **Cantilever**: tip deflection of a slender solid beam within 15 % of Timoshenko
   beam theory and converging under refinement.
3. **Symmetry**: symmetric problem ⇒ symmetric displacement field (1e-8).
4. **Preconditioner equivalence**: Jacobi-PCG and MGCG agree to the solve tolerance.
5. **Soft-kill**: removing a disconnected region does not change the solution of
   the remaining structure; a fully disconnected load ⇒ `loads_connected() == false`
   and no NaN/divergence.

## Performance budget

See `docs/perf-budget.json` (enforced by `scripts/bench-gate.mjs`). Phase 0 gate:
one carve (warm start, `tol = 1e-4`) on 40×12×12 in **≤ 0.5 s single-thread WASM**.
