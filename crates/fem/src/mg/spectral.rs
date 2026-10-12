//! Rigorous upper bounds of `λ_max(diag(K)⁻¹ K)` for symmetric positive-semidefinite
//! 24×24 element matrices, used to choose safe Jacobi damping.
//!
//! With `S = D^{-1/2} K D^{-1/2}` (restricted to rows with `K_ii > 0`; the other rows of a
//! PSD matrix are zero) and eigenvalues `λ_i ≥ 0`, `tr(S^p)^{1/p} = (Σ λ_i^p)^{1/p}` is an
//! upper bound of `λ_max` that tightens as `p` grows (overestimate ≤ `n^{1/p}`). It is
//! computed by repeated squaring with renormalisation: `p = 2^{k+1}` after `k` squarings.

/// Upper bound of `λ_max(D⁻¹K)` for a symmetric PSD 24×24 row-major `k`, using `squarings`
/// matrix squarings (`p = 2^(squarings+1)`). Also capped by the Gershgorin row bound.
/// Returns 0 for an all-zero matrix.
pub(crate) fn lambda_max_bound(k: &[f64], squarings: u32) -> f64 {
    debug_assert_eq!(k.len(), 576);
    // Active rows and scaling.
    let mut idx = [0usize; 24];
    let mut n = 0;
    for i in 0..24 {
        if k[i * 25] > 0.0 {
            idx[n] = i;
            n += 1;
        }
    }
    if n == 0 {
        return 0.0;
    }
    let s: [f64; 24] = std::array::from_fn(|a| {
        if a < n {
            1.0 / k[idx[a] * 25].sqrt()
        } else {
            0.0
        }
    });
    let mut t = [0.0f64; 576];
    let mut gersh = 0.0f64;
    for a in 0..n {
        let mut row = 0.0;
        for b in 0..n {
            let v = k[idx[a] * 24 + idx[b]] * s[a] * s[b];
            t[a * 24 + b] = v;
            row += v.abs();
        }
        gersh = gersh.max(row);
    }
    // T_j = S^(2^j) / c_j with ‖T_j‖_F = 1 for j ≥ 1; track ln c_j.
    let mut ln_c = 0.0f64;
    let mut sq = [0.0f64; 576];
    for _ in 0..squarings {
        // sq = t·t (symmetric: compute the upper triangle, mirror).
        let mut fro2 = 0.0;
        for a in 0..n {
            for b in a..n {
                let ra = &t[a * 24..a * 24 + n];
                let rb = &t[b * 24..b * 24 + n];
                let v: f64 = ra.iter().zip(rb).map(|(x, y)| x * y).sum();
                sq[a * 24 + b] = v;
                sq[b * 24 + a] = v;
                fro2 += if a == b { v * v } else { 2.0 * v * v };
            }
        }
        let fro = fro2.sqrt();
        if fro == 0.0 || !fro.is_finite() {
            return gersh;
        }
        ln_c = 2.0 * ln_c + fro.ln();
        for a in 0..n {
            for b in 0..n {
                t[a * 24 + b] = sq[a * 24 + b] / fro;
            }
        }
    }
    // tr(S^(2^(m+1))) = ‖S^(2^m)‖_F² = c_m² ‖T_m‖_F².
    let mut fro2 = 0.0;
    for a in 0..n {
        for b in 0..n {
            fro2 += t[a * 24 + b] * t[a * 24 + b];
        }
    }
    let p = 2f64.powi(squarings as i32 + 1);
    let bound = ((2.0 * ln_c + fro2.ln()) / p).exp();
    // Guard against rounding in the last digits: a tiny relative margin.
    (bound * (1.0 + 1e-12)).min(gersh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex8::ke1;

    /// Largest eigenvalue of a dense symmetric matrix by cyclic Jacobi rotations.
    fn jacobi_lambda_max(a: &[Vec<f64>]) -> f64 {
        let n = a.len();
        let mut m = a.to_vec();
        for _ in 0..100 {
            let off: f64 = (0..n)
                .flat_map(|i| (0..n).filter(move |&j| j != i).map(move |j| (i, j)))
                .map(|(i, j)| m[i][j] * m[i][j])
                .sum();
            if off < 1e-28 {
                break;
            }
            for p in 0..n {
                for q in p + 1..n {
                    if m[p][q].abs() < 1e-300 {
                        continue;
                    }
                    let theta = (m[q][q] - m[p][p]) / (2.0 * m[p][q]);
                    let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                    let t = if theta == 0.0 { 1.0 } else { t };
                    let c = 1.0 / (t * t + 1.0).sqrt();
                    let s = t * c;
                    for row in m.iter_mut() {
                        let (mkp, mkq) = (row[p], row[q]);
                        row[p] = c * mkp - s * mkq;
                        row[q] = s * mkp + c * mkq;
                    }
                    let (rp, rq) = (m[p].clone(), m[q].clone());
                    for (k, (&mpk, &mqk)) in rp.iter().zip(&rq).enumerate() {
                        m[p][k] = c * mpk - s * mqk;
                        m[q][k] = s * mpk + c * mqk;
                    }
                }
            }
        }
        (0..n).map(|i| m[i][i]).fold(f64::MIN, f64::max)
    }

    fn scaled_dense(k: &[f64]) -> Vec<Vec<f64>> {
        let act: Vec<usize> = (0..24).filter(|&i| k[i * 25] > 0.0).collect();
        act.iter()
            .map(|&i| {
                act.iter()
                    .map(|&j| k[i * 24 + j] / (k[i * 25] * k[j * 25]).sqrt())
                    .collect()
            })
            .collect()
    }

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    }

    #[test]
    fn bound_is_above_and_close_to_true_lambda_max() {
        let mut seed = 42u64;
        let mut mats: Vec<Vec<f64>> = vec![ke1(0.3).to_vec(), ke1(0.45).to_vec()];
        // Masked Ke1 and random low-rank PSD matrices with a zero row.
        let mut masked = ke1(0.3).to_vec();
        for j in 0..24 {
            for i in [0usize, 4, 13] {
                masked[i * 24 + j] = 0.0;
                masked[j * 24 + i] = 0.0;
            }
        }
        mats.push(masked);
        for rank in [1usize, 3, 24] {
            let b: Vec<f64> = (0..24 * rank).map(|_| lcg(&mut seed)).collect();
            let mut k = vec![0.0; 576];
            for i in 1..24 {
                for j in 1..24 {
                    k[i * 24 + j] = (0..rank).map(|m| b[i * rank + m] * b[j * rank + m]).sum();
                }
            }
            mats.push(k);
        }
        for k in &mats {
            let exact = jacobi_lambda_max(&scaled_dense(k));
            for (sq, slack) in [(1u32, 2.0), (3, 1.25), (6, 1.04)] {
                let b = lambda_max_bound(k, sq);
                assert!(b >= exact * (1.0 - 1e-12), "bound {b} < exact {exact}");
                assert!(
                    b <= exact * slack,
                    "squarings {sq}: bound {b} vs exact {exact}"
                );
            }
        }
        assert_eq!(lambda_max_bound(&[0.0; 576], 3), 0.0);
    }
}
