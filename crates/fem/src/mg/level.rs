//! One multigrid level: its operator `A_l = M_l K_l M_l + (I − M_l)`, diagonal, mask and
//! work vectors.

use crate::grid::Grid;
use crate::hex8::{Ke, mul24};

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
    },
    /// Coarse level: stored Galerkin element matrices (24×24 row-major per element).
    /// Rows/columns of masked DOFs are exactly zero by construction.
    Stored { mats: Vec<f64>, nonzero: Vec<bool> },
}

#[derive(Clone, Debug)]
pub(crate) struct Level {
    pub grid: Grid,
    pub op: ElemOp,
    /// Per DOF: unknown of this level (diagonal > 0 and, on the finest level, free).
    pub free: Vec<bool>,
    /// `ω / A_ii` on free DOFs, 1 on masked DOFs (exact inverse of the identity block).
    pub inv_diag: Vec<f64>,
    /// Upper bound of `λ_max(D⁻¹ A)` (element-wise Gershgorin bound).
    pub lambda_bound: f64,
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
            lambda_bound: 1.0,
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
            ElemOp::Stored { mats, nonzero } => {
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
            ElemOp::Stored { mats, nonzero } => {
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

    /// Recompute `free`, the diagonal, `inv_diag = ω / A_ii` and the Gershgorin bound
    /// `max_e max_i Σ_j |K_e,ij| / K_e,ii` of `λ_max(D⁻¹A)` (valid because
    /// `xᵀAx = Σ_e x_eᵀK_e x_e ≤ λ_e x_eᵀD_e x_e` and `D = Σ_e D_e`).
    /// On the finest level, `all_free` is refreshed too.
    pub fn update_diag(&mut self, omega_of_bound: impl Fn(f64) -> f64) {
        let g = self.grid;
        let diag = &mut self.t; // reuse as scratch
        diag.fill(0.0);
        let mut bound = 0.0f64;
        match &mut self.op {
            ElemOp::Fine {
                ke1,
                coef,
                free_in,
                all_free,
            } => {
                // Unmasked Ke1 row bound; masking only removes entries, but the ratio of a
                // masked row can be larger than that of the full row, so bound each
                // partially masked element explicitly.
                let full_bound = row_bound(&ke1[..], &[true; 24]);
                for (e, &c) in coef.iter().enumerate() {
                    let dofs = g.element_dofs(e);
                    if c == 0.0 {
                        all_free[e] = false;
                        continue;
                    }
                    let m: [bool; 24] = std::array::from_fn(|i| free_in[dofs[i]]);
                    all_free[e] = m.iter().all(|&f| f);
                    let b = if all_free[e] {
                        full_bound
                    } else {
                        row_bound(&ke1[..], &m)
                    };
                    bound = bound.max(b);
                    for (i, &d) in dofs.iter().enumerate() {
                        if m[i] {
                            diag[d] += c * ke1[i * 25];
                        }
                    }
                }
                for ((f, &fi), &d) in self.free.iter_mut().zip(free_in.iter()).zip(diag.iter()) {
                    *f = fi && d > 0.0;
                }
            }
            ElemOp::Stored { mats, nonzero } => {
                for (e, &nz) in nonzero.iter().enumerate() {
                    if !nz {
                        continue;
                    }
                    let k = &mats[e * 576..e * 576 + 576];
                    let m: [bool; 24] = std::array::from_fn(|i| k[i * 25] > 0.0);
                    bound = bound.max(row_bound(k, &m));
                    for (i, d) in g.element_dofs(e).iter().enumerate() {
                        diag[*d] += k[i * 25];
                    }
                }
                for (f, &d) in self.free.iter_mut().zip(diag.iter()) {
                    *f = d > 0.0;
                }
            }
        }
        self.lambda_bound = bound.max(f64::MIN_POSITIVE);
        let omega = omega_of_bound(self.lambda_bound);
        for ((inv, &d), &f) in self.inv_diag.iter_mut().zip(diag.iter()).zip(&self.free) {
            *inv = if f { omega / d } else { 1.0 };
        }
    }
}

/// `max_i Σ_j |K_ij| / K_ii` over unmasked rows/cols of a 24×24 matrix (Gershgorin
/// bound of `λ_max(diag(K)⁻¹ K)` restricted to the unmasked block).
fn row_bound(k: &[f64], m: &[bool; 24]) -> f64 {
    let mut b = 0.0f64;
    for i in 0..24 {
        let kii = k[i * 25];
        if !m[i] || kii <= 0.0 {
            continue;
        }
        let s: f64 = (0..24).filter(|&j| m[j]).map(|j| k[i * 24 + j].abs()).sum();
        b = b.max(s / kii);
    }
    b
}
