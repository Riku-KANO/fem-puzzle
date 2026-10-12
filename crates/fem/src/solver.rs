//! The solver: active set, masking, resumable PCG over all load cases, post-processing.

use crate::connectivity::connected_to_seeds;
use crate::hex8::{self, b_centroid, d1};
use crate::operator::Operator;
use crate::pcg::{Pcg, Step};
use crate::precond::{Jacobi, Precond};
use crate::problem::Problem;

/// Ratio `E_min / E₀` of the SIMP void material (optimiser mode).
pub const E_MIN_RATIO: f64 = 1e-9;

/// Preconditioner for the PCG solve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Preconditioner {
    /// Diagonal scaling (baseline, always available).
    #[default]
    Jacobi,
    /// Geometric multigrid V-cycle (task T-201). Until T-201 lands this falls back to Jacobi.
    Multigrid,
}

/// How element stiffness and the active set are derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    /// `ρ ∈ {0, 1}` from [`Solver::set_solid`]; active = solid ∧ face-connected to a
    /// supported cell. Inactive elements are not assembled at all.
    #[default]
    Player,
    /// `ρ ∈ [0, 1]` from [`Solver::set_density`]; every domain element is active with
    /// `E_e = E_min + ρ_e^p (E₀ − E_min)`, `E_min = 1e-9 · E₀`.
    Optimizer,
}

/// Solver configuration.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SolverOptions {
    /// Relative residual target `‖r‖₂ / ‖f‖₂`.
    pub tol: f64,
    /// Iteration cap per load case.
    pub max_iters: usize,
    /// Preconditioner for PCG.
    pub preconditioner: Preconditioner,
    /// Player (0/1 solid set) or optimiser (SIMP densities) mode.
    pub mode: Mode,
}

impl Default for SolverOptions {
    fn default() -> Self {
        SolverOptions {
            tol: 1e-6,
            max_iters: 20_000,
            preconditioner: Preconditioner::default(),
            mode: Mode::default(),
        }
    }
}

/// Progress of the current solve.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SolveStatus {
    /// Load case being solved (the last case once `done`).
    pub case: usize,
    /// PCG iterations since [`Solver::begin`], summed over all load cases.
    pub iterations: usize,
    /// `‖r‖₂ / ‖f‖₂` of `case`; once `done`, the maximum over all cases.
    pub rel_residual: f64,
    /// Every case converged or stopped (`max_iters`, stagnation).
    pub done: bool,
}

#[derive(Debug, Clone, Copy, Default)]
struct CaseState {
    iterations: usize,
    rel_residual: f64,
    converged: bool,
}

/// Create the preconditioner for `kind`.
///
/// Extension point for T-201: `Preconditioner::Multigrid` constructs the multigrid
/// preconditioner here; until then it falls back to Jacobi.
fn make_precond(kind: Preconditioner) -> Box<dyn Precond> {
    match kind {
        Preconditioner::Jacobi | Preconditioner::Multigrid => Box::new(Jacobi::default()),
    }
}

/// Voxel FEM solver for one [`Problem`]: holds the current solid set / densities, the
/// displacement of every load case (warm start) and the resumable PCG state.
///
/// Typical use: `set_solid` → `begin` → `iterate(n)` until `done` (or `solve`), then
/// query results. Structural changes take effect at the next `begin` (which `iterate`
/// calls automatically if needed); `active`, `floating` and `loads_connected` describe
/// the state as of the last `begin`.
pub struct Solver {
    problem: Problem,
    opts: SolverOptions,
    op: Operator,
    precond: Box<dyn Precond>,
    d1: [[f64; 6]; 6],
    b0: [[f64; 24]; 6],
    solid: Vec<bool>,
    density: Vec<f64>,
    penal: f64,
    connected: Vec<bool>,
    active: Vec<bool>,
    floating: Vec<usize>,
    queue: Vec<usize>,
    /// Displacement per case (the current PCG iterate for the case being solved).
    u: Vec<Vec<f64>>,
    cases: Vec<CaseState>,
    pcg: Pcg,
    current: usize,
    total_iterations: usize,
    done: bool,
    /// `set_solid` / `set_density` called (or never begun) since the last `begin`.
    dirty: bool,
}

