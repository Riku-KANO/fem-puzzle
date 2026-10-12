//! Phase 0 performance benchmark of the voxel FEM solver (task T-204).
//!
//! One scenario per grid: a solid cantilever (clamped on x-, pushed down on the top edge
//! of the free end — the shape of a W1 stage), solved
//!
//! - **cold**: `Problem::from_stage` + `Solver::new` (= setup) and a solve from `u = 0`;
//! - **warm**: after a 3×3 carve on the top surface, warm-started from the previous
//!   solution (what one player move costs). Each carve is undone (and re-solved,
//!   untimed) before the next one, so the samples are independent; the reported value
//!   is the median over `carves` random patches.
//!
//! Everything here is mirrored by `scripts/bench-wasm.mjs` — same stage, same
//! [`Mulberry32`] carve sequence, same timing boundaries — so native and WASM numbers
//! are directly comparable. Change both together.

use fem::{Preconditioner, Problem, Solver, SolverOptions};
use serde::Serialize;
use stage::{Bitmask, Face, Load, Stage, Support, Targets};
use std::time::Instant;

/// Benchmark grids: W1, W2, W3, W4/W5 stage sizes and the large sandbox.
pub const GRIDS: [[usize; 3]; 5] = [
    [24, 8, 4],
    [32, 8, 8],
    [32, 12, 12],
    [40, 12, 12],
    [60, 20, 20],
];

/// JSON schema version of [`Report`] (shared with `scripts/bench-wasm.mjs`).
pub const SCHEMA: u32 = 1;
/// Relative residual target (the game's default).
pub const DEFAULT_TOL: f64 = 1e-4;
/// Random carves per scenario (the warm numbers are their median).
pub const DEFAULT_CARVES: usize = 10;
/// Cold solves per scenario (median).
pub const DEFAULT_REPEATS: usize = 3;
/// Seed of the carve sequence.
pub const DEFAULT_SEED: u32 = 42;

const VOXEL: f64 = 0.01;
const YOUNG: f64 = 70e9;
const POISSON: f64 = 0.33;
const ALLOWABLE: f64 = 120e6;

/// `"{nx}x{ny}x{nz}"`.
pub fn grid_name([nx, ny, nz]: [usize; 3]) -> String {
    format!("{nx}x{ny}x{nz}")
}

/// Parse `"24x8x4"` (also accepts `×`).
pub fn parse_grid(s: &str) -> Result<[usize; 3], String> {
    let parts: Vec<&str> = s.split(['x', '×']).collect();
    let dims: Vec<usize> = parts
        .iter()
        .map(|p| p.trim().parse::<usize>())
        .collect::<Result<_, _>>()
        .map_err(|_| format!("invalid grid {s:?} (expected e.g. 40x12x12)"))?;
    match dims[..] {
        [nx, ny, nz] if nx >= 5 && ny >= 1 && nz >= 1 => Ok([nx, ny, nz]),
        [_, _, _] => Err(format!("invalid grid {s:?}: need nx >= 5, ny, nz >= 1")),
        _ => Err(format!("invalid grid {s:?} (expected e.g. 40x12x12)")),
    }
}

/// Cantilever along x, clamped on x-, loaded downwards on the top edge of the free end;
/// the force is sized so the beam-theory root bending stress is about `allowable / 2`
/// (as in `crates/fem-wasm/tests/node-smoke.mjs`).
pub fn cantilever([nx, ny, nz]: [usize; 3]) -> Stage {
    let n = nx * ny * nz;
    let h = VOXEL;
    let (b, d, l) = (nz as f64 * h, ny as f64 * h, nx as f64 * h);
    let inertia = b * d.powi(3) / 12.0;
    let force = 0.5 * ALLOWABLE * inertia / (l * (d / 2.0));
    Stage {
        version: 1,
        id: format!("bench-{}", grid_name([nx, ny, nz])),
        title: "bench cantilever".into(),
        world: 0,
        grid: [nx, ny, nz],
        voxel_size: h,
        material: stage::Material {
            e: YOUNG,
            nu: POISSON,
            allowable: ALLOWABLE,
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
            force: [0.0, -force, 0.0],
        }],
        load_cases: None,
        max_displacement: None,
        targets: Targets {
            star1: 0.7,
            star2: 0.55,
            star3: 0.45,
        },
        benchmark: None,
        hints: vec![],
    }
}

/// mulberry32 PRNG, bit-identical to the JS version in `scripts/bench-wasm.mjs`.
#[derive(Debug, Clone)]
pub struct Mulberry32(u32);

