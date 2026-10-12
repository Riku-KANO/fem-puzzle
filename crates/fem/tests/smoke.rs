//! End-to-end smoke test of the public API.

mod common;

use fem::{Problem, Solver, SolverOptions};

#[test]
fn small_cantilever_converges_and_bends_down() {
    let stage = common::cantilever([8, 2, 2], 100.0);
    let problem = Problem::from_stage(&stage).unwrap();
    let mut solver = Solver::new(problem, SolverOptions::default());
    let status = solver.solve();
    assert!(status.done && solver.converged(), "{status:?}");
    assert!(status.rel_residual <= 1e-6);
    let g = solver.problem().grid;
    let tip = g.node_index(8, 1, 1);
    let u = solver.displacement(0);
    assert!(u[3 * tip + 1] < 0.0);
    assert!(u.iter().all(|v| v.is_finite()));
    assert!(solver.compliance(0) > 0.0);
    assert!(solver.load_displacement(0) > 0.0);
    let mut util = vec![0.0; g.elements()];
    solver.utilization(0, &mut util);
    assert!(util.iter().all(|v| v.is_finite() && *v >= 0.0));
    assert!(solver.judged_max_utilization(0) > 0.0);
    assert!(solver.loads_connected());
    assert!(solver.floating().is_empty());
}
