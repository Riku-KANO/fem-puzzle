//! Multigrid tests on small problems: Galerkin product vs a dense triple product,
//! symmetry / definiteness of the V-cycle, MGCG vs a dense direct solve, incremental vs
//! fresh rebuilds, and robustness on carved and high-contrast designs.

use super::*;
use crate::connectivity::connected_to_seeds;
use crate::{Jacobi, Operator};

const NU: f64 = 0.3;

/// Deterministic pseudo-random number in [0, 1).
pub(super) fn rand01(seed: &mut u64) -> f64 {
    *seed = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    (*seed >> 11) as f64 / (1u64 << 53) as f64
}

fn ugrid(nx: usize, ny: usize, nz: usize) -> Grid {
    grid::grid(nx, ny, nz)
}

/// DOFs of nodes on the x = 0 face are fixed (clamped).
fn clamped(g: &Grid) -> Vec<bool> {
    (0..g.dofs())
        .map(|d| g.node_coords(d / 3)[0] == 0)
        .collect()
}

/// Operator of a clamped block with per-element coefficients.
pub(super) fn clamped_operator(g: Grid, coef: &[f64]) -> Operator {
    let mut op = Operator::new(g, NU);
    op.update(&clamped(&g), |e| coef[e]);
    op
}

/// Random solid set with roughly `keep` of the elements, restricted to the component
/// face-connected to the clamped x = 0 layer.
pub(super) fn carved(g: &Grid, keep: f64, seed: u64) -> Vec<bool> {
    let mut s = seed;
    let solid: Vec<bool> = (0..g.elements())
        .map(|e| g.element_coords(e)[0] == 0 || rand01(&mut s) < keep)
        .collect();
    let seeds: Vec<bool> = (0..g.elements())
        .map(|e| g.element_coords(e)[0] == 0)
        .collect();
    let mut out = vec![false; g.elements()];
    connected_to_seeds(g, &solid, &seeds, &mut out, &mut Vec::new());
    out
}

