//! Validation tests 1–5 of `docs/specs/solver.md` (must stay green).

mod common;

use common::{E, H, NU, clamp, max_abs, stage};
use fem::{Grid, Mode, Preconditioner, Problem, Solver, SolverOptions};
use stage::{Face, Load, Support};

fn opts(tol: f64) -> SolverOptions {
    SolverOptions {
        tol,
        ..SolverOptions::default()
    }
}

/// Consistent nodal forces of a uniform traction `t` (Pa, vector) on the boundary face
/// `face` of the full grid: each face quad of area h² gives a quarter to each corner.
fn add_face_traction(g: &Grid, force: &mut [f64], face: Face, t: [f64; 3]) {
    let axis = face.axis();
    let n = [g.nx, g.ny, g.nz];
    let layer = if face.is_positive() { n[axis] } else { 0 };
    let (a1, a2) = ((axis + 1) % 3, (axis + 2) % 3);
    let quarter = 0.25 * g.h * g.h;
    for p in 0..n[a1] {
        for q in 0..n[a2] {
            for (dp, dq) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let mut ijk = [0; 3];
                ijk[axis] = layer;
                ijk[a1] = p + dp;
                ijk[a2] = q + dq;
                let node = g.node_index(ijk[0], ijk[1], ijk[2]);
                for c in 0..3 {
                    force[3 * node + c] += t[c] * quarter;
                }
            }
        }
    }
}

fn roller(face: Face, fix: &str) -> Support {
    Support {
        face,
        fix: fix.into(),
        cells: None,
    }
}

/// 1. Patch test: uniform triaxial tension on a block with symmetry rollers reproduces
///    the exact linear displacement field and a uniform stress state.
#[test]
fn patch_test_uniform_triaxial_stress() {
    let dims = [4, 3, 2];
    let s = stage(
        dims,
        &[true; 24],
        vec![
            roller(Face::XNeg, "x"),
            roller(Face::YNeg, "y"),
            roller(Face::ZNeg, "z"),
        ],
        vec![Load {
            cells: vec![[3, 2, 1]],
            force: [1.0, 0.0, 0.0],
        }],
    );
    let mut p = Problem::from_stage(&s).unwrap();
    let g = p.grid;
    let sig = [3e6, -1e6, 2e6];
    let f = &mut p.cases[0].force;
    f.fill(0.0);
    add_face_traction(&g, f, Face::XPos, [sig[0], 0.0, 0.0]);
    add_face_traction(&g, f, Face::YPos, [0.0, sig[1], 0.0]);
    add_face_traction(&g, f, Face::ZPos, [0.0, 0.0, sig[2]]);

    let mut solver = Solver::new(p, opts(1e-13));
    let st = solver.solve();
    assert!(solver.converged(), "{st:?}");

    let strain: [f64; 3] = std::array::from_fn(|i| {
        let others = sig[(i + 1) % 3] + sig[(i + 2) % 3];
        (sig[i] - NU * others) / E
    });
    let u = solver.displacement(0);
    let u_scale = (0..3)
        .map(|i| (strain[i] * [g.nx, g.ny, g.nz][i] as f64 * H).abs())
        .fold(0.0, f64::max);
    let mut err: f64 = 0.0;
    for n in 0..g.nodes() {
        let ijk = g.node_coords(n);
        for c in 0..3 {
            let exact = strain[c] * ijk[c] as f64 * H;
            err = err.max((u[3 * n + c] - exact).abs());
        }
    }
    assert!(
        err / u_scale < 1e-8,
        "displacement rel error {}",
        err / u_scale
    );

    let s_scale = max_abs(&sig);
    for e in 0..g.elements() {
        let s = solver.stress(0, e);
        let exact = [sig[0], sig[1], sig[2], 0.0, 0.0, 0.0];
        for c in 0..6 {
            let rel = (s[c] - exact[c]).abs() / s_scale;
            assert!(rel < 1e-8, "element {e} stress {c}: rel error {rel}");
        }
    }
    // von Mises of the uniform state.
    let vm_exact = (0.5
        * ((sig[0] - sig[1]).powi(2) + (sig[1] - sig[2]).powi(2) + (sig[2] - sig[0]).powi(2)))
    .sqrt();
    let mut vm = vec![0.0; g.elements()];
    solver.von_mises(0, &mut vm);
    assert!(vm.iter().all(|v| (v - vm_exact).abs() < 1e-8 * vm_exact));
}

