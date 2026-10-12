//! SIMP compliance minimisation with a density filter and the OC update.
//!
//! Variables: `x` (design, per element), `ρ = F x` (physical, filtered). Keep cells are
//! forced to `ρ = 1`, non-domain cells to `ρ = 0`; only *free* cells (domain ∖ keep) are
//! design variables. The volume constraint is on the physical field over the whole domain,
//! keep cells included, so `volfrac` means the same thing as the game's volume fraction:
//! `Σ_domain ρ = volfrac · |domain|`.

use crate::filter::DensityFilter;
use crate::layout::Layout;
use crate::oc::{OcParams, oc_update};
use crate::{Result, err};

/// One finite-element analysis of a density field.
pub trait Analysis {
    /// Solve `K(ρ) u = f` for every load case with `E_e = E_min + ρ_e^p (E_0 − E_min)`.
    /// Returns the total compliance and writes `∂C/∂ρ_e` (≤ 0) into `dc`.
    fn analyze(&mut self, rho: &[f64], penal: f64, dc: &mut [f64]) -> Result<AnalysisInfo>;
}

/// What one analysis reports.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnalysisInfo {
    pub compliance: f64,
    /// Linear-solver iterations (all cases), for the log.
    pub iterations: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SimpOptions {
    /// Target volume fraction of the design domain (keep cells included).
    pub volfrac: f64,
    /// SIMP penalty `p`.
    pub penal: f64,
    /// Density-filter radius in voxels.
    pub rmin: f64,
    pub oc: OcParams,
    pub max_iters: usize,
    /// Stop when `max |Δx| < tol_change`.
    pub tol_change: f64,
}

impl Default for SimpOptions {
    fn default() -> Self {
        SimpOptions {
            volfrac: 0.3,
            penal: 3.0,
            rmin: 1.5,
            oc: OcParams::default(),
            max_iters: 200,
            tol_change: 0.01,
        }
    }
}

/// Per-iteration record.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IterInfo {
    pub iter: usize,
    /// Compliance of the design analysed in this iteration.
    pub compliance: f64,
    /// Physical volume fraction of that design.
    pub volume: f64,
    /// `max |Δx|` of the OC step that followed.
    pub change: f64,
    /// Grey-level indicator `Σ 4ρ(1−ρ) / n_free` of the analysed design.
    pub grayness: f64,
    pub solver_iterations: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SimpResult {
    /// Design variables after the last OC step.
    pub x: Vec<f64>,
    /// Physical densities of `x`.
    pub rho: Vec<f64>,
    pub history: Vec<IterInfo>,
    pub converged: bool,
}

/// Precomputed filter and volume bookkeeping for one layout and radius.
pub struct Simp<'a> {
    layout: &'a Layout,
    filter: DensityFilter,
    free: Vec<bool>,
    /// `∂V/∂x_j` (filter transpose of the free indicator).
    dv: Vec<f64>,
    n_free: usize,
}

