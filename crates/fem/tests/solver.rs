//! Solver behaviour: player-mode active set, warm start, resumable iteration, load
//! cases, optimiser mode.

mod common;

use common::{clamp, max_abs, stage};
use fem::{Mode, Problem, Solver, SolverOptions};
use stage::{Face, Load, LoadCase, Support};

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

#[test]
fn active_set_follows_face_connectivity_to_supports() {
    // 6×3×1 strip clamped at x-; loads at the far end.
    let s = stage(
        [6, 3, 1],
        &[true; 18],
        vec![clamp(Face::XNeg)],
        vec![Load {
            cells: vec![[5, 0, 0]],
            force: [0.0, -10.0, 0.0],
        }],
    );
    let p = Problem::from_stage(&s).unwrap();
    let g = p.grid;
    let e = |x, y| g.element_index(x, y, 0);
    let mut solver = Solver::new(p, SolverOptions::default());
    assert!(solver.active().iter().all(|&a| a));
    assert!(solver.loads_connected());

    // Cut column x = 3 except its top cell: everything still connected.
    solver.set_solid(&[(e(3, 0), false), (e(3, 1), false)]);
    solver.begin();
    assert!(solver.floating().is_empty());
    assert!(solver.loads_connected());
    assert!(!solver.active()[e(3, 0)]);

    // Also remove the top cell of the column: the part x ≥ 4 floats.
    solver.set_solid(&[(e(3, 2), false)]);
    // Not applied before `begin`.
    assert!(solver.floating().is_empty());
    assert!(!solver.solid()[e(3, 2)]);
    solver.begin();
    let floating: Vec<usize> = (0..18).filter(|&i| g.element_coords(i)[0] >= 4).collect();
    assert_eq!(solver.floating(), floating);
    assert!(!solver.loads_connected());
    for i in 0..18 {
        let x = g.element_coords(i)[0];
        assert_eq!(solver.active()[i], x < 3, "element {i}");
    }

    // Edge contact does not connect: restore (3,0), keep only (2,1) in column x = 2.
    solver.set_solid(&[(e(3, 0), true), (e(2, 0), false), (e(2, 2), false)]);
    solver.begin();
    // (3,0) touches (2,1) only by an edge.
    assert!(!solver.active()[e(3, 0)]);
    assert!(!solver.loads_connected());
    // Restoring (3,1) reconnects through faces.
    solver.set_solid(&[(e(3, 1), true)]);
    solver.begin();
    assert!(solver.floating().is_empty());
    assert!(solver.loads_connected());

    // Indices outside the grid or the domain are ignored.
    solver.set_solid(&[(10_000, false)]);
    assert_eq!(solver.solid().len(), 18);
}

#[test]
fn solver_is_send() {
    fn assert_send<T: Send>() {}
    assert_send::<Solver>();
}

#[test]
fn non_domain_cells_cannot_become_solid() {
    let mut solid = vec![true; 8];
    solid[7] = false;
    let s = stage(
        [4, 2, 1],
        &solid,
        vec![clamp(Face::XNeg)],
        vec![Load {
            cells: vec![[3, 0, 0]],
            force: [0.0, -1.0, 0.0],
        }],
    );
    let mut solver = Solver::new(Problem::from_stage(&s).unwrap(), SolverOptions::default());
    solver.set_solid(&[(7, true)]);
    assert!(!solver.solid()[7]);
    solver.solve();
    assert!(!solver.active()[7]);
}

/// Warm start after a small carve needs no more iterations than a cold solve of the
/// carved design (relaxed criterion for Jacobi, see the T-101 log; "far fewer" is
/// expected from multigrid, T-201).
///
/// Scenario: the geometry of `examples/cantilever.rs` on the perf-gate grid 40×12×12 at the UI / perf
/// gate tolerance `1e-4`: clamped at x-, load on the top tip edge, carve on the top
/// surface at mid-span (one voxel, and a 3×3 patch).
#[test]
fn warm_start_after_small_carve_is_not_slower_than_cold() {
    let dims = [40, 12, 12];
    let p = Problem::from_stage(&common::tip_edge_cantilever(dims, 1000.0)).unwrap();
    let g = p.grid;
    let opts = SolverOptions {
        tol: 1e-4,
        ..SolverOptions::default()
    };
    let (cx, cz) = (g.nx / 2, g.nz / 2);
    let top = |x, z| (g.element_index(x, g.ny - 1, z), false);
    let voxel = vec![top(cx, cz)];
    let patch: Vec<(usize, bool)> = (cx - 1..=cx + 1)
        .flat_map(|x| (cz - 1..=cz + 1).map(move |z| (x, z)))
        .map(|(x, z)| top(x, z))
        .collect();

    for (name, carve) in [("voxel", voxel), ("3x3 patch", patch)] {
        let mut warm_solver = Solver::new(p.clone(), opts);
        warm_solver.solve();
        warm_solver.set_solid(&carve);
        let warm = warm_solver.solve();
        assert!(warm_solver.converged());

        let mut cold_solver = Solver::new(p.clone(), opts);
        cold_solver.set_solid(&carve);
        let cold = cold_solver.solve();
        assert!(cold_solver.converged());
        eprintln!(
            "{name}: warm {} iterations, cold {}",
            warm.iterations, cold.iterations
        );
        assert!(
            warm.iterations <= cold.iterations,
            "{name}: warm {} vs cold {}",
            warm.iterations,
            cold.iterations
        );
        // Same answer (to the solve tolerance).
        assert!(rel_diff(warm_solver.displacement(0), cold_solver.displacement(0)) < 1e-3);
    }
}

