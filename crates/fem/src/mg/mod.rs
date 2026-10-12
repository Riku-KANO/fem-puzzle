//! Geometric multigrid preconditioner for MGCG (`docs/specs/solver.md`, Linear solve →
//! Multigrid; Amir, Aage & Lazarov 2014).
//!
//! # Hierarchy
//! Level 0 is the fine operator `A₀ = M K M + (I − M)` applied matrix-free from `Ke1` and
//! the per-element coefficients. Each coarser level halves every axis whose element count
//! is even and > 1 (semi-coarsening otherwise) until the level has at most
//! [`MgOptions::coarse_max_dofs`] DOFs or no axis can be coarsened.
//!
//! # Galerkin operators
//! The prolongation `P` is trilinear interpolation, local to each coarse element. Using the
//! masked prolongation `P' = M P` gives `P'ᵀ A P' = Pᵀ M K M P`, assembled element-wise as
//! `Kc_E = Σ_{children e} P_eᵀ (M_e K_e M_e) P_e` and stored (24×24 per coarse element).
//! Coarse DOFs with a zero diagonal are masked (their rows are exactly zero) and get an
//! identity row, so every level has the form `A_l = M_l K_l M_l + (I − M_l)`.
//! Unmasked fine children reuse the precomputed `P_cᵀ Ke1 P_c` of their child position.
//!
//! # V-cycle
//! `ν` damped-Jacobi sweeps before and after the coarse correction (symmetric, so the
//! V-cycle is a symmetric operator), banded Cholesky on the coarsest level. Each level's
//! damping is capped by an element-wise Gershgorin bound of `λ_max(D⁻¹A)` so that
//! `ω·λ_max < 2` holds rigorously; with an (exactly) Galerkin hierarchy this makes the
//! V-cycle SPD. On masked DOFs the V-cycle returns `z = r`.
//!
//! # Incremental rebuild
//! [`Precond::rebuild`] diffs `coef` and `free` against its own copy; only coarse elements
//! with a changed descendant are re-assembled, then the coarsest level is refactored.

mod banded;
pub(crate) mod grid;
mod level;
mod transfer;

#[cfg(test)]
mod tests;

use crate::grid::Grid;
use crate::hex8::Ke;
use crate::operator::OperatorView;
use crate::precond::Precond;
use banded::BandedCholesky;
use level::{ElemOp, Level};
use transfer::{Transfer, galerkin_add};

/// Multigrid parameters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MgOptions {
    /// Jacobi sweeps before and (the same number) after the coarse correction.
    pub sweeps: usize,
    /// Jacobi damping `ω` (before the safety cap).
    pub omega: f64,
    /// Cap `ω ≤ omega_cap / λ̄` with `λ̄` the Gershgorin bound of `λ_max(D⁻¹A)`;
    /// must be < 2 for a guaranteed SPD V-cycle.
    pub omega_cap: f64,
    /// Stop coarsening once a level has at most this many DOFs.
    pub coarse_max_dofs: usize,
    /// Maximum number of levels (including the finest).
    pub max_levels: usize,
    /// Relative pivot threshold of the coarsest Cholesky (see `banded`).
    pub pivot_drop_tol: f64,
}

impl Default for MgOptions {
    fn default() -> Self {
        MgOptions {
            sweeps: 1,
            omega: 0.6,
            omega_cap: 1.9,
            coarse_max_dofs: 2000,
            max_levels: 12,
            pivot_drop_tol: 1e-11,
        }
    }
}

/// Counters for logs and tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MgStats {
    /// `rebuild` calls that changed something.
    pub rebuilds: usize,
    /// Rebuilds that (re)created the hierarchy.
    pub setups: usize,
    /// Coarse elements re-assembled by the last rebuild (all levels).
    pub last_rebuilt_elems: usize,
    /// Null pivots in the last coarsest factorisation.
    pub last_null_pivots: usize,
}

/// Geometric multigrid V-cycle preconditioner (see the module docs).
#[derive(Debug, Clone, Default)]
pub struct Multigrid {
    opts: MgOptions,
    levels: Vec<Level>,
    transfers: Vec<Transfer>,
    /// `P_cᵀ Ke1 P_c` per child id `c` of the first transfer.
    q0: Vec<[f64; 576]>,
    coarse: Option<BandedCholesky>,
    /// Per level: element marked for re-assembly, and the marked list.
    mark: Vec<Vec<bool>>,
    list: Vec<Vec<usize>>,
    stats: MgStats,
}

impl Multigrid {
    pub fn new(opts: MgOptions) -> Self {
        Multigrid {
            opts,
            ..Default::default()
        }
    }

    pub fn options(&self) -> &MgOptions {
        &self.opts
    }

    pub fn stats(&self) -> MgStats {
        self.stats
    }

