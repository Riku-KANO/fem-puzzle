//! The FEM-backed parts: SIMP analysis in optimiser mode, player-mode judging of 0/1
//! designs, the volfrac sweep and the per-stage calibration.

use crate::calibrate::{self, Candidate};
use crate::design::{self, Design};
use crate::layout::{Dims, Layout};
use crate::simp::{Analysis, AnalysisInfo, IterInfo, Simp, SimpOptions};
use crate::{Error, Result, err, stagejson};
use fem::solver::E_MIN_RATIO;
use fem::{Mode, Preconditioner, Problem, Solver, SolverOptions};
use stage::Stage;
use std::time::Instant;

/// Linear-solver tolerance inside the SIMP loop.
pub const SIMP_TOL: f64 = 1e-6;
/// Linear-solver tolerance when judging candidate designs of the sweep.
pub const JUDGE_TOL: f64 = 1e-6;
/// Linear-solver tolerance for the stored `benchmark.maxUtilization` and its
/// re-verification: tight, so the value does not depend on the preconditioner or on
/// iteration counts (only on the discretisation).
pub const VERIFY_TOL: f64 = 1e-8;
/// Relative tolerance between a re-computed and the stored `maxUtilization`. The stored
/// value is rounded to 4 decimals (≤ 6e-5 relative at 0.9); a real change of the numerics
/// (element, stress recovery, loads) moves it by far more than 1e-3.
pub const VERIFY_REL_TOL: f64 = 1e-3;

/// A stage with everything derived from it.
pub struct Model {
    pub stage: Stage,
    pub problem: Problem,
    pub layout: Layout,
}

impl Model {
    pub fn from_stage(stage: Stage) -> Result<Model> {
        let problem = Problem::from_stage(&stage).map_err(|e| Error(e.to_string()))?;
        let g = problem.grid;
        let n = g.elements();
        let block = match &stage.block {
            Some(b) => b.to_bools(n)?,
            None => vec![false; n],
        };
        let mut load_cells: Vec<usize> = problem
            .cases
            .iter()
            .flat_map(|c| c.load_cells.iter().copied())
            .collect();
        load_cells.sort_unstable();
        load_cells.dedup();
        let layout = Layout {
            dims: Dims::new(g.nx, g.ny, g.nz),
            domain: problem.domain.clone(),
            keep: problem.keep.clone(),
            supported: problem.supported.clone(),
            load_cells,
            block,
        };
        layout.validate()?;
        Ok(Model {
            stage,
            problem,
            layout,
        })
    }

    pub fn from_json(text: &str) -> Result<Model> {
        Model::from_stage(Stage::from_json(text)?)
    }
}

/// SIMP analysis through `fem::Solver` in optimiser mode (warm-started across iterations).
pub struct FemAnalysis {
    solver: Solver,
    energy: Vec<f64>,
    e0: f64,
}

impl FemAnalysis {
    pub fn new(problem: Problem, tol: f64) -> FemAnalysis {
        let n = problem.grid.elements();
        let e0 = problem.material.e;
        let opts = SolverOptions {
            tol,
            mode: Mode::Optimizer,
            preconditioner: Preconditioner::Multigrid,
            ..SolverOptions::default()
        };
        FemAnalysis {
            solver: Solver::new(problem, opts),
            energy: vec![0.0; n],
            e0,
        }
    }
}

impl Analysis for FemAnalysis {
    fn analyze(&mut self, rho: &[f64], penal: f64, dc: &mut [f64]) -> Result<AnalysisInfo> {
        self.solver.set_density(rho, penal);
        let status = self.solver.solve();
        if !self.solver.converged() {
            eprintln!(
                "  warning: optimiser solve stopped at rel. residual {:.2e}",
                status.rel_residual
            );
        }
        let ncases = self.solver.problem().cases.len();
        let de = (1.0 - E_MIN_RATIO) * self.e0;
        dc.iter_mut().for_each(|d| *d = 0.0);
        let mut c = 0.0;
        for case in 0..ncases {
            c += self.solver.compliance(case);
            self.solver.element_energy(case, &mut self.energy);
            for ((d, &en), &r) in dc.iter_mut().zip(&self.energy).zip(rho) {
                *d -= penal * r.clamp(0.0, 1.0).powf(penal - 1.0) * de * en;
            }
        }
        Ok(AnalysisInfo {
            compliance: c,
            iterations: status.iterations,
        })
    }
}

/// Player-mode verdict on a 0/1 design.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Judgement {
    /// Max over load cases of the judged max utilisation.
    pub max_utilization: f64,
    pub loads_connected: bool,
    pub floating: usize,
    pub converged: bool,
    pub iterations: usize,
}

