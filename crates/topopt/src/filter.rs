//! Density filter (Bruns & Tortorelli 2001; Andreassen et al. 2011, `top88`):
//! `x̃_e = Σ_j w_ej x_j / Σ_j w_ej`, `w_ej = max(0, r − dist(e, j))` with distances in
//! voxels, over *participating* (domain) elements only so that non-domain cells do not
//! dilute densities at the domain boundary. Weights are symmetric and precomputed (CSR).

use crate::layout::Dims;

#[derive(Debug, Clone)]
pub struct DensityFilter {
    n: usize,
    /// CSR row starts (len n + 1); rows of non-participating elements are empty.
    start: Vec<usize>,
    col: Vec<u32>,
    w: Vec<f64>,
    /// Row sums `Σ_j w_ej` (0 for non-participating rows).
    sum: Vec<f64>,
}

impl DensityFilter {
    /// `radius` in voxels (≈ 1.5 → the 18 face/edge neighbours plus the cell itself).
    pub fn new(dims: Dims, radius: f64, participate: &[bool]) -> DensityFilter {
        let n = dims.len();
        assert_eq!(participate.len(), n, "participate mask length");
        let r = radius.max(0.0);
        let reach = r.ceil() as isize;
        // Stencil of (dx, dy, dz, weight) with positive weight, computed once.
        let mut stencil = Vec::new();
        for dz in -reach..=reach {
            for dy in -reach..=reach {
                for dx in -reach..=reach {
                    let dist = ((dx * dx + dy * dy + dz * dz) as f64).sqrt();
                    let w = r - dist;
                    if w > 0.0 {
                        stencil.push((dx, dy, dz, w));
                    }
                }
            }
        }
        if stencil.is_empty() {
            // radius < ... : identity filter
            stencil.push((0, 0, 0, 1.0));
        }
        let (nx, ny, nz) = (dims.nx as isize, dims.ny as isize, dims.nz as isize);
        let mut start = Vec::with_capacity(n + 1);
        let mut col = Vec::new();
        let mut w = Vec::new();
        let mut sum = vec![0.0; n];
        start.push(0);
        for e in 0..n {
            if participate[e] {
                let [x, y, z] = dims.coords(e).map(|c| c as isize);
                let mut s = 0.0;
                for &(dx, dy, dz, wt) in &stencil {
                    let (i, j, k) = (x + dx, y + dy, z + dz);
                    if i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz {
                        continue;
                    }
                    let f = (i + nx * (j + ny * k)) as usize;
                    if participate[f] {
                        col.push(f as u32);
                        w.push(wt);
                        s += wt;
                    }
                }
                sum[e] = s;
            }
            start.push(col.len());
        }
        DensityFilter {
            n,
            start,
            col,
            w,
            sum,
        }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    fn row(&self, e: usize) -> impl Iterator<Item = (usize, f64)> + '_ {
        let r = self.start[e]..self.start[e + 1];
        self.col[r.clone()]
            .iter()
            .zip(&self.w[r])
            .map(|(&c, &w)| (c as usize, w))
    }

    /// `out_e = Σ_j w_ej x_j / Σ_j w_ej` (0 for non-participating `e`).
    pub fn apply(&self, x: &[f64], out: &mut [f64]) {
        assert!(x.len() == self.n && out.len() == self.n);
        for (e, o) in out.iter_mut().enumerate() {
            *o = if self.sum[e] > 0.0 {
                self.row(e).map(|(j, w)| w * x[j]).sum::<f64>() / self.sum[e]
            } else {
                0.0
            };
        }
    }

    /// Chain rule through the filter: `out_j = Σ_e w_ej g_e / Σ_k w_ek` (transpose of
    /// [`apply`](Self::apply); valid because `w` is symmetric).
    pub fn apply_transpose(&self, g: &[f64], out: &mut [f64]) {
        assert!(g.len() == self.n && out.len() == self.n);
        out.iter_mut().for_each(|o| *o = 0.0);
        for (e, (&ge, &sum)) in g.iter().zip(&self.sum).enumerate() {
            if sum > 0.0 {
                let ge = ge / sum;
                for (j, w) in self.row(e) {
                    out[j] += w * ge;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn radius_1_5_has_19_point_stencil_inside() {
        let d = Dims::new(5, 5, 5);
        let f = DensityFilter::new(d, 1.5, &vec![true; d.len()]);
        let c = d.index(2, 2, 2);
        assert_eq!(f.row(c).count(), 1 + 6 + 12);
        let s: f64 = f.row(c).map(|(_, w)| w).sum();
        let expect = 1.5 + 6.0 * 0.5 + 12.0 * (1.5 - 2f64.sqrt());
        assert!((s - expect).abs() < 1e-12);
        // corner: self + 3 faces + 3 edges
        assert_eq!(f.row(0).count(), 7);
    }

    #[test]
    fn preserves_constants_and_is_adjoint() {
        let d = Dims::new(6, 4, 3);
        let n = d.len();
        let part: Vec<bool> = (0..n).map(|e| e % 7 != 3).collect();
        let f = DensityFilter::new(d, 1.5, &part);
        let ones = vec![1.0; n];
        let mut out = vec![0.0; n];
        f.apply(&ones, &mut out);
        for e in 0..n {
            let expect = if part[e] { 1.0 } else { 0.0 };
            assert!((out[e] - expect).abs() < 1e-14);
        }
        // <F x, g> == <x, Fᵀ g>
        let x: Vec<f64> = (0..n).map(|e| ((e * 37 % 11) as f64) / 11.0).collect();
        let g: Vec<f64> = (0..n).map(|e| ((e * 13 % 5) as f64) - 2.0).collect();
        let mut fx = vec![0.0; n];
        let mut ftg = vec![0.0; n];
        f.apply(&x, &mut fx);
        f.apply_transpose(&g, &mut ftg);
        let lhs: f64 = fx.iter().zip(&g).map(|(a, b)| a * b).sum();
        let rhs: f64 = x.iter().zip(&ftg).map(|(a, b)| a * b).sum();
        assert!((lhs - rhs).abs() < 1e-10 * lhs.abs().max(1.0));
    }

    #[test]
    fn small_radius_is_identity() {
        let d = Dims::new(3, 2, 2);
        let n = d.len();
        let f = DensityFilter::new(d, 0.5, &vec![true; n]);
        let x: Vec<f64> = (0..n).map(|e| e as f64).collect();
        let mut out = vec![0.0; n];
        f.apply(&x, &mut out);
        assert_eq!(out, x);
    }
}