impl Mulberry32 {
    /// Generator with the given seed.
    pub fn new(seed: u32) -> Self {
        Mulberry32(seed)
    }

    /// Next value in `[0, 1)`.
    pub fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// Centres `(cx, cz)` of the carve patches: `cx ∈ [2, nx-3]` (so the patch stays clear of
/// the support layer x = 0 and the load cells at x = nx-1), `cz ∈ [0, nz-1]`.
pub fn carve_centres([nx, _, nz]: [usize; 3], carves: usize, seed: u32) -> Vec<(usize, usize)> {
    let mut rng = Mulberry32::new(seed);
    (0..carves)
        .map(|_| {
            let cx = 2 + (rng.next_f64() * (nx - 4) as f64) as usize;
            let cz = (rng.next_f64() * nz as f64) as usize;
            (cx, cz)
        })
        .collect()
}

/// The 3×3 patch (clipped in z) on the top surface `y = ny-1` around `(cx, cz)`.
pub fn top_patch([nx, ny, nz]: [usize; 3], (cx, cz): (usize, usize)) -> Vec<usize> {
    let mut out = Vec::with_capacity(9);
    for z in cz.saturating_sub(1)..=(cz + 1).min(nz - 1) {
        for x in cx - 1..=cx + 1 {
            out.push(x + nx * ((ny - 1) + ny * z));
        }
    }
    out
}

/// Median (mean of the middle two for even lengths); NaN for an empty slice.
pub fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    let mut s = xs.to_vec();
    s.sort_by(f64::total_cmp);
    let m = s.len() / 2;
    if s.len() % 2 == 1 {
        s[m]
    } else {
        0.5 * (s[m - 1] + s[m])
    }
}

/// Lower-case protocol name of a preconditioner (`"jacobi"`, `"multigrid"`).
pub fn precond_name(p: Preconditioner) -> &'static str {
    match p {
        Preconditioner::Jacobi => "jacobi",
        Preconditioner::Multigrid => "multigrid",
    }
}

/// Benchmark settings.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub tol: f64,
    pub carves: usize,
    pub repeats: usize,
    pub seed: u32,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            tol: DEFAULT_TOL,
            carves: DEFAULT_CARVES,
            repeats: DEFAULT_REPEATS,
            seed: DEFAULT_SEED,
        }
    }
}

/// Measurements for one (grid, preconditioner) scenario. Times in milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioResult {
    /// `"40x12x12"`.
    pub grid: String,
    pub dims: [usize; 3],
    pub elements: usize,
    pub dofs: usize,
    /// Preconditioner asked for in `SolverOptions`.
    pub requested: &'static str,
    /// Preconditioner that actually ran: `"multigrid"` iff the solver reports levels > 0.
    pub precond: &'static str,
    /// Multigrid levels (0 = single-level, i.e. Jacobi).
    pub levels: usize,
    /// `Problem::from_stage` + `Solver::new` (median of `repeats`).
    pub setup_ms: f64,
    /// Solve from `u = 0` (median of `repeats`).
    pub cold_ms: f64,
    pub cold_iters: usize,
    pub cold_rel_residual: f64,
    /// `set_solid` + warm-started solve, per carve.
    pub warm_ms: Vec<f64>,
    pub warm_iters: Vec<usize>,
    pub warm_median_ms: f64,
    pub warm_max_ms: f64,
    pub warm_median_iters: f64,
    /// Post-processing after a carve (utilisation field, judged max, load displacement),
    /// median.
    pub post_ms: f64,
    /// Every timed solve reached `tol`.
    pub converged: bool,
}

/// What one run of the benchmark produces (`--json`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema: u32,
    /// `"native"` (this crate) or `"wasm"` (`scripts/bench-wasm.mjs`).
    pub target: &'static str,
    pub scenario: &'static str,
    pub machine: Machine,
    pub config: Config,
    pub results: Vec<ScenarioResult>,
}

/// Where the numbers were measured.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub os: &'static str,
    pub arch: &'static str,
    pub cpu: String,
    pub logical_cpus: usize,
    /// The benchmark itself is single-threaded.
    pub threads: usize,
    pub unix_time: u64,
}

impl Machine {
    /// Describe the current machine (best effort; unknown fields are `"unknown"`).
    pub fn detect() -> Machine {
        Machine {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            cpu: cpu_model().unwrap_or_else(|| "unknown".into()),
            logical_cpus: std::thread::available_parallelism().map_or(0, |n| n.get()),
            threads: 1,
            unix_time: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs()),
        }
    }
}

