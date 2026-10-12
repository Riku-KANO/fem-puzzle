//! Multigrid preconditioner (task T-201) through the public `Solver` API: hierarchy on
//! every stage grid, Jacobi equivalence on multi-level hierarchies (solver.md test 4),
//! iteration savings, warm re-solves, resumable iteration and SIMP contrast.

mod common;

use fem::{Mode, Preconditioner, Problem, Solver, SolverOptions};

fn opts(preconditioner: Preconditioner, tol: f64) -> SolverOptions {
    SolverOptions {
        tol,
        preconditioner,
        ..SolverOptions::default()
    }
}

fn rel_diff(a: &[f64], b: &[f64]) -> f64 {
    let d: f64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| (x - y).powi(2))
        .sum::<f64>()
        .sqrt();
    let n: f64 = b.iter().map(|x| x * x).sum::<f64>().sqrt();
    d / n
}

/// Deterministic pseudo-random number in [0, 1).
fn rand01(seed: &mut u64) -> f64 {
    *seed = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    (*seed >> 11) as f64 / (1u64 << 53) as f64
}

/// Remove each element of the 40×12×12-style cantilever with probability `1 − keep`,
/// except the clamped layer and the loaded tip layer.
fn random_carve(p: &Problem, keep: f64, seed: u64) -> Vec<(usize, bool)> {
    let g = p.grid;
    let mut s = seed;
    (0..g.elements())
        .filter(|&e| {
            let x = g.element_coords(e)[0];
            let r = rand01(&mut s);
            x != 0 && x != g.nx - 1 && r >= keep
        })
        .map(|e| (e, false))
        .collect()
}

/// `Solver::solve` that must converge; returns (iterations, displacement).
fn solve(s: &mut Solver) -> (usize, Vec<f64>) {
    let st = s.solve();
    assert!(s.converged(), "{st:?}");
    (st.iterations, s.displacement(0).to_vec())
}

#[test]
fn hierarchy_and_convergence_on_every_stage_grid() {
    for (dims, levels) in [
        ([24, 8, 4], 2),
        ([32, 8, 8], 2),
        ([32, 12, 12], 3),
        ([40, 12, 12], 3),
        ([60, 20, 20], 3),
    ] {
        let p = Problem::from_stage(&common::tip_edge_cantilever(dims, 1000.0)).unwrap();
        let mut s = Solver::new(p, opts(Preconditioner::Multigrid, 1e-6));
        let (it, u) = solve(&mut s);
        assert_eq!(s.levels(), levels, "{dims:?}");
        assert!(it <= 25, "{dims:?}: {it} iterations");
        assert!(u.iter().all(|v| v.is_finite()));
    }
}

/// solver.md validation 4 on hierarchies with ≥ 2 levels (the 16×4×4 case in
/// `validation.rs` is small enough for a single-level direct solve).
#[test]
fn jacobi_and_multigrid_agree_on_multilevel_grids() {
    for dims in [[32, 8, 8], [24, 8, 4]] {
        let p = Problem::from_stage(&common::tip_edge_cantilever(dims, 1000.0)).unwrap();
        let carve = random_carve(&p, 0.7, 5);
        let run = |pc| {
            let mut s = Solver::new(p.clone(), opts(pc, 1e-10));
            s.set_solid(&carve);
            let (_, u) = solve(&mut s);
            assert!(s.loads_connected());
            (u, s.levels())
        };
        let (uj, lj) = run(Preconditioner::Jacobi);
        let (um, lm) = run(Preconditioner::Multigrid);
        assert_eq!(lj, 0);
        assert_eq!(lm, 2);
        let d = rel_diff(&um, &uj);
        assert!(d < 1e-7, "{dims:?}: relative difference {d}");
    }
}

