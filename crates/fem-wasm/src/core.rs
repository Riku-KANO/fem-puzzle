//! `SessionCore`: everything the JS `Session` does, in plain Rust (no `wasm-bindgen`
//! types), so it can be tested natively. `lib.rs` wraps it 1:1 and only converts errors
//! to `JsError` and the step status to a JS object.

use crate::convert::{check_case, to_f32, to_u32, validate_changes};
use crate::options::{Precond, SessionOptions, parse_options};
use fem::{Mode, Preconditioner, Problem, Solver, SolverOptions};
use stage::Stage;

/// Mirror of `fem::SolveStatus` as exposed to JS (`StepStatus`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StepStatus {
    /// Load case being solved (the last one once `done`).
    pub case: usize,
    /// PCG iterations since the last `begin()`, summed over all load cases.
    pub iterations: usize,
    /// `‖r‖ / ‖f‖` of `case`; once `done`, the maximum over all cases, so
    /// `converged ⇔ done && rel_residual <= tol`.
    pub rel_residual: f64,
    /// Every case converged or stopped (iteration cap, stagnation).
    pub done: bool,
}

pub struct SessionCore {
    solver: Solver,
    options: SessionOptions,
    elements: usize,
    nodes: usize,
    case_names: Vec<String>,
    /// Per-element scratch for `utilization`.
    scratch: Vec<f64>,
}

impl SessionCore {
    /// Parse + validate the stage and options and set up the solver (player mode).
    pub fn new(stage_json: &str, options_json: &str) -> Result<SessionCore, String> {
        let options = parse_options(options_json)?;
        let stage = Stage::from_json(stage_json).map_err(|e| e.to_string())?;
        let [nx, ny, nz] = stage.grid;
        let elements = stage.element_count();
        let nodes = (nx + 1) * (ny + 1) * (nz + 1);
        if u32::try_from(3 * nodes).is_err() {
            return Err(format!("invalid stage: grid {nx}×{ny}×{nz} is too large"));
        }
        let problem = Problem::from_stage(&stage).map_err(|e| e.to_string())?;
        let case_names = problem.cases.iter().map(|c| c.name.clone()).collect();
        let solver = Solver::new(
            problem,
            SolverOptions {
                tol: options.tol,
                max_iters: options.max_iters,
                preconditioner: match options.preconditioner {
                    Precond::Jacobi => Preconditioner::Jacobi,
                    Precond::Multigrid => Preconditioner::Multigrid,
                },
                mode: Mode::Player,
            },
        );
        Ok(SessionCore {
            solver,
            options,
            elements,
            nodes,
            case_names,
            scratch: vec![0.0; elements],
        })
    }

    pub fn options(&self) -> SessionOptions {
        self.options
    }

    pub fn elements(&self) -> usize {
        self.elements
    }

    pub fn nodes(&self) -> usize {
        self.nodes
    }

    /// Multigrid levels in use (0 = Jacobi PCG).
    pub fn levels(&self) -> usize {
        self.solver.levels()
    }

    /// Carve (`solid = false`) or restore (`solid = true`) elements. Idempotent per
    /// element; the whole batch is validated before anything changes. Takes effect at
    /// the next `begin()` (or `iterate`, which begins implicitly when needed).
    pub fn set_solid(&mut self, indices: &[u32], solid: bool) -> Result<(), String> {
        let p = self.solver.problem();
        let changes = validate_changes(indices, solid, &p.domain, &p.keep)?;
        self.solver.set_solid(&changes);
        Ok(())
    }

    /// Recompute the active set / masks / preconditioner and restart the solve from the
    /// previous displacement (warm start).
    pub fn begin(&mut self) {
        self.solver.begin();
    }

    /// Run at most `max_iters` PCG iterations. Calls `begin()` first if the solid set
    /// changed (or nothing was solved yet) since the last `begin()`.
    pub fn iterate(&mut self, max_iters: u32) -> StepStatus {
        let s = self.solver.iterate(max_iters as usize);
        StepStatus {
            case: s.case,
            iterations: s.iterations,
            rel_residual: s.rel_residual,
            done: s.done,
        }
    }