fn cpu_model() -> Option<String> {
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .ok()?;
        let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
        return (!s.is_empty()).then_some(s);
    }
    let info = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    info.lines()
        .find(|l| l.starts_with("model name"))
        .and_then(|l| l.split_once(':'))
        .map(|(_, v)| v.trim().to_string())
}

fn ms_since(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

/// Post-processing a move needs: utilisation field + judged max + load displacement.
fn post_process(solver: &Solver, buf: &mut [f64]) -> f64 {
    let mut acc = 0.0;
    for c in 0..solver.problem().cases.len() {
        solver.utilization(c, buf);
        acc += solver.judged_max_utilization(c) + solver.load_displacement(c) + buf[0];
    }
    acc
}

/// Run one scenario (single thread; long grids take seconds with Jacobi).
pub fn run_scenario(dims: [usize; 3], requested: Preconditioner, cfg: &Config) -> ScenarioResult {
    let stage = cantilever(dims);
    let opts = SolverOptions {
        tol: cfg.tol,
        preconditioner: requested,
        ..SolverOptions::default()
    };
    let ok = |s: &fem::SolveStatus| s.done && s.rel_residual <= cfg.tol;
    let mut converged = true;

    // Cold: setup + solve from zero, `repeats` times; keep the last solver for the carves.
    let mut setup = Vec::new();
    let mut cold = Vec::new();
    let mut last = None;
    for _ in 0..cfg.repeats.max(1) {
        let t = Instant::now();
        let problem = Problem::from_stage(&stage).expect("bench cantilever is a valid stage");
        let mut solver = Solver::new(problem, opts);
        setup.push(ms_since(t));
        let t = Instant::now();
        let st = solver.solve();
        cold.push(ms_since(t));
        converged &= ok(&st);
        last = Some((solver, st));
    }
    let (mut solver, cold_st) = last.expect("repeats >= 1");
    let levels = solver.levels();
    let g = solver.problem().grid;

    let mut buf = vec![0.0; g.elements()];
    let mut warm_ms = Vec::with_capacity(cfg.carves);
    let mut warm_iters = Vec::with_capacity(cfg.carves);
    let mut post = Vec::with_capacity(cfg.carves);
    let mut sink = 0.0;
    for centre in carve_centres(dims, cfg.carves, cfg.seed) {
        let patch = top_patch(dims, centre);
        let carve: Vec<(usize, bool)> = patch.iter().map(|&e| (e, false)).collect();
        let restore: Vec<(usize, bool)> = patch.iter().map(|&e| (e, true)).collect();
        let t = Instant::now();
        solver.set_solid(&carve);
        let st = solver.solve();
        warm_ms.push(ms_since(t));
        warm_iters.push(st.iterations);
        converged &= ok(&st);
        let t = Instant::now();
        sink += post_process(&solver, &mut buf);
        post.push(ms_since(t));
        solver.set_solid(&restore);
        converged &= ok(&solver.solve());
    }
    std::hint::black_box(sink);

    let iters_f: Vec<f64> = warm_iters.iter().map(|&i| i as f64).collect();
    ScenarioResult {
        grid: grid_name(dims),
        dims,
        elements: g.elements(),
        dofs: g.dofs(),
        requested: precond_name(requested),
        precond: if levels > 0 { "multigrid" } else { "jacobi" },
        levels,
        setup_ms: median(&setup),
        cold_ms: median(&cold),
        cold_iters: cold_st.iterations,
        cold_rel_residual: cold_st.rel_residual,
        warm_median_ms: median(&warm_ms),
        warm_max_ms: warm_ms.iter().copied().fold(0.0, f64::max),
        warm_median_iters: median(&iters_f),
        warm_ms,
        warm_iters,
        post_ms: median(&post),
        converged,
    }
}

/// Fixed-width table of results (one line per scenario).
pub fn table(results: &[ScenarioResult]) -> String {
    let mut s = format!(
        "{:<10} {:>6} {:>6} {:<9} {:>2} | {:>8} {:>9} {:>6} | {:>9} {:>9} {:>6} | {:>7} {:>3}\n",
        "grid",
        "elems",
        "dofs",
        "precond",
        "lv",
        "setup ms",
        "cold ms",
        "it",
        "warm med",
        "warm max",
        "it",
        "post ms",
        "ok"
    );
    for r in results {
        let pc = if r.precond == r.requested {
            r.precond.to_string()
        } else {
            format!("{}*", r.precond)
        };
        s.push_str(&format!(
            "{:<10} {:>6} {:>6} {:<9} {:>2} | {:>8.2} {:>9.1} {:>6} | {:>9.1} {:>9.1} {:>6} | {:>7.2} {:>3}\n",
            r.grid,
            r.elements,
            r.dofs,
            pc,
            r.levels,
            r.setup_ms,
            r.cold_ms,
            r.cold_iters,
            r.warm_median_ms,
            r.warm_max_ms,
            r.warm_median_iters,
            r.post_ms,
            if r.converged { "yes" } else { "NO" },
        ));
    }
    if results.iter().any(|r| r.precond != r.requested) {
        s.push_str("* requested multigrid, solver fell back to jacobi (levels = 0)\n");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mulberry32_matches_js() {
        // node: rng(42) from scripts/bench-wasm.mjs
        let want = [
            0.6011037519201636,
            0.44829055899754167,
            0.8524657934904099,
            0.6697340414393693,
            0.17481389874592423,
        ];
        let mut r = Mulberry32::new(42);
        for w in want {
            assert_eq!(r.next_f64(), w);
        }
    }

    #[test]
    fn carve_centres_match_js() {
        let w1: Vec<(usize, usize)> = [
            [14, 1],
            [19, 2],
            [5, 2],
            [7, 2],
            [19, 1],
            [6, 3],
            [16, 1],
            [5, 2],
            [15, 2],
            [2, 1],
        ]
        .iter()
        .map(|&[x, z]| (x, z))
        .collect();
        assert_eq!(carve_centres([24, 8, 4], 10, 42), w1);
        let w4: Vec<(usize, usize)> = [
            [23, 5],
            [32, 8],
            [8, 6],
            [11, 7],
            [33, 5],
            [10, 10],
            [28, 3],
            [9, 6],
            [26, 7],
            [2, 5],
        ]
        .iter()
        .map(|&[x, z]| (x, z))
        .collect();
        assert_eq!(carve_centres([40, 12, 12], 10, 42), w4);
    }

    #[test]
    fn patches_stay_clear_of_supports_and_loads() {
        for dims in GRIDS {
            let stage = cantilever(dims);
            let p = Problem::from_stage(&stage).expect("valid");
            for c in carve_centres(dims, 200, 7) {
                let patch = top_patch(dims, c);
                // 3×3, or 3×2 where the patch is clipped at z = 0 / z = nz-1.
                assert!(patch.len() == 9 || patch.len() == 6, "{}", patch.len());
                for e in patch {
                    let [x, y, _] = p.grid.element_coords(e);
                    assert_eq!(y, dims[1] - 1);
                    assert!(x >= 1 && x + 2 <= dims[0], "x = {x}");
                    assert!(!p.keep[e] && !p.supported[e], "element {e} is protected");
                }
            }
        }
    }

    #[test]
    fn patch_is_clipped_at_z_edges() {
        let p = top_patch([24, 8, 4], (5, 0));
        assert_eq!(p.len(), 6);
        let p = top_patch([24, 8, 4], (5, 3));
        assert_eq!(p.len(), 6);
        let p = top_patch([24, 8, 1], (5, 0));
        assert_eq!(p, vec![4 + 24 * 7, 5 + 24 * 7, 6 + 24 * 7]);
    }

    #[test]
    fn median_odd_even() {
        assert_eq!(median(&[3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), 2.5);
        assert!(median(&[]).is_nan());
    }

    #[test]
    fn grid_round_trip() {
        assert_eq!(parse_grid("40x12x12"), Ok([40, 12, 12]));
        assert_eq!(parse_grid("24×8×4"), Ok([24, 8, 4]));
        assert_eq!(grid_name([60, 20, 20]), "60x20x20");
        assert!(parse_grid("40x12").is_err());
        assert!(parse_grid("4x12x12").is_err());
        assert!(parse_grid("axbxc").is_err());
    }

    #[test]
    fn small_scenario_runs_and_converges() {
        let cfg = Config {
            carves: 3,
            repeats: 1,
            ..Config::default()
        };
        let r = run_scenario([12, 4, 2], Preconditioner::Jacobi, &cfg);
        assert!(r.converged);
        assert_eq!(r.requested, "jacobi");
        assert_eq!(r.precond, "jacobi");
        assert_eq!(r.levels, 0);
        assert_eq!(r.warm_ms.len(), 3);
        assert!(r.cold_iters > 0);
        // Every carve changes the structure, so every warm re-solve iterates. (Not
        // necessarily fewer times than the cold solve: a notch makes Jacobi-PCG slower.)
        assert!(r.warm_iters.iter().all(|&i| i > 0));
        assert!(r.warm_median_ms <= r.warm_max_ms);
        let json = serde_json::to_value(&r).expect("serialises");
        assert!(json.get("warmMedianMs").is_some());
    }
}