/// Judges 0/1 designs with the player-mode solver (warm-started between designs).
pub struct Judge {
    solver: Solver,
}

impl Judge {
    pub fn new(problem: Problem, tol: f64) -> Judge {
        let opts = SolverOptions {
            tol,
            mode: Mode::Player,
            preconditioner: Preconditioner::Multigrid,
            ..SolverOptions::default()
        };
        Judge {
            solver: Solver::new(problem, opts),
        }
    }

    pub fn evaluate(&mut self, solid: &[bool]) -> Result<Judgement> {
        let cur = self.solver.solid();
        if solid.len() != cur.len() {
            return err("design has the wrong length");
        }
        let changes: Vec<(usize, bool)> = (0..solid.len())
            .filter(|&e| cur[e] != solid[e])
            .map(|e| (e, solid[e]))
            .collect();
        self.solver.set_solid(&changes);
        let status = self.solver.solve();
        let ncases = self.solver.problem().cases.len();
        let max_utilization = (0..ncases)
            .map(|c| self.solver.judged_max_utilization(c))
            .fold(0.0, f64::max);
        if !max_utilization.is_finite() {
            return err("non-finite utilisation");
        }
        Ok(Judgement {
            max_utilization,
            loads_connected: self.solver.loads_connected(),
            floating: self.solver.floating().len(),
            converged: self.solver.converged(),
            iterations: status.iterations,
        })
    }
}

/// Judge one design with a fresh solver.
pub fn judge(problem: &Problem, solid: &[bool], tol: f64) -> Result<Judgement> {
    Judge::new(problem.clone(), tol).evaluate(solid)
}

/// One SIMP run plus its thresholded design.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub volfrac: f64,
    pub x: Vec<f64>,
    pub rho: Vec<f64>,
    pub history: Vec<IterInfo>,
    pub converged: bool,
    pub design: Design,
    pub judgement: Judgement,
    pub seconds: f64,
}

impl RunOutcome {
    pub fn candidate(&self) -> Candidate {
        Candidate {
            volfrac: self.volfrac,
            volume: self.design.volume,
            utilization: self.judgement.max_utilization,
        }
    }

    pub fn final_compliance(&self) -> f64 {
        self.history.last().map_or(f64::NAN, |h| h.compliance)
    }
}

/// Run SIMP at `opts.volfrac` (from `x0` if given), threshold to the same volume and judge.
pub fn run_one(
    model: &Model,
    simp: &Simp,
    analysis: &mut FemAnalysis,
    judge: &mut Judge,
    opts: &SimpOptions,
    x0: Option<&[f64]>,
    on_iter: &mut dyn FnMut(&IterInfo),
) -> Result<RunOutcome> {
    let t = Instant::now();
    let res = simp.run(analysis, opts, x0, on_iter)?;
    let target = (opts.volfrac * model.layout.domain_count() as f64).round() as usize;
    let design = design::threshold(&model.layout, &res.rho, target)?;
    let judgement = judge.evaluate(&design.solid)?;
    if !judgement.loads_connected {
        return err("thresholded design leaves a load unsupported (bug)");
    }
    Ok(RunOutcome {
        volfrac: opts.volfrac,
        x: res.x,
        rho: res.rho,
        history: res.history,
        converged: res.converged,
        design,
        judgement,
        seconds: t.elapsed().as_secs_f64(),
    })
}

/// Settings of a calibration.
#[derive(Debug, Clone)]
pub struct CalibrationSettings {
    /// Sweep, heavy → light (each run starts from the previous design).
    pub volfracs: Vec<f64>,
    pub simp: SimpOptions,
    pub efficiency_tol: f64,
}

/// Everything a full calibration computed.
#[derive(Debug, Clone)]
pub struct Calibration {
    pub sweep: Vec<RunOutcome>,
    pub chosen: usize,
    /// Load scale applied (before rounding the forces).
    pub scale: f64,
    pub forces: Vec<[f64; 3]>,
    pub targets: stage::Targets,
    pub benchmark: stage::Benchmark,
    /// Full initial block under the calibrated loads.
    pub full_block: Judgement,
}