impl<'a> Simp<'a> {
    pub fn new(layout: &'a Layout, rmin: f64) -> Result<Simp<'a>> {
        layout.validate()?;
        let n = layout.n();
        let filter = DensityFilter::new(layout.dims, rmin, &layout.domain);
        let free: Vec<bool> = (0..n).map(|e| layout.is_free(e)).collect();
        let n_free = free.iter().filter(|&&f| f).count();
        let indicator: Vec<f64> = free.iter().map(|&f| if f { 1.0 } else { 0.0 }).collect();
        let mut dv = vec![0.0; n];
        filter.apply_transpose(&indicator, &mut dv);
        Ok(Simp {
            layout,
            filter,
            free,
            dv,
            n_free,
        })
    }

    pub fn layout(&self) -> &Layout {
        self.layout
    }

    /// Feasible volume-fraction range `(keep only, whole domain)`.
    pub fn volfrac_range(&self) -> (f64, f64) {
        let nd = self.layout.domain_count() as f64;
        (self.layout.keep_count() as f64 / nd, 1.0)
    }

    /// Physical densities: filtered, keep = 1, outside the domain = 0.
    pub fn physical(&self, x: &[f64], rho: &mut [f64]) {
        self.filter.apply(x, rho);
        for (e, r) in rho.iter_mut().enumerate() {
            if self.layout.keep[e] {
                *r = 1.0;
            } else if !self.layout.domain[e] {
                *r = 0.0;
            }
        }
    }

    /// Uniform starting design with the requested volume.
    pub fn initial_design(&self, volfrac: f64) -> Vec<f64> {
        let l = self.layout;
        let nd = l.domain_count() as f64;
        let nk = l.keep_count() as f64;
        let v = if self.n_free > 0 {
            ((volfrac * nd - nk) / self.n_free as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (0..l.n())
            .map(|e| {
                if l.keep[e] {
                    1.0
                } else if self.free[e] {
                    v
                } else {
                    0.0
                }
            })
            .collect()
    }

    /// Run SIMP from `x0` (or the uniform design). `on_iter` sees every iteration.
    pub fn run(
        &self,
        analysis: &mut dyn Analysis,
        opts: &SimpOptions,
        x0: Option<&[f64]>,
        on_iter: &mut dyn FnMut(&IterInfo),
    ) -> Result<SimpResult> {
        let l = self.layout;
        let n = l.n();
        let (vmin, vmax) = self.volfrac_range();
        if !(opts.volfrac > vmin && opts.volfrac <= vmax) {
            return err(format!(
                "volfrac {} outside the feasible range ({vmin:.3}, {vmax}]",
                opts.volfrac
            ));
        }
        let nd = l.domain_count() as f64;
        let target = opts.volfrac * nd;
        // V(x) = Σ_free dv_j x_j + Σ_keep dv_j + |keep|
        let fixed: f64 = (0..n)
            .filter(|&e| l.keep[e])
            .map(|e| self.dv[e])
            .sum::<f64>()
            + l.keep_count() as f64;
        let free_target = target - fixed;

        let mut x = match x0 {
            Some(x0) if x0.len() == n => x0.to_vec(),
            Some(_) => return err("initial design has the wrong length"),
            None => self.initial_design(opts.volfrac),
        };
        let mut rho = vec![0.0; n];
        let mut dc = vec![0.0; n];
        let mut dcx = vec![0.0; n];
        let mut xnew = vec![0.0; n];
        let mut history = Vec::new();
        let mut converged = false;
        self.physical(&x, &mut rho);
        for iter in 1..=opts.max_iters {
            let info = analysis.analyze(&rho, opts.penal, &mut dc)?;
            if !info.compliance.is_finite() {
                return err(format!("non-finite compliance at iteration {iter}"));
            }
            for (d, &f) in dc.iter_mut().zip(&self.free) {
                if !f {
                    *d = 0.0;
                }
            }
            self.filter.apply_transpose(&dc, &mut dcx);
            let volume = (0..n).filter(|&e| l.domain[e]).map(|e| rho[e]).sum::<f64>() / nd;
            let grayness = (0..n)
                .filter(|&e| self.free[e])
                .map(|e| 4.0 * rho[e] * (1.0 - rho[e]))
                .sum::<f64>()
                / self.n_free.max(1) as f64;
            let step = oc_update(
                &x,
                &dcx,
                &self.dv,
                &self.free,
                free_target,
                opts.oc,
                &mut xnew,
            );
            std::mem::swap(&mut x, &mut xnew);
            self.physical(&x, &mut rho);
            let rec = IterInfo {
                iter,
                compliance: info.compliance,
                volume,
                change: step.change,
                grayness,
                solver_iterations: info.iterations,
            };
            on_iter(&rec);
            history.push(rec);
            if step.change < opts.tol_change {
                converged = true;
                break;
            }
        }
        Ok(SimpResult {
            x,
            rho,
            history,
            converged,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Dims;

    /// Separable stand-in for FE: `C = Σ a_e / ρ_e^p` (springs in series).
    struct Separable {
        a: Vec<f64>,
    }

    impl Analysis for Separable {
        fn analyze(&mut self, rho: &[f64], p: f64, dc: &mut [f64]) -> Result<AnalysisInfo> {
            let mut c = 0.0;
            for e in 0..rho.len() {
                if self.a[e] > 0.0 {
                    let r = rho[e].max(1e-3);
                    c += self.a[e] / r.powf(p);
                    dc[e] = -p * self.a[e] / r.powf(p + 1.0);
                } else {
                    dc[e] = 0.0;
                }
            }
            Ok(AnalysisInfo {
                compliance: c,
                iterations: 0,
            })
        }
    }

    fn layout() -> Layout {
        let dims = Dims::new(8, 4, 2);
        let n = dims.len();
        let mut domain = vec![true; n];
        domain[dims.index(7, 3, 1)] = false;
        let mut keep = vec![false; n];
        keep[dims.index(7, 0, 0)] = true;
        let mut supported = vec![false; n];
        supported[dims.index(0, 0, 0)] = true;
        Layout {
            dims,
            domain,
            keep,
            supported,
            load_cells: vec![dims.index(7, 0, 0)],
            block: vec![false; n],
        }
    }

    #[test]
    fn meets_volume_and_decreases_objective() {
        let l = layout();
        let simp = Simp::new(&l, 1.5).unwrap();
        let mut an = Separable {
            a: (0..l.n())
                .map(|e| {
                    if l.domain[e] {
                        1.0 + (e % 5) as f64
                    } else {
                        0.0
                    }
                })
                .collect(),
        };
        let opts = SimpOptions {
            volfrac: 0.4,
            penal: 1.0,
            max_iters: 100,
            tol_change: 1e-4,
            ..SimpOptions::default()
        };
        let res = simp.run(&mut an, &opts, None, &mut |_| {}).unwrap();
        let h = &res.history;
        assert!(h.last().unwrap().compliance < h[0].compliance);
        // after the first OC step the physical volume equals the target
        for r in &h[1..] {
            assert!((r.volume - 0.4).abs() < 1e-3, "volume {}", r.volume);
        }
        let nd = l.domain_count() as f64;
        let v: f64 = (0..l.n())
            .filter(|&e| l.domain[e])
            .map(|e| res.rho[e])
            .sum();
        assert!((v / nd - 0.4).abs() < 1e-3);
        assert_eq!(res.rho[l.dims.index(7, 0, 0)], 1.0);
        assert_eq!(res.rho[l.dims.index(7, 3, 1)], 0.0);
        assert!(res.rho.iter().all(|r| (0.0..=1.0).contains(r)));
    }

    #[test]
    fn rejects_infeasible_volfrac() {
        let l = layout();
        let simp = Simp::new(&l, 1.5).unwrap();
        let mut an = Separable {
            a: vec![1.0; l.n()],
        };
        let opts = SimpOptions {
            volfrac: 0.0,
            ..SimpOptions::default()
        };
        assert!(simp.run(&mut an, &opts, None, &mut |_| {}).is_err());
    }
}