impl Solver {
    /// Set up the solver (all domain elements solid, densities 1, displacements 0).
    ///
    /// # Panics
    /// If `problem` is inconsistent ([`Problem::validate`] fails); problems built by
    /// [`Problem::from_stage`] are always consistent.
    pub fn new(problem: Problem, opts: SolverOptions) -> Solver {
        if let Err(e) = problem.validate() {
            panic!("Solver::new: {e}");
        }
        let g = problem.grid;
        let n = g.elements();
        let mut s = Solver {
            op: Operator::new(g, problem.material.nu),
            precond: make_precond(opts.preconditioner),
            d1: d1(problem.material.nu),
            b0: b_centroid(),
            solid: problem.domain.clone(),
            density: vec![1.0; n],
            penal: 3.0,
            connected: vec![false; n],
            active: vec![false; n],
            floating: Vec::new(),
            queue: Vec::with_capacity(n),
            u: vec![vec![0.0; g.dofs()]; problem.cases.len()],
            cases: vec![CaseState::default(); problem.cases.len()],
            pcg: Pcg::new(g.dofs()),
            current: 0,
            total_iterations: 0,
            done: false,
            dirty: true,
            problem,
            opts,
        };
        s.update_operator(true);
        s
    }

    /// The problem this solver was built for.
    pub fn problem(&self) -> &Problem {
        &self.problem
    }

    /// The options this solver was built with.
    pub fn options(&self) -> &SolverOptions {
        &self.opts
    }

    /// The fine-level operator (coefficients and DOF mask as of the last `begin`).
    pub fn operator(&self) -> &Operator {
        &self.op
    }

    /// Number of multigrid levels of the preconditioner (0 = Jacobi).
    pub fn levels(&self) -> usize {
        self.precond.levels()
    }

    /// Apply `(element, solid)` changes (player mode). Indices out of range and elements
    /// outside the design domain are ignored. Takes effect at the next `begin`.
    pub fn set_solid(&mut self, changes: &[(usize, bool)]) {
        for &(e, s) in changes {
            if e < self.solid.len() && self.problem.domain[e] && self.solid[e] != s {
                self.solid[e] = s;
                self.dirty = true;
            }
        }
    }

    /// Set the densities `ρ ∈ [0, 1]` (one per element, clamped) and SIMP penalty `p`
    /// (optimiser mode; ignored in player mode). Takes effect at the next `begin`.
    ///
    /// # Panics
    /// If `rho.len()` is not the element count.
    pub fn set_density(&mut self, rho: &[f64], penal: f64) {
        assert_eq!(rho.len(), self.density.len(), "set_density: wrong length");
        for (d, &r) in self.density.iter_mut().zip(rho) {
            *d = if r.is_nan() { 0.0 } else { r.clamp(0.0, 1.0) };
        }
        self.penal = penal;
        self.dirty = true;
    }

    /// Current solid flags (including changes not yet applied by `begin`).
    pub fn solid(&self) -> &[bool] {
        &self.solid
    }

    /// Recompute connectivity, active set, element stiffness, DOF mask and preconditioner
    /// from the current solid set / densities. Returns whether the operator changed.
    fn update_operator(&mut self, force_rebuild: bool) -> bool {
        let p = &self.problem;
        connected_to_seeds(
            &p.grid,
            &self.solid,
            &p.supported,
            &mut self.connected,
            &mut self.queue,
        );
        self.floating.clear();
        let (solid, connected) = (&self.solid, &self.connected);
        self.floating
            .extend((0..solid.len()).filter(|&e| solid[e] && !connected[e]));
        let e0 = p.material.e;
        let h = p.grid.h;
        let changed = match self.opts.mode {
            Mode::Player => {
                self.active.copy_from_slice(&self.connected);
                let active = &self.active;
                self.op
                    .update(&p.fixed, |e| if active[e] { e0 * h } else { 0.0 })
            }
            Mode::Optimizer => {
                self.active.copy_from_slice(&p.domain);
                let (domain, density, penal) = (&p.domain, &self.density, self.penal);
                let emin = E_MIN_RATIO * e0;
                self.op.update(&p.fixed, |e| {
                    if domain[e] {
                        (emin + density[e].powf(penal) * (e0 - emin)) * h
                    } else {
                        0.0
                    }
                })
            }
        };
        if changed || force_rebuild {
            self.precond.rebuild(&self.op.view());
        }
        changed
    }

