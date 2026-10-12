//! Matrix-free masked stiffness operator.
//!
//! `K = Σ_e coef_e · Ke1` (gathered/scattered per element, `coef_e = E_e · h`) and the
//! masked operator applied by PCG is `A = M K M + (I − M)` with `M = diag(free)`.
//! Elements with `coef_e = 0` (inactive in player mode, outside the domain) are skipped.

use crate::grid::Grid;
use crate::hex8::{self, Ke};

/// Borrowed description of the fine-level operator, handed to [`Precond::rebuild`](crate::Precond::rebuild).
///
/// Fine operator: `A = M K M + (I − M)`, `K = Σ_e coef[e] · Ke1` assembled over the
/// elements' 24 DOFs ([`Grid::element_dofs`] order), `M = diag(free)`.
#[derive(Debug, Clone, Copy)]
pub struct OperatorView<'a> {
    /// Elements along x.
    pub nx: usize,
    /// Elements along y.
    pub ny: usize,
    /// Elements along z.
    pub nz: usize,
    /// Reference element stiffness `Ke1` (24×24 row-major, `E = 1`, `h = 1`).
    pub ke1: &'a Ke,
    /// Per element: multiplier of `Ke1` in `K`, i.e. `E_e · h` (0 = element not assembled).
    pub coef: &'a [f64],
    /// Per DOF: free (unknown) vs held at zero.
    pub free: &'a [bool],
}

impl OperatorView<'_> {
    /// The element grid (with unit voxel size; `coef` already contains `h`).
    pub fn grid(&self) -> Grid {
        Grid {
            nx: self.nx,
            ny: self.ny,
            nz: self.nz,
            h: 1.0,
        }
    }

    /// Diagonal of `A` (1 on non-free DOFs).
    pub fn diagonal(&self, out: &mut [f64]) {
        let g = self.grid();
        assert_eq!(out.len(), g.dofs());
        out.fill(0.0);
        let off = dof_offsets(&g);
        for (e, &s) in self.coef.iter().enumerate() {
            if s != 0.0 {
                let base = 3 * g.element_node0(e);
                for (i, o) in off.iter().enumerate() {
                    out[base + o] += s * self.ke1[i * 25];
                }
            }
        }
        for (d, &f) in out.iter_mut().zip(self.free) {
            if !f {
                *d = 1.0;
            }
        }
    }
}

/// DOF offsets of the 24 element DOFs relative to `3 * node0(e)`.
fn dof_offsets(g: &Grid) -> [usize; 24] {
    let nodes = g.node_offsets();
    std::array::from_fn(|i| 3 * nodes[i / 3] + i % 3)
}

/// The fine-level operator: grid, `Ke1`, per-element coefficients and the free-DOF mask.
#[derive(Debug, Clone)]
pub struct Operator {
    grid: Grid,
    ke1: Box<Ke>,
    coef: Vec<f64>,
    free: Vec<bool>,
    /// 1.0 for free DOFs, 0.0 otherwise (branch-free gather).
    maskf: Vec<f64>,
    /// `(3 * node0, coef)` of every element with `coef != 0`.
    elems: Vec<(usize, f64)>,
    dof_off: [usize; 24],
    /// Scratch: node touches an assembled element.
    touched: Vec<bool>,
}

impl Operator {
    /// Operator with `Ke1(nu)` and no assembled elements (every DOF non-free).
    pub fn new(grid: Grid, nu: f64) -> Operator {
        Operator {
            grid,
            ke1: Box::new(hex8::ke1(nu)),
            coef: vec![0.0; grid.elements()],
            free: vec![false; grid.dofs()],
            maskf: vec![0.0; grid.dofs()],
            elems: Vec::new(),
            dof_off: dof_offsets(&grid),
            touched: vec![false; grid.nodes()],
        }
    }

    /// The element grid (with the real voxel size).
    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    /// Number of DOFs (`3 * nodes`).
    pub fn dofs(&self) -> usize {
        self.free.len()
    }

    /// Reference element stiffness `Ke1` (24×24 row-major, `E = 1`, `h = 1`).
    pub fn ke1(&self) -> &Ke {
        &self.ke1
    }

    /// Per element `E_e · h` (0 = not assembled).
    pub fn coef(&self) -> &[f64] {
        &self.coef
    }

    /// Per DOF free mask.
    pub fn free(&self) -> &[bool] {
        &self.free
    }

