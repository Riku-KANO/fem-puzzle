//! Hex8 (trilinear brick) element on the unit cube, `E = 1`, `h = 1`.
//!
//! Strain/stress use Voigt order `[xx, yy, zz, xy, yz, zx]` with engineering shear
//! strains (`γxy = ∂u/∂y + ∂v/∂x`). Local node order is
//! [`HEX8_NODE_OFFSETS`](crate::grid::HEX8_NODE_OFFSETS); the element DOF vector is
//! `[n0x n0y n0z n1x … n7z]`.
//!
//! Scaling to a real voxel of edge `h` and modulus `E`: `Ke = E · h · Ke1`,
//! `B_h = B / h`, `σ = E · D₁ · ε`.

use crate::grid::HEX8_NODE_OFFSETS;

/// Reference element stiffness, 24×24 row-major (symmetric, so also column-major).
pub type Ke = [f64; 576];

/// Strain-displacement matrix `B` (6×24) of the unit cube at local point `(x, y, z) ∈ [0,1]³`.
pub fn b_matrix(x: f64, y: f64, z: f64) -> [[f64; 24]; 6] {
    let mut b = [[0.0; 24]; 6];
    for (a, &[ox, oy, oz]) in HEX8_NODE_OFFSETS.iter().enumerate() {
        // 1D shape functions and derivatives: N = x for offset 1, 1 - x for offset 0.
        let f = |t: f64, o: usize| if o == 1 { t } else { 1.0 - t };
        let df = |o: usize| if o == 1 { 1.0 } else { -1.0 };
        let (nx, ny, nz) = (f(x, ox), f(y, oy), f(z, oz));
        let dx = df(ox) * ny * nz;
        let dy = nx * df(oy) * nz;
        let dz = nx * ny * df(oz);
        let c = 3 * a;
        b[0][c] = dx;
        b[1][c + 1] = dy;
        b[2][c + 2] = dz;
        b[3][c] = dy;
        b[3][c + 1] = dx;
        b[4][c + 1] = dz;
        b[4][c + 2] = dy;
        b[5][c] = dz;
        b[5][c + 2] = dx;
    }
    b
}

/// `B` at the element centroid (used for post-processing stress).
pub fn b_centroid() -> [[f64; 24]; 6] {
    b_matrix(0.5, 0.5, 0.5)
}

/// Isotropic elasticity matrix `D₁` for `E = 1` and Poisson ratio `nu` (Voigt, engineering shear).
pub fn d1(nu: f64) -> [[f64; 6]; 6] {
    let lambda = nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
    let mu = 1.0 / (2.0 * (1.0 + nu));
    let mut d = [[0.0; 6]; 6];
    for (i, row) in d.iter_mut().enumerate().take(3) {
        for (j, v) in row.iter_mut().enumerate().take(3) {
            *v = lambda + if i == j { 2.0 * mu } else { 0.0 };
        }
    }
    for (i, row) in d.iter_mut().enumerate().skip(3) {
        row[i] = mu;
    }
    d
}

/// Reference stiffness `Ke1 = ∫ Bᵀ D₁ B dV` over the unit cube, 2×2×2 Gauss integration.
pub fn ke1(nu: f64) -> Ke {
    let d = d1(nu);
    let g = 0.5 / 3f64.sqrt();
    let pts = [0.5 - g, 0.5 + g];
    let mut k = [0.0; 576];
    for &x in &pts {
        for &y in &pts {
            for &z in &pts {
                let b = b_matrix(x, y, z);
                // db = D · B (6×24)
                let mut db = [[0.0; 24]; 6];
                for i in 0..6 {
                    for j in 0..24 {
                        db[i][j] = (0..6).map(|m| d[i][m] * b[m][j]).sum();
                    }
                }
                // Gauss weight 1/8 per point on the unit cube (volume 1).
                for i in 0..24 {
                    for j in 0..24 {
                        let s: f64 = (0..6).map(|m| b[m][i] * db[m][j]).sum();
                        k[i * 24 + j] += 0.125 * s;
                    }
                }
            }
        }
    }
    // Symmetrise exactly (removes round-off asymmetry).
    for i in 0..24 {
        for j in (i + 1)..24 {
            let v = 0.5 * (k[i * 24 + j] + k[j * 24 + i]);
            k[i * 24 + j] = v;
            k[j * 24 + i] = v;
        }
    }
    k
}

