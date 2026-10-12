//! Banded Cholesky factorisation for the coarsest multigrid level.
//!
//! DOFs are renumbered so that the grid axis with the most nodes varies slowest, which
//! minimises the bandwidth of a structured hex grid (`3·(n_a·n_b + n_a + 1) + 2` for the
//! two smallest node counts `n_a ≤ n_b`).
//!
//! The coarse Galerkin operator can be singular in degenerate carved geometries (e.g. a
//! one-voxel strut whose fine nodes all interpolate from the coarse nodes with identical
//! weights). Such directions lie in the null space of the masked prolongation `M P`, so
//! they never affect the fine-level correction. A pivot that collapses below
//! `drop_tol · A_ii` is therefore treated as a null pivot: that unknown is fixed to 0 and
//! its column of `L` is zeroed. The result `G = L⁻ᵀ D⁺ L⁻¹` is a symmetric
//! positive-semidefinite generalised inverse, so the V-cycle stays symmetric.

use crate::grid::Grid;

#[derive(Clone, Debug)]
pub(crate) struct BandedCholesky {
    n: usize,
    bw: usize,
    /// Natural DOF → banded index.
    perm: Vec<usize>,
    /// Row `i`, column `j ∈ [i − bw, i]` at `l[i·(bw+1) + j + bw − i]`.
    l: Vec<f64>,
    /// Diagonal of the assembled matrix before factorisation.
    diag0: Vec<f64>,
    null: Vec<bool>,
    work: Vec<f64>,
    n_null: usize,
}

impl BandedCholesky {
    pub fn new(dims: Grid) -> Self {
        let nd = [dims.nx + 1, dims.ny + 1, dims.nz + 1];
        // Axes sorted by node count, smallest varies fastest.
        let mut order = [0usize, 1, 2];
        order.sort_by_key(|&a| nd[a]);
        let n = dims.dofs();
        let mut perm = vec![0usize; n];
        for k in 0..nd[2] {
            for j in 0..nd[1] {
                for i in 0..nd[0] {
                    let c = [i, j, k];
                    let p = c[order[0]] + nd[order[0]] * (c[order[1]] + nd[order[1]] * c[order[2]]);
                    let node = dims.node_index(i, j, k);
                    for comp in 0..3 {
                        perm[3 * node + comp] = 3 * p + comp;
                    }
                }
            }
        }
        let mut bw = 0usize;
        for e in 0..dims.elements() {
            let dofs = dims.element_dofs(e);
            let (mut lo, mut hi) = (usize::MAX, 0usize);
            for d in dofs {
                lo = lo.min(perm[d]);
                hi = hi.max(perm[d]);
            }
            bw = bw.max(hi - lo);
        }
        Self {
            n,
            bw,
            perm,
            l: vec![0.0; n * (bw + 1)],
            diag0: vec![0.0; n],
            null: vec![false; n],
            work: vec![0.0; n],
            n_null: 0,
        }
    }

    pub fn n(&self) -> usize {
        self.n
    }

    pub fn bandwidth(&self) -> usize {
        self.bw
    }

    /// Number of pivots treated as null in the last factorisation.
    pub fn n_null(&self) -> usize {
        self.n_null
    }

    pub fn clear(&mut self) {
        self.l.fill(0.0);
    }

    #[inline]
    fn idx(&self, i: usize, j: usize) -> usize {
        debug_assert!(j <= i && i - j <= self.bw);
        i * (self.bw + 1) + j + self.bw - i
    }

    /// Add the lower triangle of a symmetric 24×24 element matrix.
    pub fn add_elem(&mut self, dofs: &[usize; 24], k: &[f64]) {
        for (a, &da) in dofs.iter().enumerate() {
            let pa = self.perm[da];
            for (b, &db) in dofs.iter().enumerate() {
                let pb = self.perm[db];
                if pb <= pa {
                    let v = k[a * 24 + b];
                    if v != 0.0 {
                        let id = self.idx(pa, pb);
                        self.l[id] += v;
                    }
                }
            }
        }
    }

    /// Add `v` to the diagonal entry of natural DOF `d`.
    pub fn add_diag(&mut self, d: usize, v: f64) {
        let p = self.perm[d];
        let id = self.idx(p, p);
        self.l[id] += v;
    }

    /// In-place Cholesky `A = L Lᵀ` with null-pivot dropping (see module docs).
    pub fn factor(&mut self, drop_tol: f64) {
        let w = self.bw + 1;
        for i in 0..self.n {
            self.diag0[i] = self.l[i * w + self.bw];
        }
        self.null.fill(false);
        self.n_null = 0;
        for i in 0..self.n {
            let lo_i = i.saturating_sub(self.bw);
            for j in lo_i..=i {
                let lo_j = j.saturating_sub(self.bw);
                let k0 = lo_i.max(lo_j);
                let mut s = self.l[i * w + j + self.bw - i];
                if k0 < j {
                    let ri = &self.l[i * w + k0 + self.bw - i..i * w + j + self.bw - i];
                    let rj = &self.l[j * w + k0 + self.bw - j..j * w + self.bw];
                    s -= ri.iter().zip(rj).map(|(a, b)| a * b).sum::<f64>();
                }
                let id = i * w + j + self.bw - i;
                if j < i {
                    self.l[id] = if self.null[j] {
                        0.0
                    } else {
                        s / self.l[j * w + self.bw]
                    };
                } else if !(s.is_finite() && s > drop_tol * self.diag0[i]) {
                    self.null[i] = true;
                    self.n_null += 1;
                    self.l[id] = 1.0;
                } else {
                    self.l[id] = s.sqrt();
                }
            }
        }
    }