    pub fn case_count(&self) -> usize {
        self.case_names.len()
    }

    pub fn case_name(&self, case: u32) -> Result<&str, String> {
        let c = check_case(case, self.case_count())?;
        Ok(&self.case_names[c])
    }

    /// Per-element von Mises utilisation (0 for inactive elements).
    pub fn utilization(&mut self, case: u32) -> Result<Vec<f32>, String> {
        let c = check_case(case, self.case_count())?;
        self.solver.utilization(c, &mut self.scratch);
        Ok(to_f32(&self.scratch))
    }

    /// Per-node displacement `xyz` (m), length `3 * nodes`.
    pub fn displacement(&self, case: u32) -> Result<Vec<f32>, String> {
        let c = check_case(case, self.case_count())?;
        Ok(to_f32(self.solver.displacement(c)))
    }

    pub fn judged_max_utilization(&self, case: u32) -> Result<f64, String> {
        let c = check_case(case, self.case_count())?;
        Ok(self.solver.judged_max_utilization(c))
    }

    pub fn load_displacement(&self, case: u32) -> Result<f64, String> {
        let c = check_case(case, self.case_count())?;
        Ok(self.solver.load_displacement(c))
    }

    /// Solid elements not connected to any support (as of the last `begin()`).
    pub fn floating(&self) -> Vec<u32> {
        to_u32(&self.solver.floating())
    }