    /// Recompute active set / masks / preconditioner; warm start from the previous `u`
    /// (masked). Resets the iteration counters and starts on case 0.
    pub fn begin(&mut self) {
        self.update_operator(false);
        self.dirty = false;
        self.total_iterations = 0;
        self.done = false;
        for c in &mut self.cases {
            *c = CaseState::default();
        }
        self.current = 0;
        self.start_from(0);
    }

    /// Start PCG on case `c`, skipping cases that are already converged at the start.
    fn start_from(&mut self, mut c: usize) {
        while c < self.cases.len() {
            let rel = self.pcg.start(
                &self.op,
                &mut *self.precond,
                &self.problem.cases[c].force,
                &mut self.u[c],
            );
            self.cases[c].rel_residual = rel;
            if rel <= self.opts.tol {
                self.cases[c].converged = true;
                c += 1;
            } else {
                self.current = c;
                return;
            }
        }
        self.current = self.cases.len() - 1;
        self.done = true;
    }

    /// Run ≤ `n` PCG iterations, continuing with the next case when the current one
    /// converges or hits `max_iters`. Calls `begin` first if the structure changed (or
    /// it was never called).
    pub fn iterate(&mut self, n: usize) -> SolveStatus {
        if self.dirty {
            self.begin();
        }
        let mut budget = n;
        while budget > 0 && !self.done {
            budget -= 1;
            let c = self.current;
            let step = self.pcg.step(
                &self.op,
                &mut *self.precond,
                &self.problem.cases[c].force,
                &mut self.u[c],
                self.opts.tol,
            );
            self.total_iterations += 1;
            let cs = &mut self.cases[c];
            cs.iterations += 1;
            let finished = match step {
                Step::Continue(rel) => {
                    cs.rel_residual = rel;
                    cs.iterations >= self.opts.max_iters
                }
                Step::Converged(rel) => {
                    cs.rel_residual = rel;
                    cs.converged = true;
                    true
                }
                Step::Stalled(rel) => {
                    cs.rel_residual = rel;
                    true
                }
            };
            if finished {
                self.start_from(c + 1);
            }
        }
        self.status()
    }

    /// Current status without iterating.
    pub fn status(&self) -> SolveStatus {
        let rel_residual = if self.done {
            self.cases
                .iter()
                .map(|c| c.rel_residual)
                .fold(0.0, f64::max)
        } else {
            self.pcg.rel_residual()
        };
        SolveStatus {
            case: self.current,
            iterations: self.total_iterations,
            rel_residual,
            done: self.done,
        }
    }

    /// `begin` + `iterate` until done.
    pub fn solve(&mut self) -> SolveStatus {
        self.begin();
        loop {
            let s = self.iterate(1 << 12);
            if s.done {
                return s;
            }
        }
    }

    /// Whether every load case reached `tol` in the last (finished) solve.
    pub fn converged(&self) -> bool {
        self.done && self.cases.iter().all(|c| c.converged)
    }

    /// Nodal displacement of `case` (per DOF, length `3 * nodes`).
    pub fn displacement(&self, case: usize) -> &[f64] {
        &self.u[case]
    }