/// Tip deflection of a clamped cantilever under an end shear load (uniform traction on
/// the x+ face, total `p`). Returns (FE deflection, Timoshenko deflection).
fn cantilever_tip(dims: [usize; 3], h: f64) -> (f64, f64) {
    let [nx, ny, nz] = dims;
    let n = nx * ny * nz;
    let mut s = stage(
        dims,
        &vec![true; n],
        vec![clamp(Face::XNeg)],
        vec![Load {
            cells: vec![[nx - 1, 0, 0]],
            force: [0.0, -1.0, 0.0],
        }],
    );
    s.voxel_size = h;
    let mut p = Problem::from_stage(&s).unwrap();
    let g = p.grid;
    let (l, d, b) = (nx as f64 * h, ny as f64 * h, nz as f64 * h);
    let load = 1000.0;
    let f = &mut p.cases[0].force;
    f.fill(0.0);
    add_face_traction(&g, f, Face::XPos, [0.0, -load / (d * b), 0.0]);
    let mut solver = Solver::new(p, opts(1e-8));
    solver.solve();
    assert!(solver.converged());
    // δ = fᵀu / P (work-conjugate mean tip deflection).
    let delta = solver.compliance(0) / load;

    let inertia = b * d.powi(3) / 12.0;
    let shear = E / (2.0 * (1.0 + NU));
    let kappa = 5.0 / 6.0;
    let timo = load * l.powi(3) / (3.0 * E * inertia) + load * l / (kappa * shear * b * d);
    (delta, timo)
}

/// 2. Cantilever: within 15 % of Timoshenko beam theory and converging under refinement.
#[test]
fn cantilever_matches_timoshenko_and_converges() {
    // L/d = 8, square section; 4 then 8 elements through the depth.
    let (coarse, timo) = cantilever_tip([32, 4, 4], H);
    let (fine, timo_fine) = cantilever_tip([64, 8, 8], H / 2.0);
    assert!((timo - timo_fine).abs() < 1e-12 * timo);
    let err_c = (coarse - timo).abs() / timo;
    let err_f = (fine - timo).abs() / timo;
    eprintln!(
        "cantilever: timoshenko {timo:.6e}, coarse {coarse:.6e} ({err_c:.3}), fine {fine:.6e} ({err_f:.3})"
    );
    assert!(err_c < 0.15, "coarse error {err_c}");
    assert!(err_f < 0.15, "fine error {err_f}");
    // Stiff (conforming) elements converge from below.
    assert!(coarse < fine, "deflection must grow under refinement");
    assert!(err_f < err_c, "error must shrink under refinement");
}