/// `y = K · x` for a 24×24 element matrix (axpy form, vectorises well).
///
/// Kept out of line on purpose (T-312): when LLVM inlines it into a gather → `mul24` →
/// scatter loop (`Operator::apply`, `mg::Level::apply`), the SLP vectoriser keeps the 24
/// accumulators as scalars for the scatter and repacks them every column
/// (`mov.d` + `fadd.2d` + `ext` + stack spills), which made native PCG ~2× slower. Out of
/// line, the accumulators stay in vector registers. WASM is unaffected (scalar code).
#[inline(never)]
pub fn mul24(k: &Ke, x: &[f64; 24]) -> [f64; 24] {
    let mut y = [0.0; 24];
    for (j, col) in k.chunks_exact(24).enumerate() {
        let xj = x[j];
        for (yi, kij) in y.iter_mut().zip(col) {
            *yi += kij * xj;
        }
    }
    y
}

/// von Mises equivalent stress of a Voigt stress vector `[xx, yy, zz, xy, yz, zx]`.
pub fn von_mises(s: &[f64; 6]) -> f64 {
    let [sx, sy, sz, txy, tyz, tzx] = *s;
    let v = 0.5 * ((sx - sy).powi(2) + (sy - sz).powi(2) + (sz - sx).powi(2))
        + 3.0 * (txy * txy + tyz * tyz + tzx * tzx);
    v.max(0.0).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NU: f64 = 0.3;

    /// Node positions of the unit cube in local order.
    fn node_xyz(a: usize) -> [f64; 3] {
        HEX8_NODE_OFFSETS[a].map(|o| o as f64)
    }

    /// Element DOF vector of the linear displacement field `u(p) = c + G p`.
    fn linear_field(c: [f64; 3], g: [[f64; 3]; 3]) -> [f64; 24] {
        let mut u = [0.0; 24];
        for a in 0..8 {
            let p = node_xyz(a);
            for i in 0..3 {
                u[3 * a + i] = c[i] + (0..3).map(|j| g[i][j] * p[j]).sum::<f64>();
            }
        }
        u
    }

    fn rigid_modes() -> Vec<[f64; 24]> {
        let mut modes = Vec::new();
        for i in 0..3 {
            let mut c = [0.0; 3];
            c[i] = 1.0;
            modes.push(linear_field(c, [[0.0; 3]; 3]));
        }
        // Infinitesimal rotations: skew-symmetric gradients.
        let rots = [
            [[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
            [[0.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]],
            [[0.0, 0.0, 1.0], [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0]],
        ];
        for g in rots {
            modes.push(linear_field([0.3, -0.2, 0.1], g));
        }
        modes
    }

    #[test]
    fn ke1_is_symmetric() {
        let k = ke1(NU);
        for i in 0..24 {
            for j in 0..24 {
                assert_eq!(k[i * 24 + j], k[j * 24 + i]);
            }
        }
    }

    #[test]
    fn ke1_annihilates_rigid_body_modes() {
        let k = ke1(NU);
        let scale = k.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        for r in rigid_modes() {
            let y = mul24(&k, &r);
            let err = y.iter().fold(0.0f64, |m, v| m.max(v.abs()));
            assert!(err < 1e-13 * scale, "rigid mode not in null space: {err}");
        }
    }

    /// Cyclic Jacobi eigenvalue iteration for a small symmetric matrix.
    fn sym_eigenvalues(mut a: Vec<f64>, n: usize) -> Vec<f64> {
        for _sweep in 0..100 {
            let off: f64 = (0..n)
                .flat_map(|i| (0..n).filter(move |&j| j != i).map(move |j| (i, j)))
                .map(|(i, j)| a[i * n + j].powi(2))
                .sum();
            if off < 1e-30 {
                break;
            }
            for p in 0..n {
                for q in (p + 1)..n {
                    let apq = a[p * n + q];
                    if apq.abs() < 1e-300 {
                        continue;
                    }
                    let theta = (a[q * n + q] - a[p * n + p]) / (2.0 * apq);
                    let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                    let t = if theta == 0.0 { 1.0 } else { t };
                    let c = 1.0 / (t * t + 1.0).sqrt();
                    let s = t * c;
                    for k in 0..n {
                        let akp = a[k * n + p];
                        let akq = a[k * n + q];
                        a[k * n + p] = c * akp - s * akq;
                        a[k * n + q] = s * akp + c * akq;
                    }
                    for k in 0..n {
                        let apk = a[p * n + k];
                        let aqk = a[q * n + k];
                        a[p * n + k] = c * apk - s * aqk;
                        a[q * n + k] = s * apk + c * aqk;
                    }
                }
            }
        }
        let mut ev: Vec<f64> = (0..n).map(|i| a[i * n + i]).collect();
        ev.sort_by(f64::total_cmp);
        ev
    }

    #[test]
    fn ke1_is_psd_with_exactly_six_zero_eigenvalues() {
        for nu in [0.0, 0.3, 0.33, 0.45] {
            let ev = sym_eigenvalues(ke1(nu).to_vec(), 24);
            let max = ev[23];
            let zero = ev.iter().filter(|v| v.abs() < 1e-10 * max).count();
            assert_eq!(zero, 6, "nu={nu}: eigenvalues {ev:?}");
            assert!(ev[6] > 1e-3 * max, "nu={nu}: smallest non-zero {}", ev[6]);
            assert!(ev[0] > -1e-10 * max);
        }
    }

    #[test]
    fn ke1_matches_closed_form_entries() {
        // Exact integrals over the unit cube: K[0x,0x] = (λ+4μ)/9, K[0x,0y] = (λ+μ)/12.
        let k = ke1(NU);
        let c = 1.0 / ((1.0 + NU) * (1.0 - 2.0 * NU));
        assert!((k[0] - (2.0 - 3.0 * NU) / 9.0 * c).abs() < 1e-14);
        assert!((k[1] - c / 24.0).abs() < 1e-14);
    }

    #[test]
    fn b_reproduces_linear_strain() {
        let g = [[0.1, 0.2, -0.3], [0.05, -0.4, 0.7], [0.6, 0.25, 0.9]];
        let u = linear_field([1.0, 2.0, 3.0], g);
        let expected = [
            g[0][0],
            g[1][1],
            g[2][2],
            g[0][1] + g[1][0],
            g[1][2] + g[2][1],
            g[2][0] + g[0][2],
        ];
        for p in [(0.5, 0.5, 0.5), (0.1, 0.7, 0.3), (1.0, 0.0, 0.2)] {
            let b = b_matrix(p.0, p.1, p.2);
            for i in 0..6 {
                let eps: f64 = (0..24).map(|j| b[i][j] * u[j]).sum();
                assert!((eps - expected[i]).abs() < 1e-14, "{i}: {eps}");
            }
        }
    }

    #[test]
    fn uniaxial_von_mises() {
        assert!((von_mises(&[5.0, 0.0, 0.0, 0.0, 0.0, 0.0]) - 5.0).abs() < 1e-14);
        assert!((von_mises(&[0.0, 0.0, 0.0, 2.0, 0.0, 0.0]) - 2.0 * 3f64.sqrt()).abs() < 1e-14);
        assert!(von_mises(&[3.0, 3.0, 3.0, 0.0, 0.0, 0.0]).abs() < 1e-14);
    }
}