    /// Borrowed view for preconditioners.
    pub fn view(&self) -> OperatorView<'_> {
        OperatorView {
            nx: self.grid.nx,
            ny: self.grid.ny,
            nz: self.grid.nz,
            ke1: &self.ke1,
            coef: &self.coef,
            free: &self.free,
        }
    }

    /// Set `coef[e] = coef_of(e)` for every element and recompute the free mask:
    /// a DOF is free iff it is not `fixed` and its node touches an element with `coef != 0`.
    /// Returns whether `coef` or the mask changed.
    pub fn update(&mut self, fixed: &[bool], mut coef_of: impl FnMut(usize) -> f64) -> bool {
        assert_eq!(fixed.len(), self.dofs());
        let mut changed = false;
        self.elems.clear();
        self.touched.fill(false);
        for e in 0..self.coef.len() {
            let c = coef_of(e);
            changed |= c != self.coef[e];
            self.coef[e] = c;
            if c != 0.0 {
                let n0 = self.grid.element_node0(e);
                self.elems.push((3 * n0, c));
                for o in self.grid.node_offsets() {
                    self.touched[n0 + o] = true;
                }
            }
        }
        for (d, (f, m)) in self.free.iter_mut().zip(&mut self.maskf).enumerate() {
            let free = self.touched[d / 3] && !fixed[d];
            changed |= free != *f;
            *f = free;
            *m = if free { 1.0 } else { 0.0 };
        }
        changed
    }

    /// `y = A x = M K M x + (I − M) x`.
    pub fn apply(&self, x: &[f64], y: &mut [f64]) {
        assert!(x.len() == self.dofs() && y.len() == self.dofs());
        y.fill(0.0);
        let k = &*self.ke1;
        let off = &self.dof_off;
        for &(base, s) in &self.elems {
            let xe: [f64; 24] = std::array::from_fn(|i| {
                let d = base + off[i];
                x[d] * self.maskf[d]
            });
            let ye = hex8::mul24(k, &xe);
            for (o, v) in off.iter().zip(ye) {
                y[base + o] += s * v;
            }
        }
        for ((yd, &xd), &m) in y.iter_mut().zip(x).zip(&self.maskf) {
            if m == 0.0 {
                *yd = xd;
            }
        }
    }

    /// Diagonal of `A` (1 on non-free DOFs).
    pub fn diagonal(&self, out: &mut [f64]) {
        self.view().diagonal(out);
    }

    /// Displacements of element `e`'s 24 DOFs.
    pub fn gather(&self, e: usize, u: &[f64]) -> [f64; 24] {
        let base = 3 * self.grid.element_node0(e);
        std::array::from_fn(|i| u[base + self.dof_off[i]])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dense `A` by applying the operator to unit vectors.
    fn dense(op: &Operator) -> Vec<Vec<f64>> {
        let n = op.dofs();
        let mut x = vec![0.0; n];
        let mut cols = Vec::new();
        for j in 0..n {
            x[j] = 1.0;
            let mut y = vec![0.0; n];
            op.apply(&x, &mut y);
            cols.push(y);
            x[j] = 0.0;
        }
        cols
    }

    fn small() -> Operator {
        let g = Grid {
            nx: 3,
            ny: 2,
            nz: 1,
            h: 0.5,
        };
        let mut op = Operator::new(g, 0.3);
        let mut fixed = vec![false; g.dofs()];
        // Fix node (0,0,0) completely and node (0,1,0) in y.
        fixed[0] = true;
        fixed[1] = true;
        fixed[2] = true;
        fixed[3 * g.node_index(0, 1, 0) + 1] = true;
        // Element 4 = (1,1,0) absent; others with varying stiffness.
        let changed = op.update(&fixed, |e| if e == 4 { 0.0 } else { 1.0 + e as f64 });
        assert!(changed);
        assert!(!op.update(&fixed, |e| if e == 4 { 0.0 } else { 1.0 + e as f64 }));
        op
    }

    #[test]
    fn masked_operator_is_symmetric_with_identity_on_masked_dofs() {
        let op = small();
        let a = dense(&op);
        for (i, col) in a.iter().enumerate() {
            for (j, &aji) in col.iter().enumerate() {
                assert!((aji - a[j][i]).abs() < 1e-12, "({i},{j})");
                if !op.free()[i] {
                    assert_eq!(aji, if i == j { 1.0 } else { 0.0 });
                }
            }
        }
        // Every node touches some assembled element, so only the fixed DOFs are masked.
        let g = *op.grid();
        assert_eq!(op.free().iter().filter(|&&f| !f).count(), 4);
        assert!(!op.free()[0]);
        assert!(op.free()[3 * g.node_index(0, 1, 0)]);
        assert!(!op.free()[3 * g.node_index(0, 1, 0) + 1]);
    }

    #[test]
    fn apply_matches_element_assembly_and_diagonal() {
        let op = small();
        let g = *op.grid();
        let n = op.dofs();
        // Reference: assemble K densely, then mask.
        let mut k = vec![vec![0.0; n]; n];
        for e in 0..g.elements() {
            let dofs = g.element_dofs(e);
            for i in 0..24 {
                for j in 0..24 {
                    k[dofs[i]][dofs[j]] += op.coef()[e] * op.ke1()[i * 24 + j];
                }
            }
        }
        let a = dense(&op);
        let free = op.free();
        for i in 0..n {
            for j in 0..n {
                let expect = if free[i] && free[j] {
                    k[i][j]
                } else if i == j {
                    1.0
                } else {
                    0.0
                };
                assert!((a[j][i] - expect).abs() < 1e-12);
            }
        }
        let mut d = vec![0.0; n];
        op.diagonal(&mut d);
        for i in 0..n {
            assert!((d[i] - a[i][i]).abs() < 1e-12);
            assert!(d[i] > 0.0);
        }
    }

    #[test]
    fn node_touching_only_skipped_elements_is_masked() {
        let g = Grid {
            nx: 2,
            ny: 1,
            nz: 1,
            h: 1.0,
        };
        let mut op = Operator::new(g, 0.3);
        op.update(&vec![false; g.dofs()], |e| if e == 0 { 1.0 } else { 0.0 });
        for n in 0..g.nodes() {
            let [i, ..] = g.node_coords(n);
            for c in 0..3 {
                assert_eq!(op.free()[3 * n + c], i < 2);
            }
        }
    }
}