/// 3. Symmetry: a doubly symmetric problem (incl. symmetric carving) gives a mirror-
///    symmetric displacement field.
#[test]
fn symmetric_problem_gives_symmetric_field() {
    let dims = [12, 4, 4];
    let n = 12 * 4 * 4;
    let s = stage(
        dims,
        &vec![true; n],
        vec![clamp(Face::XNeg), clamp(Face::XPos)],
        vec![Load {
            cells: vec![[5, 3, 1], [6, 3, 1], [5, 3, 2], [6, 3, 2]],
            force: [0.0, -2000.0, 0.0],
        }],
    );
    let p = Problem::from_stage(&s).unwrap();
    let g = p.grid;
    let mut solver = Solver::new(p, opts(1e-11));
    let carve = [
        (2, 1, 0),
        (9, 1, 0),
        (2, 1, 3),
        (9, 1, 3),
        (5, 0, 1),
        (6, 0, 2),
    ];
    let changes: Vec<(usize, bool)> = carve
        .iter()
        .map(|&(x, y, z)| (g.element_index(x, y, z), false))
        .collect();
    // (5,0,1)/(6,0,2) are symmetric under the combined x+z mirror only, so check that
    // mirror for the full set and the separate mirrors without those two cells.
    solver.set_solid(&changes);
    solver.solve();
    assert!(solver.converged());
    let u = solver.displacement(0).to_vec();
    let scale = max_abs(&u);
    let mirror = |mx: bool, mz: bool| {
        let mut err: f64 = 0.0;
        for nd in 0..g.nodes() {
            let [i, j, k] = g.node_coords(nd);
            let mi = if mx { g.nx - i } else { i };
            let mk = if mz { g.nz - k } else { k };
            let m = g.node_index(mi, j, mk);
            let sx = if mx { -1.0 } else { 1.0 };
            let sz = if mz { -1.0 } else { 1.0 };
            err = err.max((u[3 * nd] - sx * u[3 * m]).abs());
            err = err.max((u[3 * nd + 1] - u[3 * m + 1]).abs());
            err = err.max((u[3 * nd + 2] - sz * u[3 * m + 2]).abs());
        }
        err / scale
    };
    let both = mirror(true, true);
    assert!(both < 1e-8, "x+z mirror asymmetry {both}");

    // Restore the two point-symmetric cells: now each mirror is a symmetry on its own.
    solver.set_solid(&[(changes[4].0, true), (changes[5].0, true)]);
    solver.solve();
    let u2 = solver.displacement(0).to_vec();
    let scale = max_abs(&u2);
    for (mx, mz) in [(true, false), (false, true)] {
        let mut err: f64 = 0.0;
        for nd in 0..g.nodes() {
            let [i, j, k] = g.node_coords(nd);
            let m = g.node_index(
                if mx { g.nx - i } else { i },
                j,
                if mz { g.nz - k } else { k },
            );
            let sx = if mx { -1.0 } else { 1.0 };
            let sz = if mz { -1.0 } else { 1.0 };
            err = err.max((u2[3 * nd] - sx * u2[3 * m]).abs());
            err = err.max((u2[3 * nd + 1] - u2[3 * m + 1]).abs());
            err = err.max((u2[3 * nd + 2] - sz * u2[3 * m + 2]).abs());
        }
        assert!(
            err / scale < 1e-8,
            "mirror ({mx},{mz}) asymmetry {}",
            err / scale
        );
    }
}

/// 4. Preconditioner equivalence: Jacobi-PCG and MGCG agree to the solve tolerance.
#[test]
fn jacobi_and_multigrid_agree() {
    let s = common::cantilever([16, 4, 4], 500.0);
    let solve = |pc: Preconditioner| {
        let p = Problem::from_stage(&s).unwrap();
        let mut solver = Solver::new(
            p,
            SolverOptions {
                tol: 1e-10,
                preconditioner: pc,
                ..SolverOptions::default()
            },
        );
        solver.solve();
        assert!(solver.converged(), "{pc:?}");
        solver.displacement(0).to_vec()
    };
    let a = solve(Preconditioner::Jacobi);
    let b = solve(Preconditioner::Multigrid);
    let diff: f64 = a
        .iter()
        .zip(&b)
        .map(|(x, y)| (x - y).powi(2))
        .sum::<f64>()
        .sqrt();
    let norm: f64 = a.iter().map(|x| x * x).sum::<f64>().sqrt();
    assert!(diff / norm < 1e-7, "relative difference {}", diff / norm);
}

