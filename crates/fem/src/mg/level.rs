//! One multigrid level: its operator `A_l = M_l K_l M_l + (I − M_l)`, diagonal, mask and
//! work vectors.

use super::grid::node_elems;
use super::spectral::lambda_max_bound;
use crate::grid::{Grid, HEX8_NODE_OFFSETS};
use crate::hex8::{Ke, mul24};

/// Squarings for the `Ke1` bound (computed once; overestimate ≤ 24^(1/2048)).
const KE1_SQUARINGS: u32 = 10;

/// How the element matrices of a level are represented.
#[derive(Clone, Debug)]
pub(crate) enum ElemOp {
    /// Finest level, matrix-free: `K_e = coef_e · M_e Ke1 M_e`.
    Fine {
        ke1: Box<Ke>,
        coef: Vec<f64>,
        /// The caller's free mask (before dropping zero-diagonal DOFs), for diffing.
        free_in: Vec<bool>,
        /// Element has `coef ≠ 0` and all 24 DOFs free (no gather/scatter masking).
        all_free: Vec<bool>,
        /// Upper bound of `λ_max(diag(Ke1)⁻¹ Ke1)`; by eigenvalue interlacing it also
        /// bounds every masked, scaled element `coef · M_e Ke1 M_e`.
        lam: f64,
    },
    /// Coarse level: stored Galerkin element matrices (24×24 row-major per element).
    /// Rows/columns of masked DOFs are exactly zero by construction.
    Stored {
        mats: Vec<f64>,
        nonzero: Vec<bool>,
        /// Per element: upper bound of `λ_max(D_e⁻¹ K_e)` (see `spectral`).
        lam: Vec<f64>,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct Level {
    pub grid: Grid,
    pub op: ElemOp,
    /// Per DOF: unknown of this level (diagonal > 0 and, on the finest level, free).
    pub free: Vec<bool>,
    /// `w_i / A_ii` on free DOFs, 1 on masked DOFs (exact inverse of the identity block).
    pub inv_diag: Vec<f64>,
    /// Smallest and largest damping `w_i` over free DOFs.
    pub damping: (f64, f64),
    /// Work vectors: right-hand side, correction, temporary.
    pub r: Vec<f64>,
    pub z: Vec<f64>,
    pub t: Vec<f64>,
}

impl Level {
    pub fn new_fine(grid: Grid, ke1: &Ke) -> Self {
        let (ne, nd) = (grid.elements(), grid.dofs());
        Self::with_op(
            grid,
            ElemOp::Fine {
                ke1: Box::new(*ke1),
                coef: vec![0.0; ne],
                free_in: vec![false; nd],
                all_free: vec![false; ne],
                lam: lambda_max_bound(&ke1[..], KE1_SQUARINGS),
            },
        )
    }

    pub fn new_stored(grid: Grid) -> Self {
        let ne = grid.elements();
        Self::with_op(
            grid,
            ElemOp::Stored {
                mats: vec![0.0; ne * 576],
                nonzero: vec![false; ne],
                lam: vec![0.0; ne],
            },
        )
    }

    fn with_op(grid: Grid, op: ElemOp) -> Self {
        let nd = grid.dofs();
        Self {
            grid,
            op,
            free: vec![false; nd],
            inv_diag: vec![1.0; nd],
            damping: (0.0, 0.0),
            r: vec![0.0; nd],
            z: vec![0.0; nd],
            t: vec![0.0; nd],
        }
    }

    #[cfg(test)]
    pub fn n_dofs(&self) -> usize {
        self.free.len()
    }

    /// Element matrix `K_e` with masking applied (rows/cols of masked DOFs zero).
    /// Returns `false` (and leaves `out` untouched) for an all-zero element.
    pub fn elem_matrix(&self, e: usize, out: &mut [f64; 576]) -> bool {
        match &self.op {
            ElemOp::Fine {
                ke1,
                coef,
                free_in,
                all_free,
                ..
            } => {
                let c = coef[e];
                if c == 0.0 {
                    return false;
                }
                if all_free[e] {
                    for (o, k) in out.iter_mut().zip(ke1.iter()) {
                        *o = c * k;
                    }
                } else {
                    let dofs = self.grid.element_dofs(e);
                    let m: [bool; 24] = std::array::from_fn(|i| free_in[dofs[i]]);
                    for i in 0..24 {
                        for j in 0..24 {
                            out[i * 24 + j] = if m[i] && m[j] {
                                c * ke1[i * 24 + j]
                            } else {
                                0.0
                            };
                        }
                    }
                }
                true
            }
            ElemOp::Stored { mats, nonzero, .. } => {
                if !nonzero[e] {
                    return false;
                }
                out.copy_from_slice(&mats[e * 576..e * 576 + 576]);
                true
            }
        }
    }

    /// `y = A_l x`.
    pub fn apply(&self, x: &[f64], y: &mut [f64]) {
        y.fill(0.0);
        let g = &self.grid;
        match &self.op {
            ElemOp::Fine {
                ke1,
                coef,
                free_in,
                all_free,
                ..
            } => {
                for (e, &c) in coef.iter().enumerate() {
                    if c == 0.0 {
                        continue;
                    }
                    let dofs = g.element_dofs(e);
                    if all_free[e] {
                        let xe: [f64; 24] = std::array::from_fn(|i| x[dofs[i]]);
                        let ye = mul24(ke1, &xe);
                        for (d, v) in dofs.iter().zip(ye) {
                            y[*d] += c * v;
                        }
                    } else {
                        let xe: [f64; 24] =
                            std::array::from_fn(
                                |i| {
                                    if free_in[dofs[i]] { x[dofs[i]] } else { 0.0 }
                                },
                            );
                        let ye = mul24(ke1, &xe);
                        for (d, v) in dofs.iter().zip(ye) {
                            if free_in[*d] {
                                y[*d] += c * v;
                            }
                        }
                    }
                }
            }
            ElemOp::Stored { mats, nonzero, .. } => {
                for (e, &nz) in nonzero.iter().enumerate() {
                    if !nz {
                        continue;
                    }
                    let dofs = g.element_dofs(e);
                    let xe: [f64; 24] = std::array::from_fn(|i| x[dofs[i]]);
                    let k: &Ke = mats[e * 576..e * 576 + 576]
                        .try_into()
                        .unwrap_or_else(|_| unreachable!("576-element chunk"));
                    let ye = mul24(k, &xe);
                    for (d, v) in dofs.iter().zip(ye) {
                        y[*d] += v;
                    }
                }
            }
        }
        for ((yd, &xd), &f) in y.iter_mut().zip(x).zip(&self.free) {
            if !f {
                *yd = xd;
            }
        }
    }

    /// Recompute `free`, the diagonal and the per-DOF damping; on the finest level also
    /// `all_free`.
    ///
    /// Damping: with per-element bounds `xₑᵀKₑxₑ ≤ λₑ xₑᵀDₑxₑ` (`Dₑ = diag Kₑ`),
    /// `xᵀAx ≤ Σᵢ λᵢ Aᵢᵢ xᵢ²` with `λᵢ = Σₑ λₑ Dₑ,ᵢᵢ / Aᵢᵢ`. Choosing
    /// `wᵢ = min(ω, cap / λᵢ)` gives `A ≤ cap · W⁻¹` for `W = diag(wᵢ / Aᵢᵢ)`, so the Jacobi
    /// smoother `z += W (r − A z)` is A-norm convergent for `cap < 2`.
    ///
    /// With `l1`, `λᵢ = Σⱼ |Aᵢⱼ| / Aᵢᵢ` (assembled Gershgorin row ratio) is used instead;
    /// `W⁻¹ ≥ diag(Σⱼ|Aᵢⱼ|)/cap ≥ A/cap` holds as well (diagonally dominant difference).
    pub fn update_diag(&mut self, omega: f64, cap: f64, l1: bool) {
        let g = self.grid;
        // Scratch: t = diagonal, z = Σₑ λₑ Dₑ,ᵢᵢ.
        let (diag, lacc) = (&mut self.t, &mut self.z);
        diag.fill(0.0);
        lacc.fill(0.0);
        match &mut self.op {
            ElemOp::Fine {
                ke1,
                coef,
                free_in,
                all_free,
                lam,
            } => {
                for (e, &c) in coef.iter().enumerate() {
                    if c == 0.0 {
                        all_free[e] = false;
                        continue;
                    }
                    let dofs = g.element_dofs(e);
                    let mut af = true;
                    for (i, &d) in dofs.iter().enumerate() {
                        if free_in[d] {
                            let v = c * ke1[i * 25];
                            diag[d] += v;
                            lacc[d] += *lam * v;
                        } else {
                            af = false;
                        }
                    }
                    all_free[e] = af;
                }
                for ((f, &fi), &d) in self.free.iter_mut().zip(free_in.iter()).zip(diag.iter()) {
                    *f = fi && d > 0.0;
                }
            }
            ElemOp::Stored {
                mats, nonzero, lam, ..
            } => {
                for (e, &nz) in nonzero.iter().enumerate() {
                    if !nz {
                        continue;
                    }
                    let k = &mats[e * 576..e * 576 + 576];
                    for (i, &d) in g.element_dofs(e).iter().enumerate() {
                        let v = k[i * 25];
                        diag[d] += v;
                        lacc[d] += lam[e] * v;
                    }
                }
                for (f, &d) in self.free.iter_mut().zip(diag.iter()) {
                    *f = d > 0.0;
                }
            }
        }
        if l1 {
            let mut rows = std::mem::take(&mut self.z);
            self.l1_rows(&mut rows);
            self.z = rows;
        }
        let (diag, lacc) = (&self.t, &self.z);
        let (mut wmin, mut wmax) = (f64::INFINITY, 0.0f64);
        for (((inv, &d), &l), &f) in self
            .inv_diag
            .iter_mut()
            .zip(diag.iter())
            .zip(lacc.iter())
            .zip(&self.free)
        {
            *inv = if f {
                // λᵢ = l / d; w = min(ω, cap / λᵢ).
                let w = if l > 0.0 {
                    omega.min(cap * d / l)
                } else {
                    omega
                };
                wmin = wmin.min(w);
                wmax = wmax.max(w);
                w / d
            } else {
                1.0
            };
        }
        self.damping = if wmax > 0.0 { (wmin, wmax) } else { (0.0, 0.0) };
    }

    /// Row `i` of element `e`'s (masked) matrix into `out`; `false` for an all-zero element.
    fn elem_row(&self, e: usize, dofs: &[usize; 24], i: usize, out: &mut [f64; 24]) -> bool {
        match &self.op {
            ElemOp::Fine {
                ke1, coef, free_in, ..
            } => {
                let c = coef[e];
                if c == 0.0 || !free_in[dofs[i]] {
                    return false;
                }
                for (j, o) in out.iter_mut().enumerate() {
                    *o = if free_in[dofs[j]] {
                        c * ke1[i * 24 + j]
                    } else {
                        0.0
                    };
                }
                true
            }
            ElemOp::Stored { mats, nonzero, .. } => {
                if !nonzero[e] {
                    return false;
                }
                out.copy_from_slice(&mats[e * 576 + i * 24..e * 576 + i * 24 + 24]);
                true
            }
        }
    }

    /// `out[d] = Σⱼ |K_dj|` of the assembled (masked) `K`, node by node.
    fn l1_rows(&self, out: &mut [f64]) {
        // Local node index from its offset bits dx + 2 dy + 4 dz.
        const LOCAL: [usize; 8] = [0, 1, 3, 2, 4, 5, 7, 6];
        let g = self.grid;
        let mut elems = Vec::with_capacity(8);
        let mut buf = [0.0f64; 3 * 81];
        let mut row = [0.0f64; 24];
        for n in 0..g.nodes() {
            node_elems(&g, n, &mut elems);
            buf.fill(0.0);
            let [ni, nj, nk] = g.node_coords(n);
            for &e in &elems {
                let [x, y, z] = g.element_coords(e);
                let a = LOCAL[(ni - x) + 2 * (nj - y) + 4 * (nk - z)];
                let dofs = g.element_dofs(e);
                for r in 0..3 {
                    if !self.elem_row(e, &dofs, 3 * a + r, &mut row) {
                        continue;
                    }
                    for (b, off) in HEX8_NODE_OFFSETS.iter().enumerate() {
                        // Neighbour offset in {-1, 0, 1}³ relative to node n.
                        let idx = (x + off[0] + 1 - ni)
                            + 3 * (y + off[1] + 1 - nj)
                            + 9 * (z + off[2] + 1 - nk);
                        for c in 0..3 {
                            buf[r * 81 + 3 * idx + c] += row[3 * b + c];
                        }
                    }
                }
            }
            for r in 0..3 {
                out[3 * n + r] = buf[r * 81..r * 81 + 81].iter().map(|v| v.abs()).sum();
            }
        }
    }
}
