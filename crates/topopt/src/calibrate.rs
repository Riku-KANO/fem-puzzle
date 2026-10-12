//! Calibration policy: which benchmark design to pick, how to scale loads, where the star
//! targets go. The solver-driven parts live in [`crate::driver`].

use crate::{Result, err, stagejson};

/// Judged max utilisation the benchmark design is calibrated to.
pub const TARGET_UTILIZATION: f64 = 0.9;
/// Significant digits of calibrated forces (rounded toward zero).
pub const FORCE_DIGITS: usize = 4;
/// Decimals of targets and the stored max utilisation.
pub const DECIMALS: usize = 4;
/// Candidates whose efficiency is within this factor of the best count as equally good;
/// the lightest of them is the benchmark.
pub const EFFICIENCY_TOL: f64 = 0.05;
pub const METHOD: &str = "simp-oc";

/// One thresholded SIMP design of the sweep.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub volfrac: f64,
    /// Volume fraction of the thresholded design.
    pub volume: f64,
    /// Judged max utilisation under the stage's current loads.
    pub utilization: f64,
}

impl Candidate {
    /// Load-scale-invariant efficiency `volume · utilisation` (lower is better). With the
    /// loads scaled so that a design sits at utilisation `u*`, a design of volume `v`
    /// passes iff `v·u ≤ v·u*`; so the design minimising `v·u` is the lightest one that
    /// passes at its own calibrated load among all designs of the sweep.
    pub fn efficiency(&self) -> f64 {
        self.volume * self.utilization
    }
}

/// Pick the benchmark: the lightest candidate whose efficiency is within
/// `1 + tol` of the best one (ties → lighter, then lower index).
///
/// Utilisation alone cannot choose (any design can be scaled to 0.9), and pure volume would
/// always pick the bottom of the sweep. `v·u` grows again for very light designs because
/// one-voxel members and jagged thresholded boundaries concentrate stress, so its
/// minimum is where the optimiser is at its best for this voxel resolution.
pub fn choose(cands: &[Candidate], tol: f64) -> Option<usize> {
    let ok = |c: &Candidate| c.utilization.is_finite() && c.utilization > 0.0;
    let best = cands
        .iter()
        .filter(|c| ok(c))
        .map(Candidate::efficiency)
        .fold(f64::INFINITY, f64::min);
    if !best.is_finite() {
        return None;
    }
    let mut pick: Option<usize> = None;
    for (i, c) in cands.iter().enumerate() {
        if ok(c) && c.efficiency() <= best * (1.0 + tol) {
            match pick {
                Some(p) if cands[p].volume <= c.volume => {}
                _ => pick = Some(i),
            }
        }
    }
    pick
}

/// Star targets from the benchmark volume (task T-203): `+0.05 / +0.15 / min(+0.30, 0.95)`,
/// rounded to [`DECIMALS`].
pub fn targets_for(bench_volume: f64) -> Result<stage::Targets> {
    let r = |x: f64| stagejson::round_decimals(x, DECIMALS);
    let t = stage::Targets {
        star3: r(bench_volume + 0.05),
        star2: r(bench_volume + 0.15),
        star1: r((bench_volume + 0.30).min(0.95)),
    };
    if !(t.star1 > t.star2 && t.star2 > t.star3 && t.star1 <= 1.0) {
        return err(format!(
            "benchmark volume {bench_volume:.3} too heavy for the star scheme ({t:?})"
        ));
    }
    Ok(t)
}

/// Scale factor that brings `utilization` to [`TARGET_UTILIZATION`].
pub fn load_scale(utilization: f64) -> Result<f64> {
    if !(utilization.is_finite() && utilization > 0.0) {
        return err(format!("cannot scale loads: utilisation {utilization}"));
    }
    Ok(TARGET_UTILIZATION / utilization)
}

/// Scaled and rounded forces.
pub fn scale_forces(forces: &[[f64; 3]], s: f64) -> Vec<[f64; 3]> {
    forces
        .iter()
        .map(|f| f.map(|c| stagejson::round_sig_toward_zero(c * s, FORCE_DIGITS)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(volume: f64, utilization: f64) -> Candidate {
        Candidate {
            volfrac: volume,
            volume,
            utilization,
        }
    }

    #[test]
    fn chooses_lightest_near_best_efficiency() {
        // v·u: 0.30, 0.25, 0.2, 0.205, 0.30
        let cands = [
            c(0.6, 0.5),
            c(0.5, 0.5),
            c(0.4, 0.5),
            c(0.3, 0.6833),
            c(0.2, 1.5),
        ];
        assert_eq!(choose(&cands, 0.05), Some(3));
        assert_eq!(choose(&cands, 0.0), Some(2));
        assert_eq!(choose(&[c(0.3, f64::NAN)], 0.05), None);
        assert_eq!(choose(&[], 0.05), None);
    }

    #[test]
    fn targets_follow_the_scheme() {
        let t = targets_for(0.3125).unwrap();
        assert_eq!((t.star3, t.star2, t.star1), (0.3625, 0.4625, 0.6125));
        let t = targets_for(0.7).unwrap();
        assert_eq!((t.star3, t.star2, t.star1), (0.75, 0.85, 0.95));
        assert!(targets_for(0.85).is_err());
    }

    #[test]
    fn scaling() {
        assert_eq!(load_scale(0.45).unwrap(), 2.0);
        assert!(load_scale(0.0).is_err());
        let f = scale_forces(&[[0.0, -500.0, 0.0], [12.345, 0.0, -0.0]], 2.46819);
        assert_eq!(f, vec![[0.0, -1234.0, 0.0], [30.46, 0.0, 0.0]]);
        assert_eq!(f[0][0].to_bits(), 0.0f64.to_bits());
    }
}