/// Downward unit forces on the free y-DOFs of the x = nx face.
pub(super) fn tip_load(op: &Operator) -> Vec<f64> {
    let g = *op.grid();
    (0..g.dofs())
        .map(|d| {
            if d % 3 == 1 && g.node_coords(d / 3)[0] == g.nx && op.free()[d] {
                -1.0
            } else {
                0.0
            }
        })
        .collect()
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Plain PCG from x = 0. Returns `(x, iterations, min over iterations of zᵀr / (‖z‖‖r‖))`.
///
/// Asserts that CG does not break down (`pᵀAp > 0`, `rᵀz > 0`) and that the energy
/// `φ(x) = ½xᵀAx − fᵀx` (the A-norm error up to a constant) decreases monotonically.
pub(super) fn pcg(
    op: &Operator,
    pc: &mut dyn Precond,
    f: &[f64],
    tol: f64,
    max_iters: usize,
) -> (Vec<f64>, usize, f64) {
    let n = f.len();
    let mut x = vec![0.0; n];
    let mut r = f.to_vec();
    let mut z = vec![0.0; n];
    let mut q = vec![0.0; n];
    let fnorm = dot(f, f).sqrt();
    pc.apply(&r, &mut z);
    let mut p = z.clone();
    let mut rz = dot(&r, &z);
    let mut min_cos = rz / (dot(&z, &z).sqrt() * fnorm);
    let mut it = 0;
    let mut phi = 0.0f64;
    let mut ax = vec![0.0; n];
    while it < max_iters && dot(&r, &r).sqrt() > tol * fnorm {
        op.apply(&p, &mut q);
        let pap = dot(&p, &q);
        assert!(pap > 0.0, "breakdown: pᵀAp = {pap} at iteration {it}");
        let alpha = rz / pap;
        for i in 0..n {
            x[i] += alpha * p[i];
            r[i] -= alpha * q[i];
        }
        op.apply(&x, &mut ax);
        let phi_new = 0.5 * dot(&x, &ax) - dot(f, &x);
        assert!(
            phi_new < phi + 1e-12 * phi.abs(),
            "energy increased at iteration {it}: {phi} → {phi_new}"
        );
        phi = phi_new;
        pc.apply(&r, &mut z);
        let rz_new = dot(&r, &z);
        assert!(rz_new > 0.0 || dot(&r, &r) == 0.0, "rᵀz = {rz_new} at {it}");
        let rn = dot(&r, &r).sqrt();
        if rn > 0.0 {
            min_cos = min_cos.min(rz_new / (dot(&z, &z).sqrt() * rn));
        }
        let beta = rz_new / rz;
        rz = rz_new;
        for i in 0..n {
            p[i] = z[i] + beta * p[i];
        }
        it += 1;
    }
    (x, it, min_cos)
}

/// Dense matrix of a linear map, `m[i][j] = (F e_j)_i`.
fn dense(n_in: usize, n_out: usize, mut f: impl FnMut(&[f64], &mut [f64])) -> Vec<Vec<f64>> {
    let mut m = vec![vec![0.0; n_in]; n_out];
    let mut x = vec![0.0; n_in];
    let mut y = vec![0.0; n_out];
    for j in 0..n_in {
        x[j] = 1.0;
        f(&x, &mut y);
        for i in 0..n_out {
            m[i][j] = y[i];
        }
        x[j] = 0.0;
    }
    m
}

/// Dense Cholesky; `None` if not positive definite.
fn cholesky(a: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let n = a.len();
    let mut l = vec![vec![0.0; n]; n];
    for i in 0..n {
        for j in 0..=i {
            let s = a[i][j] - (0..j).map(|k| l[i][k] * l[j][k]).sum::<f64>();
            if i == j {
                if s <= 0.0 {
                    return None;
                }
                l[i][i] = s.sqrt();
            } else {
                l[i][j] = s / l[j][j];
            }
        }
    }
    Some(l)
}

fn cholesky_solve(l: &[Vec<f64>], b: &[f64]) -> Vec<f64> {
    let n = b.len();
    let mut y = vec![0.0; n];
    for i in 0..n {
        y[i] = (b[i] - (0..i).map(|k| l[i][k] * y[k]).sum::<f64>()) / l[i][i];
    }
    for i in (0..n).rev() {
        y[i] = (y[i] - (i + 1..n).map(|k| l[k][i] * y[k]).sum::<f64>()) / l[i][i];
    }
    y
}

fn mg_with(op: &Operator, opts: MgOptions) -> Multigrid {
    let mut mg = Multigrid::new(opts);
    mg.rebuild(&op.view());
    mg
}

/// A small carved operator with holes, a partially fixed face and varying stiffness.
fn small_carved_operator(g: Grid) -> Operator {
    let mut solid = carved(&g, 0.8, 11);
    // Ensure some elements touching the support are absent too.
    solid[g.element_index(0, g.ny - 1, 0)] = false;
    let coef: Vec<f64> = (0..g.elements())
        .map(|e| if solid[e] { 1.0 + (e % 5) as f64 } else { 0.0 })
        .collect();
    clamped_operator(g, &coef)
}

#[test]
fn hierarchy_shapes_for_stage_grids() {
    let cases: [([usize; 3], usize); 5] = [
        ([24, 8, 4], 2),
        ([32, 8, 8], 2),
        ([32, 12, 12], 3),
        ([40, 12, 12], 3),
        ([60, 20, 20], 3),
    ];
    for ([nx, ny, nz], levels) in cases {
        let g = ugrid(nx, ny, nz);
        let op = clamped_operator(g, &vec![1.0; g.elements()]);
        let mg = mg_with(&op, MgOptions::default());
        assert_eq!(
            mg.levels(),
            levels,
            "{nx}x{ny}x{nz}: {:?}",
            mg.level_grids()
        );
        let (n, bw) = mg.coarse_size().unwrap();
        assert!(n <= 2000, "{n}");
        assert!(bw < 200, "{bw}");
        assert_eq!(mg.stats().last_null_pivots, 0);
    }
}

/// `P_lᵀ A_l P_l` (dense, with the masked prolongation) equals the stored `A_{l+1}` on
/// every level of 2- and 3-level hierarchies, including odd axes and an empty coarse cell.
#[test]
fn galerkin_coarse_operator_equals_dense_triple_product() {
    for (dims, levels) in [
        ([4, 2, 2], 2),
        ([4, 3, 2], 2),
        ([8, 3, 4], 3),
        ([5, 3, 3], 3),
    ] {
        let g = ugrid(dims[0], dims[1], dims[2]);
        let mut op = small_carved_operator(g);
        if dims == [4, 3, 2] {
            // y has 3 cells → coarse cells {0, 1} and {2}. Emptying the coarse element
            // (1, 1, 0) leaves the coarse nodes (2, 2, k) (= fine nodes (4, 3, 2k)) with only
            // masked fine nodes to interpolate to: they must be masked.
            let coef: Vec<f64> = (0..g.elements())
                .map(|e| {
                    let [x, y, _] = g.element_coords(e);
                    if x >= 2 && y == 2 { 0.0 } else { op.coef()[e] }
                })
                .collect();
            op = clamped_operator(g, &coef);
        }
        let opts = MgOptions {
            coarse_max_dofs: 1,
            max_levels: levels,
            ..MgOptions::default()
        };
        let mg = mg_with(&op, opts);
        assert_eq!(mg.levels(), levels, "{dims:?}: {:?}", mg.level_grids());
        // Level 0 operator is exactly the solver's operator.
        let nf0 = mg.levels[0].n_dofs();
        let a = dense(nf0, nf0, |x, y| op.apply(x, y));
        let a0 = dense(nf0, nf0, |x, y| mg.levels[0].apply(x, y));
        for i in 0..nf0 {
            for j in 0..nf0 {
                assert!((a[i][j] - a0[i][j]).abs() < 1e-12);
            }
        }
        for l in 0..levels - 1 {
            let (fine, coarse) = (&mg.levels[l], &mg.levels[l + 1]);
            let tr = &mg.transfers[l];
            let (nf, nc) = (fine.n_dofs(), coarse.n_dofs());
            let a = dense(nf, nf, |x, y| fine.apply(x, y));
            // P' = M P column by column.
            let p = dense(nc, nf, |x, y| {
                y.fill(0.0);
                tr.prolong_add(x, &fine.free, y);
            });
            let ac = dense(nc, nc, |x, y| coarse.apply(x, y));
            let scale = a.iter().flatten().fold(0.0f64, |m, v| m.max(v.abs()));
            let mut n_masked = 0;
            for i in 0..nc {
                for j in 0..nc {
                    let mut s = 0.0;
                    for k in 0..nf {
                        if p[k][i] == 0.0 {
                            continue;
                        }
                        for m in 0..nf {
                            s += p[k][i] * a[k][m] * p[m][j];
                        }
                    }
                    let expect = if coarse.free[i] {
                        s
                    } else {
                        // Masked coarse DOF: zero row in PᵀAP, identity in A_c.
                        assert!(
                            s.abs() < 1e-12 * scale,
                            "level {l}: masked DOF {i} has PᵀAP row entry {s}"
                        );
                        if i == j { 1.0 } else { 0.0 }
                    };
                    assert!(
                        (ac[i][j] - expect).abs() < 1e-12 * scale,
                        "{dims:?} level {l} ({i},{j}): {} vs {expect}",
                        ac[i][j]
                    );
                }
                n_masked += usize::from(!coarse.free[i]);
            }
            if dims == [4, 3, 2] {
                assert_eq!(n_masked, 6, "coarse nodes (2, 2, 0..=1)");
            }
        }
    }
}

#[test]
fn vcycle_is_symmetric_positive_definite() {
    // Three levels on a tiny carved grid; y has 3 cells (one single-width coarse cell).
    let g = ugrid(8, 3, 4);
    let op = small_carved_operator(g);
    for sweeps in [1, 2] {
        let opts = MgOptions {
            coarse_max_dofs: 1,
            max_levels: 3,
            sweeps,
            ..MgOptions::default()
        };
        let mut mg = mg_with(&op, opts);
        assert_eq!(mg.level_grids(), vec![[8, 3, 4], [4, 2, 2], [2, 1, 1]]);
        let n = g.dofs();
        let b = dense(n, n, |x, y| mg.apply(x, y));
        let scale = b.iter().flatten().fold(0.0f64, |m, v| m.max(v.abs()));
        for (i, row) in b.iter().enumerate() {
            for (j, &bij) in row.iter().enumerate() {
                assert!(
                    (bij - b[j][i]).abs() < 1e-12 * scale,
                    "B not symmetric at ({i},{j}): {bij} vs {}",
                    b[j][i]
                );
                if !op.free()[i] {
                    // z = r on masked DOFs.
                    assert_eq!(bij, if i == j { 1.0 } else { 0.0 });
                }
            }
        }
        assert!(cholesky(&b).is_some(), "V-cycle not positive definite");
    }
}

#[test]
fn mgcg_matches_dense_direct_solve() {
    let g = ugrid(8, 4, 4);
    for keep in [1.0, 0.7] {
        let solid = carved(&g, keep, 5);
        let coef: Vec<f64> = solid.iter().map(|&s| if s { 2.5 } else { 0.0 }).collect();
        let op = clamped_operator(g, &coef);
        let f = tip_load(&op);
        let n = g.dofs();
        let a = dense(n, n, |x, y| op.apply(x, y));
        let l = cholesky(&a).expect("A is SPD");
        let exact = cholesky_solve(&l, &f);
        let mut mg = mg_with(
            &op,
            MgOptions {
                coarse_max_dofs: 100,
                ..MgOptions::default()
            },
        );
        assert!(mg.levels() >= 2);
        let (x, iters, min_cos) = pcg(&op, &mut mg, &f, 1e-12, 200);
        assert!(iters < 60, "keep {keep}: {iters} iterations");
        assert!(min_cos > 0.0);
        let xmax = exact.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        for i in 0..n {
            assert!(
                (x[i] - exact[i]).abs() < 1e-9 * xmax,
                "{i}: {} vs {}",
                x[i],
                exact[i]
            );
        }
    }
}

#[test]
fn single_level_is_exact_direct_solve() {
    // 5×3×3 cannot be coarsened: the "V-cycle" is the banded Cholesky of A itself.
    let g = ugrid(5, 3, 3);
    let op = clamped_operator(g, &vec![1.0; g.elements()]);
    let mut mg = mg_with(&op, MgOptions::default());
    assert_eq!(mg.levels(), 1);
    let f = tip_load(&op);
    let (_, iters, _) = pcg(&op, &mut mg, &f, 1e-10, 10);
    assert!(iters <= 1, "{iters}");
}

#[test]
fn incremental_rebuild_matches_fresh_build() {
    let g = ugrid(16, 8, 8);
    let mut solid = vec![true; g.elements()];
    let mut op = clamped_operator(g, &vec![1.0; g.elements()]);
    let mut mg = mg_with(&op, MgOptions::default());
    assert_eq!(mg.stats().setups, 1);
    let total: usize = mg.levels[1..].iter().map(|l| l.grid.elements()).sum();
    assert_eq!(mg.stats().last_rebuilt_elems, total);
    // Carve a 3×3 patch from the top surface, then a second patch near the support.
    for (x0, z0) in [(10, 3), (0, 0)] {
        for x in x0..x0 + 3 {
            for z in z0..z0 + 3 {
                solid[g.element_index(x, g.ny - 1, z)] = false;
            }
        }
        op.update(&clamped(&g), |e| if solid[e] { 1.0 } else { 0.0 });
        mg.rebuild(&op.view());
        assert_eq!(mg.stats().setups, 1);
        assert!(mg.stats().last_rebuilt_elems < total / 4);
        let mut fresh = mg_with(&op, MgOptions::default());
        for (li, (a, b)) in mg.levels.iter().zip(&fresh.levels).enumerate() {
            assert_eq!(a.free, b.free, "level {li} mask");
            assert_eq!(a.inv_diag, b.inv_diag, "level {li} diagonal");
            if let (ElemOp::Stored { mats: ma, .. }, ElemOp::Stored { mats: mb, .. }) =
                (&a.op, &b.op)
            {
                assert_eq!(ma, mb, "level {li} element matrices");
            }
        }
        let mut seed = 99;
        let r: Vec<f64> = (0..g.dofs())
            .map(|d| {
                if op.free()[d] {
                    rand01(&mut seed) - 0.5
                } else {
                    0.0
                }
            })
            .collect();
        let (mut z1, mut z2) = (vec![0.0; r.len()], vec![0.0; r.len()]);
        mg.apply(&r, &mut z1);
        fresh.apply(&r, &mut z2);
        assert_eq!(z1, z2);
    }
    // No change ⇒ nothing rebuilt.
    let before = mg.stats().rebuilds;
    mg.rebuild(&op.view());
    assert_eq!(mg.stats().rebuilds, before);
}

#[test]
fn preconditioner_is_positive_on_carved_and_contrast_designs() {
    let g = ugrid(24, 8, 4);
    let mut seed = 1234u64;
    for design in 0..4 {
        let coef: Vec<f64> = match design {
            0 => vec![1.0; g.elements()],
            1 => carved(&g, 0.5, 3)
                .iter()
                .map(|&s| if s { 1.0 } else { 0.0 })
                .collect(),
            // SIMP densities with E_min = 1e-9 contrast.
            2 => (0..g.elements())
                .map(|_| 1e-9 + rand01(&mut seed).powi(3) * (1.0 - 1e-9))
                .collect(),
            _ => (0..g.elements())
                .map(|_| if rand01(&mut seed) < 0.5 { 1e-9 } else { 1.0 })
                .collect(),
        };
        let op = clamped_operator(g, &coef);
        let mut mg = mg_with(&op, MgOptions::default());
        for _ in 0..20 {
            let r: Vec<f64> = (0..g.dofs())
                .map(|d| {
                    if op.free()[d] {
                        rand01(&mut seed) - 0.5
                    } else {
                        0.0
                    }
                })
                .collect();
            let mut z = vec![0.0; r.len()];
            mg.apply(&r, &mut z);
            assert!(dot(&z, &r) > 0.0, "design {design}: zᵀr ≤ 0");
            assert!(z.iter().all(|v| v.is_finite()));
        }
        let f = tip_load(&op);
        let (x_mg, it_mg, min_cos) = pcg(&op, &mut mg, &f, 1e-8, 2000);
        let mut jac = Jacobi::default();
        jac.rebuild(&op.view());
        let (x_j, it_j, _) = pcg(&op, &mut jac, &f, 1e-8, 50_000);
        assert!(min_cos > 0.0, "design {design}");
        assert!(
            it_mg * 3 < it_j,
            "design {design}: MG {it_mg} vs Jacobi {it_j}"
        );
        // Same solution (relative to the largest displacement).
        let xmax = x_j.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        let err = x_mg
            .iter()
            .zip(&x_j)
            .fold(0.0f64, |m, (a, b)| m.max((a - b).abs()));
        assert!(err < 1e-5 * xmax, "design {design}: {err} vs {xmax}");
    }
}

#[test]
fn unsafe_options_are_corrected_and_vcycle_stays_symmetric() {
    let mg = Multigrid::new(MgOptions {
        sweeps: 0,
        omega: -1.0,
        omega_cap: 2.5,
        ..MgOptions::default()
    });
    assert_eq!(mg.options().sweeps, 1);
    assert_eq!(mg.options().omega, MgOptions::default().omega);
    assert_eq!(mg.options().omega_cap, MAX_OMEGA_CAP);
    let mg = Multigrid::new(MgOptions {
        omega_cap: f64::NAN,
        omega: f64::INFINITY,
        ..MgOptions::default()
    });
    assert_eq!(mg.options().omega_cap, MgOptions::default().omega_cap);
    assert_eq!(mg.options().omega, MgOptions::default().omega);
    // A request for 0 sweeps still yields a symmetric V-cycle.
    let g = ugrid(4, 2, 2);
    let op = small_carved_operator(g);
    let mut mg = Multigrid::new(MgOptions {
        sweeps: 0,
        coarse_max_dofs: 1,
        ..MgOptions::default()
    });
    mg.rebuild(&op.view());
    assert!(mg.levels() >= 2);
    let n = g.dofs();
    let b = dense(n, n, |x, y| mg.apply(x, y));
    let scale = b.iter().flatten().fold(0.0f64, |m, v| m.max(v.abs()));
    for (i, row) in b.iter().enumerate() {
        for (j, &bij) in row.iter().enumerate() {
            assert!((bij - b[j][i]).abs() < 1e-12 * scale, "({i},{j})");
        }
    }
}

/// True relative residual `‖f − A x‖ / ‖f‖`.
fn true_residual(op: &Operator, f: &[f64], x: &[f64]) -> f64 {
    let mut ax = vec![0.0; f.len()];
    op.apply(x, &mut ax);
    let r: f64 = ax
        .iter()
        .zip(f)
        .map(|(a, b)| (a - b) * (a - b))
        .sum::<f64>()
        .sqrt();
    r / dot(f, f).sqrt()
}

/// End-to-end null-pivot path: a one-voxel plate clamped on x = 0 makes the Galerkin
/// coarsest operator singular (the plate's free fine nodes on x = 1 interpolate from two
/// coarse node layers with equal weights). Null pivots must be detected and MGCG must still
/// reach the exact solution.
#[test]
fn null_pivots_on_clamped_plate_give_correct_solution() {
    for (dims, coarse_max_dofs) in [([16, 8, 8], 2000), ([16, 8, 8], 100), ([8, 4, 4], 100)] {
        let g = ugrid(dims[0], dims[1], dims[2]);
        let coef: Vec<f64> = (0..g.elements())
            .map(|e| {
                if g.element_coords(e)[0] == 0 {
                    1.0
                } else {
                    0.0
                }
            })
            .collect();
        let op = clamped_operator(g, &coef);
        let mut mg = mg_with(
            &op,
            MgOptions {
                coarse_max_dofs,
                ..MgOptions::default()
            },
        );
        let nulls = mg.stats().last_null_pivots;
        assert!(mg.levels() >= 2);
        assert!(
            nulls > 0,
            "{dims:?}/{coarse_max_dofs}: expected null pivots"
        );
        let mut seed = 100;
        let f: Vec<f64> = (0..g.dofs())
            .map(|d| {
                if op.free()[d] {
                    rand01(&mut seed) - 0.5
                } else {
                    0.0
                }
            })
            .collect();
        let (x, iters, min_cos) = pcg(&op, &mut mg, &f, 1e-11, 500);
        let res = true_residual(&op, &f, &x);
        assert!(min_cos > 0.0);
        assert!(
            res < 1e-10,
            "{dims:?}: true residual {res} after {iters} it ({nulls} nulls)"
        );
    }
}

/// Incremental rebuilds stay bit-identical to fresh builds for carve, add-back,
/// coefficient-only (density) changes and a floating component being removed / re-attached.
#[test]
fn incremental_rebuild_add_back_density_and_floating() {
    let g = ugrid(16, 8, 8);
    let fixed = clamped(&g);
    let mut coef = vec![1.0; g.elements()];
    let mut op = clamped_operator(g, &coef);
    let mut mg = mg_with(&op, MgOptions::default());
    let total: usize = mg.levels[1..].iter().map(|l| l.grid.elements()).sum();
    let mut step = |coef: &[f64], tag: &str, local: bool| {
        op.update(&fixed, |e| coef[e]);
        mg.rebuild(&op.view());
        assert_eq!(mg.stats().setups, 1, "{tag}: no re-setup");
        if local {
            assert!(
                mg.stats().last_rebuilt_elems < total / 2,
                "{tag}: not incremental"
            );
        }
        let mut fresh = mg_with(&op, MgOptions::default());
        for (li, (a, b)) in mg.levels.iter().zip(&fresh.levels).enumerate() {
            assert_eq!(a.free, b.free, "{tag}: level {li} mask");
            assert_eq!(a.inv_diag, b.inv_diag, "{tag}: level {li} smoother");
        }
        let mut seed = 7;
        let r: Vec<f64> = (0..g.dofs())
            .map(|d| {
                if op.free()[d] {
                    rand01(&mut seed) - 0.5
                } else {
                    0.0
                }
            })
            .collect();
        let (mut z1, mut z2) = (vec![0.0; r.len()], vec![0.0; r.len()]);
        mg.apply(&r, &mut z1);
        fresh.apply(&r, &mut z2);
        assert_eq!(z1, z2, "{tag}");
    };
    let patch: Vec<usize> = (5..8)
        .flat_map(|x| (2..5).map(move |z| g.element_index(x, 7, z)))
        .collect();
    for &e in &patch {
        coef[e] = 0.0;
    }
    step(&coef, "carve", true);
    for &e in &patch {
        coef[e] = 1.0;
    }
    step(&coef, "add back", true);
    for e in 0..40 {
        coef[e * 7 % g.elements()] = 0.3;
    }
    step(&coef, "coef only", false);
    // The solver gives floating parts coef 0: cut everything beyond x = 10, then re-attach.
    let beyond: Vec<usize> = (0..g.elements())
        .filter(|&e| g.element_coords(e)[0] >= 10)
        .collect();
    for &e in &beyond {
        coef[e] = 0.0;
    }
    step(&coef, "floating removed", false);
    for &e in &beyond {
        coef[e] = 1.0;
    }
    step(&coef, "re-attached", false);
}