    /// Element counts of every level, finest first.
    pub fn level_grids(&self) -> Vec<[usize; 3]> {
        self.levels
            .iter()
            .map(|l| [l.grid.nx, l.grid.ny, l.grid.nz])
            .collect()
    }

    /// DOFs and bandwidth of the coarsest direct solve.
    pub fn coarse_size(&self) -> Option<(usize, usize)> {
        self.coarse.as_ref().map(|c| (c.n(), c.bandwidth()))
    }

    /// Damping used on each level (after the Gershgorin cap) and the bound itself.
    pub fn level_damping(&self) -> Vec<(f64, f64)> {
        self.levels
            .iter()
            .map(|l| (omega_for(&self.opts, l.lambda_bound), l.lambda_bound))
            .collect()
    }

    /// (Re)create the hierarchy for grid `g`.
    fn setup(&mut self, g: Grid, ke1: &Ke) {
        self.levels = vec![Level::new_fine(g, ke1)];
        self.transfers.clear();
        let mut cur = g;
        while self.levels.len() < self.opts.max_levels.max(1)
            && cur.dofs() > self.opts.coarse_max_dofs
        {
            let Some((c, f)) = grid::coarsen(&cur) else {
                break;
            };
            self.transfers.push(Transfer::new(cur, f));
            self.levels.push(Level::new_stored(c));
            cur = c;
        }
        self.q0 = match self.transfers.first() {
            Some(t) => t
                .child
                .iter()
                .map(|map| {
                    let mut q = [0.0; 576];
                    galerkin_add(ke1, map, 1.0, &mut q);
                    symmetrize(&mut q);
                    q
                })
                .collect(),
            None => Vec::new(),
        };
        self.coarse = Some(BandedCholesky::new(cur));
        self.mark = self
            .levels
            .iter()
            .map(|l| vec![false; l.grid.elements()])
            .collect();
        self.list = self.levels.iter().map(|_| Vec::new()).collect();
        self.stats.setups += 1;
    }

    /// Mark element `e` of level `l` for re-assembly.
    fn mark(&mut self, l: usize, e: usize) {
        if !self.mark[l][e] {
            self.mark[l][e] = true;
            self.list[l].push(e);
        }
    }

    /// Diff the view against level 0; copy the new data. Returns whether anything changed.
    fn diff_fine(&mut self, op: &OperatorView<'_>, all: bool) -> bool {
        let g = self.levels[0].grid;
        let mut nodes = Vec::new();
        let mut elems = Vec::new();
        {
            let ElemOp::Fine { coef, free_in, .. } = &mut self.levels[0].op else {
                unreachable!("level 0 is matrix-free");
            };
            for (e, (c, &nc)) in coef.iter_mut().zip(op.coef).enumerate() {
                if all || c.to_bits() != nc.to_bits() {
                    elems.push(e);
                }
                *c = nc;
            }
            for (d, (f, &nf)) in free_in.iter_mut().zip(op.free).enumerate() {
                if *f != nf && (nodes.last() != Some(&(d / 3))) {
                    nodes.push(d / 3);
                }
                *f = nf;
            }
        }
        for e in elems {
            self.mark(0, e);
        }
        let mut touch = Vec::with_capacity(8);
        for n in nodes {
            grid::node_elems(&g, n, &mut touch);
            for &e in &touch {
                self.mark(0, e);
            }
        }
        !self.list[0].is_empty()
    }

    /// Re-assemble the marked coarse elements level by level and refactor the coarsest.
    fn propagate(&mut self) {
        let opts = self.opts;
        self.levels[0].update_diag(|b| omega_for(&opts, b));
        let mut rebuilt = 0;
        let mut children = [(0usize, 0usize); 8];
        let mut ke = [0.0f64; 576];
        for l in 0..self.transfers.len() {
            // Parents of the marked level-l elements.
            let fine_list = std::mem::take(&mut self.list[l]);
            for &e in &fine_list {
                self.mark[l][e] = false;
                let (ce, _) = self.transfers[l].parent(e);
                self.mark(l + 1, ce);
            }
            self.list[l] = fine_list;
            self.list[l].clear();
            let (lo, hi) = self.levels.split_at_mut(l + 1);
            let (fine, coarse) = (&lo[l], &mut hi[0]);
            let tr = &self.transfers[l];
            let q0 = if l == 0 { Some(&self.q0) } else { None };
            let ElemOp::Stored { mats, nonzero } = &mut coarse.op else {
                unreachable!("coarse levels store matrices");
            };
            for &ce in &self.list[l + 1] {
                let out = &mut mats[ce * 576..ce * 576 + 576];
                out.fill(0.0);
                let n = tr.children(ce, &mut children);
                for &(e, id) in &children[..n] {
                    if let (Some(q0), ElemOp::Fine { coef, all_free, .. }) = (q0, &fine.op)
                        && all_free[e]
                    {
                        let c = coef[e];
                        for (o, q) in out.iter_mut().zip(q0[id].iter()) {
                            *o += c * q;
                        }
                        continue;
                    }
                    if fine.elem_matrix(e, &mut ke) {
                        galerkin_add(&ke, &tr.child[id], 1.0, out);
                    }
                }
                symmetrize(out);
                nonzero[ce] = out.iter().any(|&v| v != 0.0);
                rebuilt += 1;
            }
            coarse.update_diag(|b| omega_for(&opts, b));
        }
        let last = self.levels.len() - 1;
        for e in std::mem::take(&mut self.list[last]) {
            self.mark[last][e] = false;
        }
        self.factor_coarsest();
        self.stats.last_rebuilt_elems = rebuilt;
        self.stats.rebuilds += 1;
    }