/// `iterate(n)` in chunks is exactly the same computation as one `solve`.
#[test]
fn chunked_iteration_is_resumable_and_identical() {
    let s = common::cantilever([12, 4, 2], 500.0);
    let p = Problem::from_stage(&s).unwrap();
    let mut a = Solver::new(p.clone(), SolverOptions::default());
    let sa = a.solve();
    let mut b = Solver::new(p, SolverOptions::default());
    b.begin();
    let mut last = b.status();
    assert_eq!(last.iterations, 0);
    assert!(!last.done);
    let mut calls = 0;
    while !last.done {
        let s = b.iterate(7);
        assert!(s.iterations <= last.iterations + 7);
        assert!(s.rel_residual.is_finite());
        last = s;
        calls += 1;
    }
    assert!(calls > 2);
    assert_eq!(last.iterations, sa.iterations);
    assert_eq!(a.displacement(0), b.displacement(0));
    // Iterating after done is a no-op.
    assert_eq!(b.iterate(5), last);
}

#[test]
fn iterate_without_begin_starts_automatically() {
    let s = common::cantilever([8, 2, 2], 100.0);
    let mut solver = Solver::new(Problem::from_stage(&s).unwrap(), SolverOptions::default());
    let st = loop {
        let st = solver.iterate(1000);
        if st.done {
            break st;
        }
    };
    assert!(solver.converged() && st.rel_residual <= 1e-6);
}

#[test]
fn max_iters_stops_with_done_but_not_converged() {
    let s = common::cantilever([16, 4, 2], 100.0);
    let mut solver = Solver::new(
        Problem::from_stage(&s).unwrap(),
        SolverOptions {
            max_iters: 5,
            ..SolverOptions::default()
        },
    );
    let st = solver.solve();
    assert!(st.done && !solver.converged());
    assert_eq!(st.iterations, 5);
    assert!(st.rel_residual > 1e-6);
}

#[test]
fn unsupported_rigid_modes_terminate() {
    // Only x is fixed on x-: the body can still translate in y/z → singular system.
    let s = stage(
        [6, 2, 2],
        &[true; 24],
        vec![Support {
            face: Face::XNeg,
            fix: "x".into(),
            cells: None,
        }],
        vec![Load {
            cells: vec![[5, 0, 0]],
            force: [0.0, -10.0, 0.0],
        }],
    );
    let mut solver = Solver::new(
        Problem::from_stage(&s).unwrap(),
        SolverOptions {
            max_iters: 2000,
            ..SolverOptions::default()
        },
    );
    let st = solver.solve();
    assert!(st.done);
    assert!(st.iterations <= 2000);
    // A mechanism does not converge; the iterate stays finite (and huge).
    assert!(!solver.converged());
    assert!(solver.displacement(0).iter().all(|v| v.is_finite()));
}

#[test]
fn load_cases_are_solved_in_turn() {
    let mut s = common::cantilever([10, 3, 2], 100.0);
    let down = Load {
        cells: vec![[9, 0, 0], [9, 0, 1]],
        force: [0.0, -300.0, 0.0],
    };
    let side = Load {
        cells: vec![[9, 2, 0]],
        force: [0.0, 0.0, 200.0],
    };
    s.load_cases = Some(vec![
        LoadCase {
            name: "down".into(),
            loads: vec![down.clone()],
        },
        LoadCase {
            name: "side".into(),
            loads: vec![side.clone()],
        },
    ]);
    let p = Problem::from_stage(&s).unwrap();
    assert_eq!(p.cases.len(), 2);
    assert_eq!(p.cases[1].name, "side");
    let mut both = Solver::new(p, SolverOptions::default());
    let mut seen_case_1 = false;
    both.begin();
    loop {
        let st = both.iterate(10);
        seen_case_1 |= st.case == 1;
        if st.done {
            assert_eq!(st.case, 1);
            break;
        }
    }
    assert!(seen_case_1 && both.converged());

    for (i, load) in [down, side].into_iter().enumerate() {
        let mut single = s.clone();
        single.load_cases = None;
        single.loads = vec![load];
        let mut solver = Solver::new(
            Problem::from_stage(&single).unwrap(),
            SolverOptions::default(),
        );
        solver.solve();
        assert!(rel_diff(both.displacement(i), solver.displacement(0)) < 1e-5);
        assert!(
            (both.load_displacement(i) - solver.load_displacement(0)).abs()
                < 1e-5 * solver.load_displacement(0)
        );
    }
}