    /// `x = G b` with the factorisation from [`factor`](Self::factor) (natural ordering).
    pub fn solve(&mut self, b: &[f64], x: &mut [f64]) {
        let w = self.bw + 1;
        let y = &mut self.work;
        for (d, &p) in self.perm.iter().enumerate() {
            y[p] = b[d];
        }
        // Forward: L y = b.
        for i in 0..self.n {
            if self.null[i] {
                y[i] = 0.0;
                continue;
            }
            let lo = i.saturating_sub(self.bw);
            let row = &self.l[i * w + lo + self.bw - i..i * w + self.bw];
            let s: f64 = row.iter().zip(&y[lo..i]).map(|(a, b)| a * b).sum();
            y[i] = (y[i] - s) / self.l[i * w + self.bw];
        }
        // Backward: Lᵀ x = y (row-oriented column sweep).
        for i in (0..self.n).rev() {
            let xi = if self.null[i] {
                0.0
            } else {
                y[i] / self.l[i * w + self.bw]
            };
            y[i] = xi;
            if xi != 0.0 {
                let lo = i.saturating_sub(self.bw);
                let row = &self.l[i * w + lo + self.bw - i..i * w + self.bw];
                for (yk, lik) in y[lo..i].iter_mut().zip(row) {
                    *yk -= lik * xi;
                }
            }
        }
        for (d, &p) in self.perm.iter().enumerate() {
            x[d] = y[p];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mg::grid::grid;

    /// Deterministic pseudo-random numbers in [-1, 1).
    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    }

    #[test]
    fn bandwidth_is_minimal_for_structured_grid() {
        // Node dims 5×3×9 → fastest 3, then 5: bw = 3·(3·5 + 3 + 1) + 2.
        let c = BandedCholesky::new(grid(4, 2, 8));
        assert_eq!(c.bandwidth(), 3 * (3 * 5 + 3 + 1) + 2);
    }

    #[test]
    fn solves_spd_element_assembly() {
        let dims = grid(3, 2, 2);
        let n = dims.dofs();
        let mut seed = 7u64;
        let mut dense = vec![vec![0.0; n]; n];
        let mut c = BandedCholesky::new(dims);
        for e in 0..dims.elements() {
            // Random SPD element matrix B Bᵀ + I.
            let b: Vec<f64> = (0..576).map(|_| lcg(&mut seed)).collect();
            let mut k = vec![0.0; 576];
            for i in 0..24 {
                for j in 0..24 {
                    let mut s = if i == j { 1.0 } else { 0.0 };
                    for m in 0..24 {
                        s += b[i * 24 + m] * b[j * 24 + m];
                    }
                    k[i * 24 + j] = s;
                }
            }
            let dofs = dims.element_dofs(e);
            c.add_elem(&dofs, &k);
            for a in 0..24 {
                for bb in 0..24 {
                    dense[dofs[a]][dofs[bb]] += k[a * 24 + bb];
                }
            }
        }
        c.factor(1e-12);
        assert_eq!(c.n_null(), 0);
        let xs: Vec<f64> = (0..n).map(|_| lcg(&mut seed)).collect();
        let b: Vec<f64> = (0..n)
            .map(|i| (0..n).map(|j| dense[i][j] * xs[j]).sum())
            .collect();
        let mut x = vec![0.0; n];
        c.solve(&b, &mut x);
        for i in 0..n {
            assert!((x[i] - xs[i]).abs() < 1e-9, "{i}: {} vs {}", x[i], xs[i]);
        }
    }

    #[test]
    fn singular_matrix_gives_consistent_symmetric_solution() {
        // Assemble a singular PSD matrix: one element with a rank-deficient matrix.
        let dims = grid(1, 1, 1);
        let n = dims.dofs();
        let mut seed = 3u64;
        let rank = 10;
        let b: Vec<f64> = (0..24 * rank).map(|_| lcg(&mut seed)).collect();
        let mut k = vec![0.0; 576];
        for i in 0..24 {
            for j in 0..24 {
                k[i * 24 + j] = (0..rank).map(|m| b[i * rank + m] * b[j * rank + m]).sum();
            }
        }
        let mut c = BandedCholesky::new(dims);
        let dofs = dims.element_dofs(0);
        c.add_elem(&dofs, &k);
        c.factor(1e-10);
        assert_eq!(c.n_null(), 24 - rank);
        // Natural-order dense copy.
        let mut a = vec![vec![0.0; n]; n];
        for i in 0..24 {
            for j in 0..24 {
                a[dofs[i]][dofs[j]] = k[i * 24 + j];
            }
        }
        // G is symmetric and A G A = A on consistent right-hand sides.
        let mut g = vec![vec![0.0; n]; n];
        for j in 0..n {
            let mut e = vec![0.0; n];
            e[j] = 1.0;
            let mut col = vec![0.0; n];
            c.solve(&e, &mut col);
            for (row, v) in g.iter_mut().zip(&col) {
                row[j] = *v;
            }
        }
        for (i, row) in g.iter().enumerate() {
            for (j, gij) in row.iter().enumerate() {
                assert!((gij - g[j][i]).abs() < 1e-8 * (1.0 + gij.abs()));
            }
        }
        let xs: Vec<f64> = (0..n).map(|_| lcg(&mut seed)).collect();
        let rhs: Vec<f64> = (0..n)
            .map(|i| (0..n).map(|j| a[i][j] * xs[j]).sum())
            .collect();
        let mut x = vec![0.0; n];
        c.solve(&rhs, &mut x);
        for i in 0..n {
            let ax: f64 = (0..n).map(|j| a[i][j] * x[j]).sum();
            assert!((ax - rhs[i]).abs() < 1e-8, "{i}: {ax} vs {}", rhs[i]);
        }
    }
}