/// 5a. Soft-kill: cutting off a region does not change the solution of the rest.
#[test]
fn removing_a_disconnected_region_does_not_change_the_rest() {
    // Beam y ∈ 0..3 clamped at x-, plus a blob (x 4..8, y 5..7) hanging on a bridge
    // column (x = 6, y = 3..5).
    let dims = [12, 7, 2];
    let g = Grid {
        nx: 12,
        ny: 7,
        nz: 2,
        h: H,
    };
    let beam = |x: usize, y: usize| y < 3 && x < 12;
    let bridge = |x: usize, y: usize| x == 6 && (3..5).contains(&y);
    let blob = |x: usize, y: usize| (4..8).contains(&x) && (5..7).contains(&y);
    let cells = |f: &dyn Fn(usize, usize) -> bool| -> Vec<bool> {
        (0..g.elements())
            .map(|e| {
                let [x, y, _] = g.element_coords(e);
                f(x, y)
            })
            .collect()
    };
    let load = vec![Load {
        cells: vec![[11, 0, 0], [11, 0, 1]],
        force: [0.0, -800.0, 300.0],
    }];
    let with_blob = stage(
        dims,
        &cells(&|x, y| beam(x, y) || bridge(x, y) || blob(x, y)),
        vec![clamp(Face::XNeg)],
        load.clone(),
    );
    let beam_only = stage(
        dims,
        &cells(&|x, y| beam(x, y)),
        vec![clamp(Face::XNeg)],
        load,
    );

    let mut a = Solver::new(Problem::from_stage(&with_blob).unwrap(), opts(1e-10));
    a.solve();
    assert!(a.floating().is_empty());
    let bridge_cells: Vec<(usize, bool)> = (0..g.elements())
        .filter(|&e| {
            let [x, y, _] = g.element_coords(e);
            bridge(x, y)
        })
        .map(|e| (e, false))
        .collect();
    a.set_solid(&bridge_cells);
    let st = a.solve();
    assert!(a.converged(), "{st:?}");

    let mut b = Solver::new(Problem::from_stage(&beam_only).unwrap(), opts(1e-10));
    b.solve();
    assert!(b.converged());

    let ua = a.displacement(0);
    let ub = b.displacement(0);
    let scale = max_abs(ub);
    let diff = ua
        .iter()
        .zip(ub)
        .fold(0.0f64, |m, (x, y)| m.max((x - y).abs()));
    assert!(diff / scale < 1e-7, "relative difference {}", diff / scale);
    assert!((a.compliance(0) - b.compliance(0)).abs() < 1e-7 * b.compliance(0));

    let blob_cells: Vec<usize> = (0..g.elements())
        .filter(|&e| {
            let [x, y, _] = g.element_coords(e);
            blob(x, y)
        })
        .collect();
    assert_eq!(a.floating(), blob_cells);
    assert!(a.loads_connected());
    let mut ua_util = vec![0.0; g.elements()];
    let mut ub_util = vec![0.0; g.elements()];
    a.utilization(0, &mut ua_util);
    b.utilization(0, &mut ub_util);
    for e in 0..g.elements() {
        assert!((ua_util[e] - ub_util[e]).abs() <= 1e-6 * ub_util[e].max(1e-12));
    }
    assert!(
        blob_cells
            .iter()
            .all(|&e| !a.active()[e] && ua_util[e] == 0.0)
    );
}

/// 5b. A fully disconnected load: `loads_connected() == false`, no NaN, terminates.
#[test]
fn fully_disconnected_load_is_reported_without_nan() {
    let s = common::cantilever([12, 4, 2], 1000.0);
    let p = Problem::from_stage(&s).unwrap();
    let g = p.grid;
    for mode in [Mode::Player, Mode::Optimizer] {
        let mut solver = Solver::new(
            p.clone(),
            SolverOptions {
                mode,
                ..SolverOptions::default()
            },
        );
        solver.solve();
        // Cut the whole cross-section at x = 6.
        let cut: Vec<(usize, bool)> = (0..g.elements())
            .filter(|&e| g.element_coords(e)[0] == 6)
            .map(|e| (e, false))
            .collect();
        solver.set_solid(&cut);
        let st = solver.solve();
        assert!(st.done && st.rel_residual.is_finite(), "{mode:?}: {st:?}");
        assert!(solver.displacement(0).iter().all(|v| v.is_finite()));
        let mut util = vec![0.0; g.elements()];
        solver.utilization(0, &mut util);
        assert!(util.iter().all(|v| v.is_finite()));
        assert!(solver.judged_max_utilization(0).is_finite());
        assert!(solver.load_displacement(0).is_finite());
        let floating: Vec<usize> = (0..g.elements())
            .filter(|&e| g.element_coords(e)[0] > 6)
            .collect();
        assert_eq!(solver.floating(), floating, "{mode:?}");
        if mode == Mode::Player {
            assert!(!solver.loads_connected());
            // Nothing loads the remaining structure.
            assert_eq!(max_abs(solver.displacement(0)), 0.0);
            assert!(solver.converged());
        }
    }
}