/// Acceptance: on 40×12×12, cold MGCG needs ≥ 5× fewer iterations than Jacobi-PCG, for the
/// solid block and for a randomly carved (≈ 50 %, still loaded) design.
#[test]
fn multigrid_needs_5x_fewer_iterations_than_jacobi_on_40x12x12() {
    let p = Problem::from_stage(&common::tip_edge_cantilever([40, 12, 12], 1000.0)).unwrap();
    let carve = random_carve(&p, 0.5, 1);
    for (name, changes) in [("solid", Vec::new()), ("carved", carve)] {
        let run = |pc| {
            let mut s = Solver::new(p.clone(), opts(pc, 1e-6));
            s.set_solid(&changes);
            let (it, u) = solve(&mut s);
            assert!(s.loads_connected(), "{name}");
            let solid = s.active().iter().filter(|&&a| a).count();
            (it, u, solid)
        };
        let (it_j, uj, n_active) = run(Preconditioner::Jacobi);
        let (it_m, um, _) = run(Preconditioner::Multigrid);
        eprintln!("{name}: {n_active} active elements, Jacobi {it_j} it, multigrid {it_m} it");
        if name == "carved" {
            let frac = n_active as f64 / p.grid.elements() as f64;
            assert!((0.35..0.65).contains(&frac), "active fraction {frac}");
        }
        assert!(
            it_j >= 5 * it_m,
            "{name}: Jacobi {it_j} vs multigrid {it_m}"
        );
        assert!(rel_diff(&um, &uj) < 1e-5, "{name}");
    }
}

/// Warm re-solve after a 3×3 carve converges quickly and is never slower than a cold
/// solve of the carved design.
#[test]
fn warm_resolve_after_3x3_carve() {
    let p = Problem::from_stage(&common::tip_edge_cantilever([40, 12, 12], 1000.0)).unwrap();
    let g = p.grid;
    let (cx, cz) = (g.nx / 2, g.nz / 2);
    let patch: Vec<(usize, bool)> = (cx - 1..=cx + 1)
        .flat_map(|x| (cz - 1..=cz + 1).map(move |z| (g.element_index(x, g.ny - 1, z), false)))
        .collect();
    let o = opts(Preconditioner::Multigrid, 1e-4);
    let mut warm = Solver::new(p.clone(), o);
    let (it_first, _) = solve(&mut warm);
    warm.set_solid(&patch);
    let (it_warm, uw) = solve(&mut warm);
    let mut cold = Solver::new(p, o);
    cold.set_solid(&patch);
    let (it_cold, uc) = solve(&mut cold);
    eprintln!("first {it_first}, warm {it_warm}, cold carved {it_cold}");
    assert!(it_warm <= it_cold);
    assert!(it_warm <= 15, "{it_warm}");
    assert!(rel_diff(&uw, &uc) < 1e-3);
}

/// `iterate(n)` in chunks reproduces `solve` exactly with the multigrid preconditioner.
#[test]
fn chunked_multigrid_iteration_is_resumable_and_identical() {
    let p = Problem::from_stage(&common::tip_edge_cantilever([24, 8, 4], 1000.0)).unwrap();
    let o = opts(Preconditioner::Multigrid, 1e-8);
    let mut a = Solver::new(p.clone(), o);
    let (it, ua) = solve(&mut a);
    let mut b = Solver::new(p, o);
    b.begin();
    let mut calls = 0;
    let st = loop {
        let st = b.iterate(2);
        calls += 1;
        if st.done {
            break st;
        }
    };
    assert!(calls > 2);
    assert_eq!(st.iterations, it);
    assert_eq!(b.displacement(0), &ua[..]);
}

/// Optimiser mode: SIMP densities with `E_min = 1e-9 E₀` contrast; multigrid converges
/// fast and agrees with Jacobi.
#[test]
fn simp_densities_with_high_contrast() {
    let p = Problem::from_stage(&common::tip_edge_cantilever([32, 8, 8], 1000.0)).unwrap();
    let n = p.grid.elements();
    let mut seed = 3;
    for design in 0..2 {
        let rho: Vec<f64> = (0..n)
            .map(|_| {
                let r = rand01(&mut seed);
                if design == 0 {
                    r
                } else if r < 0.5 {
                    0.0
                } else {
                    1.0
                }
            })
            .collect();
        let run = |pc| {
            let mut s = Solver::new(
                p.clone(),
                SolverOptions {
                    tol: 1e-8,
                    preconditioner: pc,
                    mode: Mode::Optimizer,
                    max_iters: 50_000,
                },
            );
            s.set_density(&rho, 3.0);
            solve(&mut s)
        };
        let (it_j, uj) = run(Preconditioner::Jacobi);
        let (it_m, um) = run(Preconditioner::Multigrid);
        eprintln!("design {design}: Jacobi {it_j} it, multigrid {it_m} it");
        assert!(it_m * 5 <= it_j, "design {design}: {it_m} vs {it_j}");
        assert!(rel_diff(&um, &uj) < 1e-5, "design {design}");
    }
}
