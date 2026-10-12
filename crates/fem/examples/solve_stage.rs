//! Solve stage files and print the judged results.
//!
//! `cargo run -p fem --release --example solve_stage -- stages/*.json [--tol 1e-4]`

use fem::{Problem, Solver, SolverOptions};
use std::time::Instant;

fn main() {
    let mut tol = 1e-4;
    let mut paths = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--tol" {
            tol = args
                .next()
                .and_then(|t| t.parse().ok())
                .unwrap_or_else(|| fail("--tol needs a number"));
        } else {
            paths.push(a);
        }
    }
    if paths.is_empty() {
        fail("usage: solve_stage <stage.json>… [--tol 1e-4]");
    }
    for path in paths {
        let json = std::fs::read_to_string(&path).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
        let stage =
            stage::Stage::from_json(&json).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
        let problem = Problem::from_stage(&stage).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
        let g = problem.grid;
        let fixed = problem.fixed.iter().filter(|&&f| f).count();
        let mut solver = Solver::new(
            problem,
            SolverOptions {
                tol,
                ..SolverOptions::default()
            },
        );
        let t = Instant::now();
        let st = solver.solve();
        let ms = t.elapsed().as_secs_f64() * 1e3;
        println!(
            "{} {}x{}x{} h={} fixed DOFs={} → {} iterations, {:.1} ms, rel {:.1e}, converged {}, floating {}, loads connected {}",
            stage.id,
            g.nx,
            g.ny,
            g.nz,
            g.h,
            fixed,
            st.iterations,
            ms,
            st.rel_residual,
            solver.converged(),
            solver.floating().len(),
            solver.loads_connected()
        );
        for (c, case) in solver.problem().cases.iter().enumerate() {
            println!(
                "  case {:?}: judged max utilisation {:.3}, load displacement {:.3e} m, compliance {:.3e} J",
                case.name,
                solver.judged_max_utilization(c),
                solver.load_displacement(c),
                solver.compliance(c)
            );
        }
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2)
}
