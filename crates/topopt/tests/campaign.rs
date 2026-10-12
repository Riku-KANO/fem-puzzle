//! Campaign content (T-305): the W1/W2 stage set is complete and every stage is solvable with
//! the real solver — its benchmark design passes the game's judge rules (strength in player
//! mode, loads connected, no floating parts, keep cells intact and anchored, stiffness if
//! set) and earns ★★★. The uncarved block must be a fair start: it passes, but is not so
//! over-designed that the colour map stays blue for most of the carving.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use topopt::design;
use topopt::driver::{self, Model, VERIFY_TOL};

/// Worlds whose campaign is authored (design doc: キャンペーン, 8–10 stages per world).
const WORLDS: [u32; 2] = [1, 2];
const MIN_STAGES: usize = 8;
const MAX_STAGES: usize = 10;
/// Uncarved-block utilisation floor: w2-01 at 32x8x8 sat at 0.18 and was rejected as
/// absurdly over-designed (T-305).
const FULL_BLOCK_MIN_UTILIZATION: f64 = 0.25;
/// Loads are spread over strips (stress singularities otherwise; tools/blender/README.md).
const MIN_LOAD_CELLS: usize = 8;

fn campaign() -> Vec<Model> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../stages");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("stages/ exists")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
        .iter()
        .map(|f| {
            let text = std::fs::read_to_string(f).expect("readable stage");
            Model::from_json(&text).unwrap_or_else(|e| panic!("{}: {e}", f.display()))
        })
        .filter(|m| WORLDS.contains(&m.stage.world))
        .collect()
}

#[test]
fn every_world_has_8_to_10_consecutively_numbered_stages() {
    let mut by_world: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    for m in campaign() {
        by_world
            .entry(m.stage.world)
            .or_default()
            .push(m.stage.id.clone());
    }
    for w in WORLDS {
        let ids = by_world.get(&w).cloned().unwrap_or_default();
        assert!(
            (MIN_STAGES..=MAX_STAGES).contains(&ids.len()),
            "world {w}: {} stages ({ids:?})",
            ids.len()
        );
        let expected: Vec<String> = (1..=ids.len()).map(|i| format!("w{w}-{i:02}")).collect();
        assert_eq!(
            ids, expected,
            "world {w}: ids must be w{w}-01.. without gaps"
        );
    }
}

#[test]
fn stages_have_titles_hints_and_spread_loads() {
    let mut titles = BTreeSet::new();
    for m in campaign() {
        let s = &m.stage;
        assert!(!s.title.trim().is_empty(), "{}: empty title", s.id);
        assert!(
            titles.insert(s.title.clone()),
            "{}: duplicate title {}",
            s.id,
            s.title
        );
        assert!(
            (1..=3).contains(&s.hints.len()),
            "{}: {} hints (want 1–3)",
            s.id,
            s.hints.len()
        );
        assert!(
            s.hints.iter().all(|h| !h.trim().is_empty()),
            "{}: empty hint",
            s.id
        );
        for (i, load) in s.loads.iter().enumerate() {
            assert!(
                load.cells.len() >= MIN_LOAD_CELLS,
                "{}: load {i} has {} cells",
                s.id,
                load.cells.len()
            );
        }
    }
}

#[test]
fn every_benchmark_passes_the_judge_with_the_real_solver() {
    let mut failures = Vec::new();
    for m in campaign() {
        let s = &m.stage;
        let l = &m.layout;
        let Some(b) = &s.benchmark else {
            failures.push(format!("{}: no benchmark", s.id));
            continue;
        };
        let solid = b.solid.to_bools(l.n()).expect("benchmark bitmask");
        let count = solid.iter().filter(|&&x| x).count();
        let volume = count as f64 / l.domain_count() as f64;
        let mut problems = Vec::new();
        if (0..l.n()).any(|e| solid[e] && !l.domain[e]) {
            problems.push("material outside the domain".to_string());
        }
        if (0..l.n()).any(|e| l.keep[e] && !solid[e]) {
            problems.push("a protected cell was removed".into());
        }
        if !design::is_valid(l, &solid) {
            problems.push("a load or keep cell is not connected to a support".into());
        }
        if volume > s.targets.star3 {
            problems.push(format!(
                "volume {volume:.4} misses ★★★ ({})",
                s.targets.star3
            ));
        }
        match driver::judge(&m.problem, &solid, VERIFY_TOL) {
            Ok(j) => {
                if !j.converged {
                    problems.push("solve did not converge".into());
                }
                if !j.loads_connected || j.floating > 0 {
                    problems.push(format!(
                        "connectivity (loads connected {}, floating {})",
                        j.loads_connected, j.floating
                    ));
                }
                if j.max_utilization.is_nan() || j.max_utilization > 1.0 {
                    problems.push(format!("max utilisation {:.4}", j.max_utilization));
                }
                if let Some(d) = s.max_displacement
                    && j.load_displacement > d
                {
                    problems.push(format!("displacement {:.3e} > {d:e}", j.load_displacement));
                }
            }
            Err(e) => problems.push(format!("judge failed: {e}")),
        }
        if !problems.is_empty() {
            failures.push(format!("{}: {}", s.id, problems.join("; ")));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn uncarved_block_is_a_fair_start() {
    let mut failures = Vec::new();
    for m in campaign() {
        let id = &m.stage.id;
        match driver::judge(&m.problem, &m.layout.domain, VERIFY_TOL) {
            Ok(j) if !j.converged => failures.push(format!("{id}: full block did not converge")),
            Ok(j) if j.max_utilization.is_nan() || j.max_utilization >= 1.0 => {
                failures.push(format!("{id}: full block fails ({:.4})", j.max_utilization))
            }
            Ok(j) if j.max_utilization < FULL_BLOCK_MIN_UTILIZATION => failures.push(format!(
                "{id}: full block at {:.4} is over-designed (< {FULL_BLOCK_MIN_UTILIZATION})",
                j.max_utilization
            )),
            Ok(_) => {}
            Err(e) => failures.push(format!("{id}: {e}")),
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