    /// Centroid stress `σ = E_e D₁ B(centroid) u_e` of element `e`, Voigt order
    /// `[xx, yy, zz, xy, yz, zx]` (Pa); zero for inactive elements.
    pub fn stress(&self, case: usize, e: usize) -> [f64; 6] {
        let coef = self.op.coef()[e];
        if !self.active[e] || coef == 0.0 {
            return [0.0; 6];
        }
        let h = self.problem.grid.h;
        let ue = self.op.gather(e, &self.u[case]);
        // coef = E_e h and ε = B u / h  ⇒  σ = (coef / h²) D₁ B u.
        let eps: [f64; 6] =
            std::array::from_fn(|i| self.b0[i].iter().zip(&ue).map(|(b, u)| b * u).sum());
        let s = coef / (h * h);
        std::array::from_fn(|i| s * (0..6).map(|j| self.d1[i][j] * eps[j]).sum::<f64>())
    }

    /// von Mises stress per element (Pa); 0 for inactive elements.
    pub fn von_mises(&self, case: usize, out: &mut [f64]) {
        assert_eq!(out.len(), self.active.len());
        for (e, o) in out.iter_mut().enumerate() {
            *o = if self.active[e] {
                hex8::von_mises(&self.stress(case, e))
            } else {
                0.0
            };
        }
    }

    /// `σ_vm / allowable` per element; 0 for inactive elements.
    pub fn utilization(&self, case: usize, out: &mut [f64]) {
        self.von_mises(case, out);
        let inv = 1.0 / self.problem.material.allowable;
        for o in out.iter_mut() {
            *o *= inv;
        }
    }

    /// Max utilisation over active, non-keep elements (0 if there are none).
    pub fn judged_max_utilization(&self, case: usize) -> f64 {
        let inv = 1.0 / self.problem.material.allowable;
        (0..self.active.len())
            .filter(|&e| self.active[e] && !self.problem.keep[e])
            .map(|e| hex8::von_mises(&self.stress(case, e)) * inv)
            .fold(0.0, f64::max)
    }

    /// Max nodal displacement magnitude over the nodes of the case's load cells (m).
    pub fn load_displacement(&self, case: usize) -> f64 {
        let g = &self.problem.grid;
        let u = &self.u[case];
        let mut max2: f64 = 0.0;
        for &e in &self.problem.cases[case].load_cells {
            for n in g.element_nodes(e) {
                let v = &u[3 * n..3 * n + 3];
                max2 = max2.max(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
            }
        }
        max2.sqrt()
    }

    /// Compliance `fᵀu` (J).
    pub fn compliance(&self, case: usize) -> f64 {
        let f = &self.problem.cases[case].force;
        f.iter().zip(&self.u[case]).map(|(a, b)| a * b).sum()
    }

    /// Per element `u_eᵀ Ke1 u_e · h` (so `Σ_e E_e · energy_e = uᵀ K u`); 0 for inactive
    /// elements. SIMP sensitivity: `∂c/∂ρ_e = −p ρ_e^(p−1) (E₀ − E_min) · energy_e`.
    pub fn element_energy(&self, case: usize, out: &mut [f64]) {
        assert_eq!(out.len(), self.active.len());
        let h = self.problem.grid.h;
        let k = self.op.ke1();
        for (e, o) in out.iter_mut().enumerate() {
            *o = if self.active[e] {
                let ue = self.op.gather(e, &self.u[case]);
                let ke = hex8::mul24(k, &ue);
                ue.iter().zip(&ke).map(|(a, b)| a * b).sum::<f64>() * h
            } else {
                0.0
            };
        }
    }

    /// Per element: assembled in the current operator (see [`Mode`]).
    pub fn active(&self) -> &[bool] {
        &self.active
    }

    /// Solid elements not face-connected to a supported cell (as of the last `begin`),
    /// ascending.
    pub fn floating(&self) -> Vec<usize> {
        self.floating.clone()
    }

    /// Every load cell (of every case) is active.
    pub fn loads_connected(&self) -> bool {
        self.problem
            .cases
            .iter()
            .flat_map(|c| &c.load_cells)
            .all(|&e| self.active[e])
    }
}