    fn factor_coarsest(&mut self) {
        let (Some(lc), Some(chol)) = (self.levels.last(), self.coarse.as_mut()) else {
            return;
        };
        chol.clear();
        let mut ke = [0.0f64; 576];
        for e in 0..lc.grid.elements() {
            if lc.elem_matrix(e, &mut ke) {
                chol.add_elem(&lc.grid.element_dofs(e), &ke);
            }
        }
        for (d, &f) in lc.free.iter().enumerate() {
            if !f {
                chol.add_diag(d, 1.0);
            }
        }
        chol.factor(self.opts.pivot_drop_tol);
        self.stats.last_null_pivots = chol.n_null();
    }
}

impl Precond for Multigrid {
    fn rebuild(&mut self, op: &OperatorView<'_>) {
        let g = grid::grid(op.nx, op.ny, op.nz);
        let fresh = match self.levels.first() {
            Some(l0) => {
                l0.grid != g || !matches!(&l0.op, ElemOp::Fine { ke1, .. } if ke1[..] == op.ke1[..])
            }
            None => true,
        };
        if fresh {
            self.setup(g, op.ke1);
        }
        if self.diff_fine(op, fresh) {
            self.propagate();
        }
    }

    fn apply(&mut self, r: &[f64], z: &mut [f64]) {
        match self.coarse.as_mut() {
            Some(coarse) if !self.levels.is_empty() => {
                vcycle(
                    &mut self.levels,
                    &self.transfers,
                    coarse,
                    self.opts.sweeps,
                    r,
                    z,
                );
            }
            _ => z.copy_from_slice(r),
        }
    }

    fn levels(&self) -> usize {
        self.levels.len()
    }
}

fn omega_for(opts: &MgOptions, lambda_bound: f64) -> f64 {
    opts.omega.min(opts.omega_cap / lambda_bound)
}

/// `K ← (K + Kᵀ) / 2` for a 24×24 row-major matrix.
fn symmetrize(k: &mut [f64]) {
    for i in 0..24 {
        for j in i + 1..24 {
            let v = 0.5 * (k[i * 24 + j] + k[j * 24 + i]);
            k[i * 24 + j] = v;
            k[j * 24 + i] = v;
        }
    }
}

/// One damped-Jacobi sweep `z += ω D⁻¹ (r − A z)`.
fn smooth(l: &mut Level, r: &[f64], z: &mut [f64]) {
    let mut t = std::mem::take(&mut l.t);
    l.apply(z, &mut t);
    for (((zi, ri), ti), di) in z.iter_mut().zip(r).zip(&t).zip(&l.inv_diag) {
        *zi += di * (ri - ti);
    }
    l.t = t;
}

/// `z = B_l r` on `levels[0]` (recursive symmetric V-cycle).
fn vcycle(
    levels: &mut [Level],
    transfers: &[Transfer],
    coarse: &mut BandedCholesky,
    sweeps: usize,
    r: &[f64],
    z: &mut [f64],
) {
    let Some((cur, rest)) = levels.split_first_mut() else {
        return;
    };
    let (Some(tr), Some(next)) = (transfers.first(), rest.first_mut()) else {
        coarse.solve(r, z);
        return;
    };
    // Pre-smoothing from z = 0 (the first sweep needs no matvec).
    for ((zi, ri), di) in z.iter_mut().zip(r).zip(&cur.inv_diag) {
        *zi = ri * di;
    }
    for _ in 1..sweeps {
        smooth(cur, r, z);
    }
    // Restrict the residual.
    let mut t = std::mem::take(&mut cur.t);
    cur.apply(z, &mut t);
    for (ti, ri) in t.iter_mut().zip(r) {
        *ti = ri - *ti;
    }
    tr.restrict(&t, &cur.free, &mut next.r);
    cur.t = t;
    // Coarse correction.
    let rc = std::mem::take(&mut next.r);
    let mut zc = std::mem::take(&mut next.z);
    vcycle(rest, &transfers[1..], coarse, sweeps, &rc, &mut zc);
    tr.prolong_add(&zc, &cur.free, z);
    rest[0].r = rc;
    rest[0].z = zc;
    // Post-smoothing.
    for _ in 0..sweeps {
        smooth(cur, r, z);
    }
}