#[test]
fn judged_utilization_excludes_keep_cells() {
    let s = common::cantilever([10, 3, 2], 5000.0);
    let p = Problem::from_stage(&s).unwrap();
    let g = p.grid;
    let mut solver = Solver::new(p, SolverOptions::default());
    solver.solve();
    let mut util = vec![0.0; g.elements()];
    solver.utilization(0, &mut util);
    let judged = solver.judged_max_utilization(0);
    let expect = (0..g.elements())
        .filter(|&e| !solver.problem().keep[e])
        .map(|e| util[e])
        .fold(0.0, f64::max);
    assert_eq!(judged, expect);
    // The clamped root (not keep: face supports without cells) is the most stressed.
    assert!(judged > 0.0);
    let mut vm = vec![0.0; g.elements()];
    solver.von_mises(0, &mut vm);
    let allowable = solver.problem().material.allowable;
    assert!((0..g.elements()).all(|e| (vm[e] / allowable - util[e]).abs() <= 1e-12 * util[e]));
    // Tip load cells are keep and therefore excluded.
    assert!(solver.problem().keep[g.element_index(9, 1, 1)]);
}

#[test]
fn optimizer_mode_scales_with_density_and_energy_matches_compliance() {
    let s = common::cantilever([12, 4, 2], 400.0);
    let p = Problem::from_stage(&s).unwrap();
    let n = p.grid.elements();
    let e0 = p.material.e;
    let tight = SolverOptions {
        tol: 1e-10,
        mode: Mode::Optimizer,
        ..SolverOptions::default()
    };
    let mut full = Solver::new(p.clone(), tight);
    full.solve();
    let c_full = full.compliance(0);

    let mut half = Solver::new(p, tight);
    let penal = 3.0;
    half.set_density(&vec![0.5; n], penal);
    half.solve();
    assert!(half.converged());
    assert!(half.active().iter().all(|&a| a));
    let e_min = fem::solver::E_MIN_RATIO * e0;
    let e_half = e_min + 0.5f64.powf(penal) * (e0 - e_min);
    let ratio = half.compliance(0) / c_full;
    assert!((ratio - e0 / e_half).abs() < 1e-6 * ratio, "ratio {ratio}");

    // Σ E_e · energy_e = uᵀKu = fᵀu.
    let mut energy = vec![0.0; n];
    half.element_energy(0, &mut energy);
    let total: f64 = energy.iter().map(|w| e_half * w).sum();
    assert!((total - half.compliance(0)).abs() < 1e-8 * total);
}

#[test]
fn optimizer_sensitivity_matches_finite_difference() {
    let s = common::cantilever([8, 3, 2], 400.0);
    let p = Problem::from_stage(&s).unwrap();
    let g = p.grid;
    let n = g.elements();
    let e0 = p.material.e;
    let opts = SolverOptions {
        tol: 1e-12,
        mode: Mode::Optimizer,
        ..SolverOptions::default()
    };
    let penal = 3.0;
    let mut rho: Vec<f64> = (0..n)
        .map(|e| 0.4 + 0.5 * ((e * 7 % 11) as f64 / 10.0))
        .collect();
    let mut solver = Solver::new(p, opts);
    solver.set_density(&rho, penal);
    solver.solve();
    let c0 = solver.compliance(0);
    let mut energy = vec![0.0; n];
    solver.element_energy(0, &mut energy);
    let e_min = fem::solver::E_MIN_RATIO * e0;
    for e in [0, g.element_index(3, 1, 0), g.element_index(7, 2, 1)] {
        let dc = -penal * rho[e].powf(penal - 1.0) * (e0 - e_min) * energy[e];
        let step = 1e-5;
        rho[e] += step;
        solver.set_density(&rho, penal);
        solver.solve();
        let fd = (solver.compliance(0) - c0) / step;
        rho[e] -= step;
        assert!(
            (fd - dc).abs() < 1e-3 * dc.abs(),
            "element {e}: fd {fd} vs {dc}"
        );
    }
}

#[test]
fn optimizer_mode_ignores_void_outside_domain() {
    let mut solid = vec![true; 24];
    solid[23] = false;
    let s = stage(
        [6, 2, 2],
        &solid,
        vec![clamp(Face::XNeg)],
        vec![Load {
            cells: vec![[5, 0, 0]],
            force: [0.0, -10.0, 0.0],
        }],
    );
    let mut solver = Solver::new(
        Problem::from_stage(&s).unwrap(),
        SolverOptions {
            mode: Mode::Optimizer,
            ..SolverOptions::default()
        },
    );
    solver.solve();
    assert!(!solver.active()[23]);
    let mut energy = vec![1.0; 24];
    solver.element_energy(0, &mut energy);
    assert_eq!(energy[23], 0.0);
    assert!(energy[..23].iter().all(|&w| w >= 0.0));
    assert!(max_abs(solver.displacement(0)) > 0.0);
}