    pub fn loads_connected(&self) -> bool {
        self.solver.loads_connected()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stage::Bitmask;

    const NX: usize = 12;
    const NY: usize = 4;
    const NZ: usize = 2;

    /// 12×4×2 cantilever clamped on x-, pushed down on the top edge of the free end.
    fn cantilever_json() -> String {
        let n = NX * NY * NZ;
        let cells: Vec<[usize; 3]> = (0..NZ).map(|z| [NX - 1, NY - 1, z]).collect();
        serde_json::json!({
            "version": 1, "id": "t-202", "title": "native", "world": 0,
            "grid": [NX, NY, NZ], "voxelSize": 0.01,
            "material": { "E": 70e9, "nu": 0.33, "allowable": 120e6 },
            "solid": Bitmask::from_bools(&vec![true; n]).as_str(),
            "keep": Bitmask::from_bools(&vec![false; n]).as_str(),
            "supports": [{ "face": "x-", "fix": "xyz" }],
            "loads": [{ "cells": cells, "force": [0.0, -2000.0, 0.0] }],
            "targets": { "star1": 0.7, "star2": 0.55, "star3": 0.45 }
        })
        .to_string()
    }

    fn idx([x, y, z]: [usize; 3]) -> u32 {
        (x + NX * (y + NY * z)) as u32
    }

    fn run_to_done(s: &mut SessionCore) -> StepStatus {
        loop {
            let st = s.iterate(16);
            if st.done {
                return st;
            }
        }
    }

    fn solve(s: &mut SessionCore) -> StepStatus {
        s.begin();
        run_to_done(s)
    }

    #[test]
    fn rejects_bad_input() {
        let bad_json = SessionCore::new("{", "").err().unwrap_or_default();
        assert!(bad_json.contains("invalid stage"), "{bad_json}");
        let bad_opts = SessionCore::new(&cantilever_json(), r#"{"tol":2}"#);
        assert!(bad_opts.err().unwrap_or_default().contains("tol"));
        let no_support = cantilever_json().replace(r#"[{"face":"x-","fix":"xyz"}]"#, "[]");
        assert_ne!(no_support, cantilever_json());
        assert!(SessionCore::new(&no_support, "").is_err());
    }

    #[test]
    fn sizes_and_options() {
        let s = SessionCore::new(&cantilever_json(), r#"{"preconditioner":"jacobi"}"#).unwrap();
        assert_eq!(s.elements(), NX * NY * NZ);
        assert_eq!(s.nodes(), (NX + 1) * (NY + 1) * (NZ + 1));
        assert_eq!(s.levels(), 0);
        assert_eq!(s.options().tol, 1e-4);
        assert_eq!(s.options().preconditioner, Precond::Jacobi);
        assert_eq!(s.case_count(), 1);
        assert_eq!(s.case_name(0), Ok("default"));
        assert!(s.case_name(1).is_err());
    }

    #[test]
    fn solves_carves_and_reports() {
        let mut s = SessionCore::new(&cantilever_json(), "").unwrap();
        let cold = solve(&mut s);
        assert!(cold.done && cold.rel_residual <= 1e-4, "{cold:?}");
        assert!(cold.iterations > 0);
        let u = s.utilization(0).unwrap();
        let d = s.displacement(0).unwrap();
        assert_eq!(u.len(), s.elements());
        assert_eq!(d.len(), 3 * s.nodes());
        assert!(u.iter().chain(&d).all(|v| v.is_finite()));
        let max_u = s.judged_max_utilization(0).unwrap();
        assert!(max_u > 0.0 && max_u.is_finite());
        assert!(s.load_displacement(0).unwrap() > 0.0);
        // the free top corner node (NX, NY, 0) moves down
        let tip = NX + (NX + 1) * NY;
        assert!(d[3 * tip + 1] < 0.0);
        assert!(s.floating().is_empty() && s.loads_connected());

        // carve two top voxels: the (warm-started) re-solve converges, counters restart
        let patch = [idx([5, 3, 0]), idx([5, 3, 1])];
        s.set_solid(&patch, false).unwrap();
        let first = s.iterate(1);
        assert_eq!(first.iterations, 1, "begin() resets the iteration count");
        let warm = run_to_done(&mut s);
        assert!(warm.done && warm.rel_residual <= 1e-4, "{warm:?}");
        let u = s.utilization(0).unwrap();
        assert!(patch.iter().all(|&e| u[e as usize] == 0.0));

        // restore (twice: idempotent) and iterate without begin(): begins implicitly
        s.set_solid(&patch, true).unwrap();
        s.set_solid(&patch, true).unwrap();
        let again = run_to_done(&mut s);
        assert!(again.rel_residual <= 1e-4);
        assert!(s.utilization(0).unwrap()[patch[0] as usize] > 0.0);

        // cut through the beam: load disconnected, the tip part floats, no NaN
        let slab: Vec<u32> = (0..NZ)
            .flat_map(|z| (0..NY).map(move |y| idx([6, y, z])))
            .collect();
        s.set_solid(&slab, false).unwrap();
        let cut = solve(&mut s);
        assert!(cut.done);
        assert!(!s.loads_connected());
        assert_eq!(s.floating().len(), (NX - 7) * NY * NZ);
        let u = s.utilization(0).unwrap();
        let d = s.displacement(0).unwrap();
        assert!(u.iter().chain(&d).all(|v| v.is_finite()));
        assert!(s.judged_max_utilization(0).unwrap().is_finite());
    }

    #[test]
    fn set_solid_validation_is_atomic() {
        let mut s = SessionCore::new(&cantilever_json(), "").unwrap();
        let n = s.elements() as u32;
        let carvable = idx([5, 3, 0]);
        assert!(s.set_solid(&[carvable, n], false).is_err());
        // the valid index of the rejected batch was not applied
        solve(&mut s);
        assert!(s.utilization(0).unwrap()[carvable as usize] > 0.0);
        let load_cell = idx([NX - 1, NY - 1, 0]);
        let err = s.set_solid(&[load_cell], false).unwrap_err();
        assert!(err.contains("protected"), "{err}");
        assert!(s.utilization(3).is_err());
        assert!(s.displacement(1).is_err());
        assert!(s.judged_max_utilization(1).is_err());
        assert!(s.load_displacement(1).is_err());
    }
}
