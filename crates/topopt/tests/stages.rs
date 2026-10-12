//! Every committed stage is calibrated, its benchmark re-verifies with the current solver,
//! and the file is in the exporter's exact format (so `calibrate --write` round-trips).
//! Fails after a numerics change: recalibrate with `TOPOPT_FORCE=1 bash scripts/build-stages.sh`.

use std::path::PathBuf;
use topopt::driver::{self, Model};
use topopt::stagejson;

fn stage_files() -> Vec<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../stages");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("stages/ exists")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
}

#[test]
fn committed_stages_are_calibrated_and_reverify() {
    let files = stage_files();
    assert!(!files.is_empty(), "no stages/*.json");
    let mut failures = Vec::new();
    for f in &files {
        let text = std::fs::read_to_string(f).unwrap();
        let value = stagejson::parse(&text).unwrap();
        assert_eq!(
            stagejson::to_text(&value),
            text,
            "{} is not in exporter format",
            f.display()
        );
        let model = Model::from_json(&text).unwrap();
        if let Err(e) = driver::verify_calibrated(&model) {
            failures.push(format!("{}: {e}", f.display()));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
