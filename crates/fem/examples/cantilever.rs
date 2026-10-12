//! Solver benchmark on stage-sized cantilevers.
//!
//! `cargo run -p fem --release --example cantilever`
//!
//! For each grid: a solid block clamped on x-, loaded downwards on the top edge of the
//! tip (like a stage). Prints the cold solve (from u = 0) and the warm re-solve after a
//! 3×3 patch on the top surface at mid-span is carved (warm start from the previous u),
//! plus a cold solve of the carved design for reference. A second table compares cold
//! solves of a randomly carved (≈ 50 %) 40×12×12 design and of the 60×20×20 block.
//! Times are best-of-3 wall clock, single thread, native.

use fem::{Preconditioner, Problem, SolveStatus, Solver, SolverOptions};
use stage::{Bitmask, Face, Load, Stage, Support, Targets};
use std::time::Instant;

const GRIDS: [[usize; 3]; 4] = [[24, 8, 4], [32, 8, 8], [32, 12, 12], [40, 12, 12]];
const TOLS: [f64; 2] = [1e-6, 1e-4];
/// Preconditioners to compare (Jacobi baseline vs multigrid).
const PRECONDS: [Preconditioner; 2] = [Preconditioner::Jacobi, Preconditioner::Multigrid];
const REPEATS: usize = 3;

fn cantilever([nx, ny, nz]: [usize; 3]) -> Stage {
    let n = nx * ny * nz;
    Stage {
        version: 1,
        id: "bench-cantilever".into(),
        title: String::new(),
        world: 0,
        grid: [nx, ny, nz],
        voxel_size: 0.01,
        material: stage::Material {
            e: 70e9,
            nu: 0.33,
            allowable: 120e6,
            density: None,
        },
        solid: Bitmask::from_bools(&vec![true; n]),
        keep: Bitmask::from_bools(&vec![false; n]),
        block: None,
        supports: vec![Support {
            face: Face::XNeg,
            fix: "xyz".into(),
            cells: None,
        }],
        loads: vec![Load {
            cells: (0..nz).map(|z| [nx - 1, ny - 1, z]).collect(),
            force: [0.0, -1000.0, 0.0],
        }],
        load_cases: None,
        max_displacement: None,
        targets: Targets {
            star1: 0.8,
            star2: 0.6,
            star3: 0.4,
        },
        benchmark: None,
        hints: vec![],
    }
}

/// Remove each element with probability `1 − keep` (deterministic LCG), except the
/// clamped layer and the loaded tip layer.
fn random_carve(p: &Problem, keep: f64, mut seed: u64) -> Vec<(usize, bool)> {
    let g = p.grid;
    (0..g.elements())
        .filter(|&e| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let r = (seed >> 11) as f64 / (1u64 << 53) as f64;
            let x = g.element_coords(e)[0];
            x != 0 && x != g.nx - 1 && r >= keep
        })
        .map(|e| (e, false))
        .collect()
}

/// 3×3 patch on the top surface around mid-span.
fn patch(p: &Problem) -> Vec<(usize, bool)> {
    let g = p.grid;
    let (cx, cz) = (g.nx / 2, g.nz / 2);
    (cx - 1..=cx + 1)
        .flat_map(|x| (cz - 1..=cz + 1).map(move |z| (g.element_index(x, g.ny - 1, z), false)))
        .collect()
}

/// Best-of-`REPEATS` timing of `f` (fresh state from `setup` each time).
fn timed<S>(
    mut setup: impl FnMut() -> S,
    mut f: impl FnMut(&mut S) -> SolveStatus,
) -> (SolveStatus, f64) {
    let mut best = f64::INFINITY;
    let mut status = None;
    for _ in 0..REPEATS {
        let mut s = setup();
        let t = Instant::now();
        let st = f(&mut s);
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
        status = Some(st);
    }
    (status.expect("REPEATS > 0"), best)
}

fn main() {
    println!(
        "{:<10} {:>6} {:>6} {:>7} {:<9} | {:>10} {:>9} | {:>10} {:>9} | {:>10} {:>9} | {:>7}",
        "grid",
        "elems",
        "dofs",
        "tol",
        "precond",
        "cold it",
        "cold ms",
        "warm it",
        "warm ms",
        "carved it",
        "carved ms",
        "ms/it"
    );
    for dims in GRIDS {
        let problem = Problem::from_stage(&cantilever(dims)).expect("valid stage");
        let carve = patch(&problem);
        let g = problem.grid;
        for tol in TOLS {
            for pc in PRECONDS {
                let opts = SolverOptions {
                    tol,
                    preconditioner: pc,
                    ..SolverOptions::default()
                };
                let new = || Solver::new(problem.clone(), opts);
                let (cold, cold_ms) = timed(new, |s| s.solve());
                let (warm, warm_ms) = timed(
                    || {
                        let mut s = new();
                        s.solve();
                        s.set_solid(&carve);
                        s
                    },
                    |s| s.solve(),
                );
                let (carved, carved_ms) = timed(
                    || {
                        let mut s = new();
                        s.set_solid(&carve);
                        s
                    },
                    |s| s.solve(),
                );
                for st in [cold, warm, carved] {
                    assert!(st.done && st.rel_residual <= tol, "{st:?}");
                }
                println!(
                    "{:<10} {:>6} {:>6} {:>7.0e} {:<9} | {:>10} {:>9.1} | {:>10} {:>9.1} | {:>10} {:>9.1} | {:>7.3}",
                    format!("{}x{}x{}", dims[0], dims[1], dims[2]),
                    g.elements(),
                    g.dofs(),
                    tol,
                    format!("{pc:?}"),
                    cold.iterations,
                    cold_ms,
                    warm.iterations,
                    warm_ms,
                    carved.iterations,
                    carved_ms,
                    cold_ms / cold.iterations as f64,
                );
            }
        }
    }
    println!();
    println!(
        "{:<18} {:>7} | {:>7} {:>9} | {:>7} {:>9} | {:>6} {:>6}",
        "cold solve", "tol", "jac it", "jac ms", "mg it", "mg ms", "it x", "time x"
    );
    let extra: [(&str, [usize; 3], bool); 2] = [
        ("40x12x12 carved50", [40, 12, 12], true),
        ("60x20x20 solid", [60, 20, 20], false),
    ];
    for (name, dims, carved) in extra {
        let problem = Problem::from_stage(&cantilever(dims)).expect("valid stage");
        let carve = if carved {
            random_carve(&problem, 0.5, 1)
        } else {
            Vec::new()
        };
        for tol in TOLS {
            let run = |pc| {
                let opts = SolverOptions {
                    tol,
                    preconditioner: pc,
                    ..SolverOptions::default()
                };
                let (st, ms) = timed(
                    || {
                        let mut s = Solver::new(problem.clone(), opts);
                        s.set_solid(&carve);
                        s
                    },
                    |s| s.solve(),
                );
                assert!(st.done && st.rel_residual <= tol, "{st:?}");
                (st.iterations, ms)
            };
            let (ji, jms) = run(Preconditioner::Jacobi);
            let (mi, mms) = run(Preconditioner::Multigrid);
            println!(
                "{:<18} {:>7.0e} | {:>7} {:>9.1} | {:>7} {:>9.1} | {:>6.1} {:>6.1}",
                name,
                tol,
                ji,
                jms,
                mi,
                mms,
                ji as f64 / mi as f64,
                jms / mms
            );
        }
    }
}