/// The volfrac sweep (`on_run` sees each finished run).
pub fn sweep(
    model: &Model,
    settings: &CalibrationSettings,
    on_run: &mut dyn FnMut(&RunOutcome),
) -> Result<Vec<RunOutcome>> {
    let simp = Simp::new(&model.layout, settings.simp.rmin)?;
    let mut analysis = FemAnalysis::new(model.problem.clone(), SIMP_TOL);
    let mut judge = Judge::new(model.problem.clone(), JUDGE_TOL);
    let (vlo, _) = simp.volfrac_range();
    let mut out: Vec<RunOutcome> = Vec::new();
    for &v in &settings.volfracs {
        if v <= vlo + 1e-9 {
            continue;
        }
        let opts = SimpOptions {
            volfrac: v,
            ..settings.simp
        };
        let x0 = out.last().map(|r| r.x.as_slice());
        let run = run_one(
            model,
            &simp,
            &mut analysis,
            &mut judge,
            &opts,
            x0,
            &mut |_| {},
        )?;
        on_run(&run);
        out.push(run);
    }
    if out.is_empty() {
        return err("no feasible volume fraction in the sweep");
    }
    Ok(out)
}

/// Full calibration of `model` (whose current loads only set directions/ratios).
/// `value` is the stage JSON; the calibrated fields are written into it.
pub fn calibrate(
    model: &Model,
    value: &mut serde_json::Value,
    settings: &CalibrationSettings,
    on_run: &mut dyn FnMut(&RunOutcome),
) -> Result<Calibration> {
    let sweep = sweep(model, settings, on_run)?;
    let cands: Vec<Candidate> = sweep.iter().map(RunOutcome::candidate).collect();
    let chosen = calibrate::choose(&cands, settings.efficiency_tol)
        .ok_or_else(|| Error("no usable design in the sweep".into()))?;
    let best = &sweep[chosen];
    let scale = calibrate::load_scale(best.judgement.max_utilization)?;
    let forces = calibrate::scale_forces(&stagejson::forces(value)?, scale);
    stagejson::set_forces(value, &forces)?;

    // Re-judge with the rounded forces through a fresh parse (exactly what the game sees).
    let scaled = Model::from_json(&stagejson::to_text(value))?;
    let bench = judge(&scaled.problem, &best.design.solid, VERIFY_TOL)?;
    let full_block = judge(&scaled.problem, &scaled.layout.domain, VERIFY_TOL)?;
    let volume = best.design.count as f64 / model.layout.domain_count() as f64;
    let targets = calibrate::targets_for(volume)?;
    let benchmark = stage::Benchmark {
        volume,
        solid: stage::Bitmask::from_bools(&best.design.solid),
        max_utilization: Some(stagejson::round_decimals(
            bench.max_utilization,
            calibrate::DECIMALS,
        )),
        method: Some(calibrate::METHOD.into()),
    };
    stagejson::set_targets(value, &targets)?;
    stagejson::set_benchmark(value, &benchmark)?;
    // The result must be a valid stage.
    Stage::from_json(&stagejson::to_text(value))?;
    Ok(Calibration {
        sweep,
        chosen,
        scale,
        forces,
        targets,
        benchmark,
        full_block,
    })
}

/// Re-check a calibrated stage: the stored benchmark is a valid design (keep cells, loads
/// connected, inside the domain), `volume` and `targets` follow from it, and its judged
/// utilisation (solved to [`VERIFY_TOL`]) matches `maxUtilization` within
/// [`VERIFY_REL_TOL`] and passes. Returns the benchmark judgement.
pub fn verify_calibrated(model: &Model) -> Result<Judgement> {
    let s = &model.stage;
    let b = s
        .benchmark
        .as_ref()
        .ok_or_else(|| Error("no benchmark".into()))?;
    let n = model.layout.n();
    let solid = b.solid.to_bools(n)?;
    if (0..n).any(|e| solid[e] && !model.layout.domain[e]) {
        return err("benchmark has material outside the design domain");
    }
    if !design::is_valid(&model.layout, &solid) {
        return err("benchmark design breaks the connectivity rules");
    }
    let count = solid.iter().filter(|&&x| x).count();
    let volume = count as f64 / model.layout.domain_count() as f64;
    if volume != b.volume {
        return err(format!("benchmark.volume {} != {volume}", b.volume));
    }
    if calibrate::targets_for(volume)? != s.targets {
        return err("targets do not follow the benchmark volume");
    }
    let stored = b
        .max_utilization
        .ok_or_else(|| Error("benchmark.maxUtilization missing".into()))?;
    let bench = judge(&model.problem, &solid, VERIFY_TOL)?;
    if !bench.converged {
        return err("benchmark solve did not converge");
    }
    if (bench.max_utilization - stored).abs() > VERIFY_REL_TOL * stored.abs() {
        return err(format!(
            "benchmark utilisation {:.6} != stored {stored} (rel. tol {VERIFY_REL_TOL})",
            bench.max_utilization
        ));
    }
    if bench.max_utilization > 1.0 || !bench.loads_connected {
        return err("benchmark design fails the strength rule");
    }
    Ok(bench)
}
