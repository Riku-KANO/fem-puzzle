//! Optimality-criteria update (Bendsøe & Sigmund; `top88` / `top3d`) with bisection on the
//! Lagrange multiplier of the volume constraint.
//!
//! The volume is a linear functional of the design variables, `V(x) = Σ_j dv_j x_j + c`
//! (true for the density filter, whose transpose gives `dv`), so the bisection never needs
//! to re-filter: only the free variables move and `c` absorbs everything fixed.

/// OC step parameters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OcParams {
    /// Max change of a design variable per iteration.
    pub move_limit: f64,
    /// Damping exponent on the optimality ratio (½ in the classical scheme).
    pub eta: f64,
    /// Lower bound of the design variables.
    pub x_min: f64,
}

impl Default for OcParams {
    fn default() -> Self {
        OcParams {
            move_limit: 0.2,
            eta: 0.5,
            x_min: 0.0,
        }
    }
}

/// Result of one OC step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OcStep {
    /// Lagrange multiplier found by the bisection.
    pub lambda: f64,
    /// `Σ_free dv_j x_new_j` (the free part of the volume).
    pub free_volume: f64,
    /// `max_j |x_new_j − x_j|`.
    pub change: f64,
}

/// One OC update of the free variables.
///
/// * `dc` — objective sensitivities w.r.t. the design variables (≤ 0 for compliance;
///   positive noise is treated as 0),
/// * `dv` — volume sensitivities (> 0 on free variables),
/// * `free_target` — required `Σ_free dv_j x_new_j`.
///
/// Non-free entries of `out` are copied from `x`.
pub fn oc_update(
    x: &[f64],
    dc: &[f64],
    dv: &[f64],
    free: &[bool],
    free_target: f64,
    params: OcParams,
    out: &mut [f64],
) -> OcStep {
    let n = x.len();
    assert!(dc.len() == n && dv.len() == n && free.len() == n && out.len() == n);
    let m = params.move_limit;
    let x_max = 1.0;
    let lo = |j: usize| (x[j] - m).max(params.x_min);
    let hi = |j: usize| (x[j] + m).min(x_max);
    let candidate = |j: usize, lambda: f64| -> f64 {
        let g = (-dc[j]).max(0.0);
        let dvj = dv[j].max(f64::MIN_POSITIVE);
        let b = g / (lambda * dvj);
        (x[j] * b.powf(params.eta)).clamp(lo(j), hi(j))
    };
    let volume = |lambda: f64| -> f64 {
        (0..n)
            .filter(|&j| free[j])
            .map(|j| dv[j] * candidate(j, lambda))
            .sum()
    };

    // Scale-aware bracket in log λ: around the value that keeps x unchanged on average.
    let (num, den) = (0..n).filter(|&j| free[j]).fold((0.0, 0.0), |(a, b), j| {
        (a + (-dc[j]).max(0.0) * x[j], b + dv[j] * x[j])
    });
    let lambda0 = if num > 0.0 && den > 0.0 {
        num / den
    } else {
        1.0
    };
    let (mut l1, mut l2) = (lambda0.ln() - 80.0, lambda0.ln() + 80.0);
    let mut lambda = lambda0;
    for _ in 0..200 {
        let lm = 0.5 * (l1 + l2);
        lambda = lm.exp();
        if volume(lambda) > free_target {
            l1 = lm;
        } else {
            l2 = lm;
        }
        if l2 - l1 < 1e-13 {
            break;
        }
    }
    let mut change: f64 = 0.0;
    let mut free_volume = 0.0;
    for j in 0..n {
        out[j] = if free[j] { candidate(j, lambda) } else { x[j] };
        if free[j] {
            free_volume += dv[j] * out[j];
        }
        change = change.max((out[j] - x[j]).abs());
    }
    OcStep {
        lambda,
        free_volume,
        change,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Separable model: `C = Σ a_e / x_e`, `Σ x_e = V`. Optimum `x_e ∝ √a_e`, and the OC
    /// fixed point with η = ½ hits it exactly when the move limit is inactive.
    #[test]
    fn converges_to_analytic_optimum_of_separable_problem() {
        let a = [1.0, 4.0, 9.0, 16.0, 0.25, 2.25];
        let n = a.len();
        let target = 2.0;
        let free = vec![true; n];
        let dv = vec![1.0; n];
        let mut x = vec![target / n as f64; n];
        let params = OcParams {
            move_limit: 0.05,
            ..OcParams::default()
        };
        let mut out = vec![0.0; n];
        let mut last = f64::INFINITY;
        for _ in 0..200 {
            let dc: Vec<f64> = (0..n).map(|e| -a[e] / (x[e] * x[e])).collect();
            let step = oc_update(&x, &dc, &dv, &free, target, params, &mut out);
            assert!((step.free_volume - target).abs() < 1e-9, "volume {step:?}");
            let c: f64 = (0..n).map(|e| a[e] / out[e]).sum();
            assert!(c <= last + 1e-9, "objective must not increase");
            last = c;
            x.copy_from_slice(&out);
        }
        let s: f64 = a.iter().map(|v| v.sqrt()).sum();
        for e in 0..n {
            let expect = target * a[e].sqrt() / s;
            assert!(
                (x[e] - expect).abs() < 1e-6,
                "x[{e}] = {} vs {expect}",
                x[e]
            );
        }
    }

    #[test]
    fn respects_bounds_fixed_entries_and_infeasible_targets() {
        let x = vec![0.5, 0.5, 1.0, 0.1];
        let dc = vec![-1.0, -1e-6, -3.0, 0.4]; // positive noise on the last one
        let dv = vec![1.0, 1.0, 1.0, 1.0];
        let free = vec![true, true, false, true];
        let mut out = vec![0.0; 4];
        // Huge target: every free variable at its upper move limit.
        let s = oc_update(&x, &dc, &dv, &free, 10.0, OcParams::default(), &mut out);
        assert_eq!(out[2], 1.0);
        assert!((out[0] - 0.7).abs() < 1e-12 && (out[1] - 0.7).abs() < 1e-12);
        assert!(
            out[3].abs() < 1e-12,
            "zero sensitivity sits at the lower bound"
        );
        assert!(s.change <= 0.2 + 1e-12);
        // Zero target: everything at its lower move limit.
        oc_update(&x, &dc, &dv, &free, 0.0, OcParams::default(), &mut out);
        assert!((out[0] - 0.3).abs() < 1e-12 && (out[3] - 0.0).abs() < 1e-12);
    }
}
