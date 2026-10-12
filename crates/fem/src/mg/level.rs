//! One multigrid level: its operator `A_l = M_l K_l M_l + (I − M_l)`, diagonal, mask,
//! per-DOF smoother damping and work vectors.

use super::grid::node_elems;
use super::spectral::lambda_max_bound;
use crate::grid::{Grid, HEX8_NODE_OFFSETS};
use crate::hex8::{Ke, mul24};

/// Squarings for the `Ke1` bound (computed once; overestimate ≤ 24^(1/2048)).
const KE1_SQUARINGS: u32 = 10;

/// Local node index from its offset bits `dx + 2 dy + 4 dz`.
const LOCAL_FROM_BITS: [usize; 8] = [0, 1, 3, 2, 4, 5, 7, 6];

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

/// How the per-DOF bound `λᵢ ≥` "local `λ_max(D⁻¹A)`" is obtained (see [`Level::update_nodes`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Bound {
    /// `λᵢ = Σₑ λₑ Dₑ,ᵢᵢ / Aᵢᵢ` from per-element spectral bounds.
    Element,
    /// `λᵢ = Σⱼ |Aᵢⱼ| / Aᵢᵢ` (assembled Gershgorin / l1 row ratio).
    L1,
}

#[derive(Clone, Debug)]
pub(crate) struct Level {
    pub grid: Grid,
    pub op: ElemOp,
    /// Per DOF: unknown of this level (diagonal > 0 and, on the finest level, free).
    pub free: Vec<bool>,
    /// Diagonal of `K` (0 where masked).
    pub diag: Vec<f64>,
    /// `w_i / A_ii` on free DOFs, 1 on masked DOFs (exact inverse of the identity block).
    pub inv_diag: Vec<f64>,
    /// Element DOF offsets relative to `3 · node0(e)`.
    dof_off: [usize; 24],
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
        let nodes = grid.node_offsets();
        Self {
            grid,
            op,
            free: vec![false; nd],
            diag: vec![0.0; nd],
            inv_diag: vec![1.0; nd],
            dof_off: std::array::from_fn(|i| 3 * nodes[i / 3] + i % 3),
            r: vec![0.0; nd],
            z: vec![0.0; nd],
            t: vec![0.0; nd],
        }
    }

    #[cfg(test)]
    pub fn n_dofs(&self) -> usize {
        self.free.len()
    }

    /// Smallest and largest damping `wᵢ = inv_diagᵢ · Aᵢᵢ` over free DOFs.
    pub fn damping(&self) -> (f64, f64) {
        let mut out = (f64::INFINITY, 0.0f64);
        for ((&inv, &d), &f) in self.inv_diag.iter().zip(&self.diag).zip(&self.free) {
            if f {
                out = (out.0.min(inv * d), out.1.max(inv * d));
            }
        }
        if out.1 > 0.0 { out } else { (0.0, 0.0) }
    }

    /// Calls `f(e, 3 · node0(e))` for every element in index order.
    #[inline]
    fn for_each_elem(&self, mut f: impl FnMut(usize, usize)) {
        let g = &self.grid;
        let sx = g.nx + 1;
        let sxy = sx * (g.ny + 1);
        let mut e = 0;
        for z in 0..g.nz {
            for y in 0..g.ny {
                let mut base = 3 * (sx * y + sxy * z);
                for _ in 0..g.nx {
                    f(e, base);
                    e += 1;
                    base += 3;
                }
            }
        }
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
                    for (i, row) in out.chunks_exact_mut(24).enumerate() {
                        for (j, o) in row.iter_mut().enumerate() {
                            *o = if m[i] && m[j] {
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
        let off = &self.dof_off;
        match &self.op {
            ElemOp::Fine {
                ke1,
                coef,
                free_in,
                all_free,
                ..
            } => {
                self.for_each_elem(|e, base| {
                    let c = coef[e];
                    if c == 0.0 {
                        return;
                    }
                    if all_free[e] {
                        let xe: [f64; 24] = std::array::from_fn(|i| x[base + off[i]]);
                        let ye = mul24(ke1, &xe);
                        for (o, v) in off.iter().zip(ye) {
                            y[base + o] += c * v;
                        }
                    } else {
                        let xe: [f64; 24] = std::array::from_fn(|i| {
                            let d = base + off[i];
                            if free_in[d] { x[d] } else { 0.0 }
                        });
                        let ye = mul24(ke1, &xe);
                        for (o, v) in off.iter().zip(ye) {
                            if free_in[base + o] {
                                y[base + o] += c * v;
                            }
                        }
                    }
                });
            }
            ElemOp::Stored { mats, nonzero, .. } => {
                self.for_each_elem(|e, base| {
                    if !nonzero[e] {
                        return;
                    }
                    let xe: [f64; 24] = std::array::from_fn(|i| x[base + off[i]]);
                    let k: &Ke = mats[e * 576..e * 576 + 576]
                        .try_into()
                        .unwrap_or_else(|_| unreachable!("576-element chunk"));
                    let ye = mul24(k, &xe);
                    for (o, v) in off.iter().zip(ye) {
                        y[base + o] += v;
                    }
                });
            }
        }
        for ((yd, &xd), &f) in y.iter_mut().zip(x).zip(&self.free) {
            if !f {
                *yd = xd;
            }
        }
    }

    /// Finest level: refresh `all_free` of the given elements (after `coef`/`free_in` changed).
    pub fn refresh_all_free(&mut self, elems: &[usize]) {
        let g = self.grid;
        if let ElemOp::Fine {
            coef,
            free_in,
            all_free,
            ..
        } = &mut self.op
        {
            for &e in elems {
                all_free[e] = coef[e] != 0.0 && g.element_dofs(e).iter().all(|&d| free_in[d]);
            }
        }
    }

    /// Row `i` of element `e`'s (masked) matrix into `out`; `false` for an all-zero row.
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

    /// Per-element spectral bound `λₑ` of element `e`.
    fn elem_lambda(&self, e: usize) -> f64 {
        match &self.op {
            ElemOp::Fine { lam, .. } => *lam,
            ElemOp::Stored { lam, .. } => lam[e],
        }
    }

    /// Recompute `free`, `diag` and the smoother weights `inv_diag` of the DOFs of the
    /// given nodes, node by node (the result does not depend on which other nodes are
    /// updated, so incremental and full updates agree bit for bit).
    ///
    /// Damping: if `xᵀAx ≤ Σᵢ λᵢ Aᵢᵢ xᵢ²` for all `x`, then `wᵢ = min(ω, cap / λᵢ)` gives
    /// `A ≤ cap · W⁻¹` for `W = diag(wᵢ / Aᵢᵢ)`, so the Jacobi smoother `z += W (r − A z)`
    /// is A-norm convergent for `cap < 2`. Valid choices of `λᵢ` ([`Bound`]):
    /// - element bounds `xₑᵀKₑxₑ ≤ λₑ xₑᵀDₑxₑ` (`Dₑ = diag Kₑ`) summed over elements give
    ///   `λᵢ = Σₑ λₑ Dₑ,ᵢᵢ / Aᵢᵢ`;
    /// - `λᵢ = Σⱼ |Aᵢⱼ| / Aᵢᵢ`, since `diag(Σⱼ|Aᵢⱼ|) − A` is diagonally dominant.
    pub fn update_nodes(&mut self, nodes: &[usize], omega: f64, cap: f64, bound: Bound) {
        let g = self.grid;
        let mut elems = Vec::with_capacity(8);
        let mut buf = [0.0f64; 3 * 81];
        let mut row = [0.0f64; 24];
        for &n in nodes {
            node_elems(&g, n, &mut elems);
            let [ni, nj, nk] = g.node_coords(n);
            let mut d = [0.0f64; 3];
            let mut lacc = [0.0f64; 3];
            if bound == Bound::L1 {
                buf.fill(0.0);
            }
            for &e in &elems {
                let [x, y, z] = g.element_coords(e);
                let a = LOCAL_FROM_BITS[(ni - x) + 2 * (nj - y) + 4 * (nk - z)];
                let dofs = g.element_dofs(e);
                let lam_e = self.elem_lambda(e);
                for r in 0..3 {
                    let i = 3 * a + r;
                    if !self.elem_row(e, &dofs, i, &mut row) {
                        continue;
                    }
                    d[r] += row[i];
                    match bound {
                        Bound::Element => lacc[r] += lam_e * row[i],
                        Bound::L1 => {
                            for (b, off) in HEX8_NODE_OFFSETS.iter().enumerate() {
                                // Neighbour offset in {-1, 0, 1}³ relative to node n.
                                let idx = (x + off[0] + 1 - ni)
                                    + 3 * (y + off[1] + 1 - nj)
                                    + 9 * (z + off[2] + 1 - nk);
                                let dst = &mut buf[r * 81 + 3 * idx..r * 81 + 3 * idx + 3];
                                for (o, v) in dst.iter_mut().zip(&row[3 * b..3 * b + 3]) {
                                    *o += v;
                                }
                            }
                        }
                    }
                }
            }
            if bound == Bound::L1 {
                for (r, l) in lacc.iter_mut().enumerate() {
                    *l = buf[r * 81..r * 81 + 81].iter().map(|v| v.abs()).sum();
                }
            }
            for r in 0..3 {
                let dof = 3 * n + r;
                let free_in = match &self.op {
                    ElemOp::Fine { free_in, .. } => free_in[dof],
                    ElemOp::Stored { .. } => true,
                };
                let f = free_in && d[r] > 0.0;
                self.free[dof] = f;
                self.diag[dof] = if f { d[r] } else { 0.0 };
                self.inv_diag[dof] = if f {
                    // λᵢ = lacc / d; w = min(ω, cap / λᵢ).
                    let w = if lacc[r] > 0.0 {
                        omega.min(cap * d[r] / lacc[r])
                    } else {
                        omega
                    };
                    w / d[r]
                } else {
                    1.0
                };
            }
        }
    }
}
