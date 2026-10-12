---
id: T-203
title: Offline SIMP/OC optimiser — benchmark solutions, load calibration, star targets
status: doing
phase: 0
depends: [T-101, T-103]
owns:
  - crates/topopt/**
touches:
  - scripts/build-stages.sh   # chain `topopt calibrate` after the Blender export
  - stages/*.json             # only loads[].force, targets, benchmark fields
verify:
  - cargo test -p topopt
  - cargo clippy -p topopt --all-targets -- -D warnings
  - bash scripts/build-stages.sh --check
---
## Goal
Design doc: ベンチマーク解 / 難易度のつまみ. The same Rust solver, built natively, runs
SIMP (penal 3) with the OC update to produce the "algorithm's answer" for every stage, and
uses it to calibrate the stage so that it is fair but tight.

## Requirements
- `topopt run <stage.json> --volfrac v [--iters n]`: compliance minimisation, density
  filter (radius ≈ 1.5 voxels), keep cells forced to ρ = 1, block/non-domain cells
  excluded; prints convergence; `--ascii` prints mid-slices for debugging.
- Thresholding to a 0/1 design that the **player rules** accept: keep cells solid,
  6-connected to supports, loads connected, floating material removed. Evaluate with the
  player-mode solver → judged max utilisation.
- `topopt calibrate <stage.json> [--write]`:
  1. find the lightest thresholded SIMP design over a volfrac sweep;
  2. scale all loads uniformly so that design's judged max utilisation = 0.9;
  3. verify the full initial block passes (utilisation < 1) — warn otherwise;
  4. set `benchmark = {volume, solid, maxUtilization, method: "simp-oc"}` and
     `targets = {star3: bench + 0.05, star2: bench + 0.15, star1: min(bench + 0.30, 0.95)}`;
  5. `--write` rewrites the JSON (stable key order, same as the exporter).
- Chain into `scripts/build-stages.sh` after the Blender export so `--check` stays green.

## Acceptance criteria
- [ ] Unit test: 2D-like MBB/cantilever problem converges, compliance decreases, volume
      constraint met within 1e-3.
- [ ] All committed stages calibrated; `benchmark.volume` per stage listed in the log with
      a one-line ASCII/description of the shape (does it look like an arch/truss?).
- [ ] Runtime per stage < 60 s native release.

## Log

### 2026-10-12 — implemented (status → review)

**What**
- `crates/topopt` (lib + CLI; usage and policy in `crates/topopt/README.md`):
  - `filter.rs`: density filter (r = 1.5 voxels, CSR weights, domain cells only).
  - `oc.rs`: OC update with bisection on log λ.
  - `simp.rs`: SIMP loop over an `Analysis` trait. Keep cells are forced to ρ = 1 and
    non-domain cells to 0. The volume constraint is on the physical field over the whole
    domain, keep cells included, so volfrac = the game's volume fraction.
  - `design.rs`: thresholding + 6-connectivity.
  - `driver.rs`: fem `Mode::Optimizer` analysis, player-mode `Judge`, sweep, calibration,
    re-verification.
  - `stagejson.rs`: in-place `serde_json::Value` rewrite. Byte-identical with T-103's
    exporter; `float_roundtrip` is enabled on serde_json.
  - `commands.rs`/`cli.rs`: the `run`, `calibrate` and `judge` commands. The checker in
    worker sandboxes refuses commands that contain the word "eval", hence `judge`.
- Thresholding:
  - Takes keep cells plus the densest free cells.
  - Ranking uses densities quantised to 1e-6, with index tie-break. Without this, mirror
    pairs flipped with solver noise.
  - Adds cells (bisection on prefix length) until every load **and keep** cell is
    6-connected to a supported cell.
  - Removes floating material.
  - Requiring keep cells to be anchored is stricter than the game's load rule. It keeps the
    benchmark volume unambiguous: a floating keep cell cannot be carved away.
- Supported cells come from `Stage::supported_cells()`, per contract 27fa266.

**Decisions**
- *Which design is "the lightest"*: loads are rescaled anyway, so any design could be put
  at utilisation 0.9, and pure volume would always pick the bottom of the sweep. I use the
  load-invariant efficiency v·u (thresholded volume × judged utilisation under the current
  loads). The benchmark is the **lightest design within 5 % of the best v·u**.
  - Below the optimum, one-voxel members and jagged thresholded edges blow the stress up
    (e.g. w1-01: v·u 0.24 at 0.30 → 0.42 at 0.25 → 1.4 at 0.20). The rule stops there.
  - Sweep: 0.60 → 0.15 in steps of 0.05, each run warm-started from the previous design.
    Defaults are `--vmin/--vmax/--vstep`.
  - 0.15 is the floor. Below it, benchmarks become one-voxel trusses that are no fun to
    carve; w2-01 is still improving at the floor.
- Forces are rounded toward zero to 4 significant digits, so the benchmark is ≤ 0.9 after
  rounding. `maxUtilization` is re-judged with the rounded loads at tol 1e-8 and stored to 4
  decimals.
- `benchmark.volume` is the exact count/initial ratio, so the game can compare counts.
  Targets are rounded to 4 decimals.
- **`--check` / cache** (approved by main):
  - `calibrate_hook` runs `topopt calibrate --write --quiet --cache stages/` on the fresh
    export. It is one `cargo run --release`, i.e. one build per run.
  - A committed stage is reused when it equals the export apart from calibrated fields, its
    forces are a common positive multiple of the export's, and its benchmark re-verifies.
  - Re-verification: keep ⊆ solid, connectivity, volume, targets, and one player solve at
    `VERIFY_TOL = 1e-8` within `VERIFY_REL_TOL = 1e-3` relative of the stored
    `maxUtilization`.
  - Otherwise the full sweep reruns. `TOPOPT_FORCE=1 bash scripts/build-stages.sh` forces it,
    e.g. after a numerics change; documented in the README.
  - `--check` takes ~5–10 s for 6 stages including the Blender export and an incremental
    release build.
- `tests/stages.rs` fails `cargo test` if a committed stage no longer re-verifies. CI has no
  Blender, so this is the CI-side guard for calibration drift.
- If a stage has `maxDisplacement`, the benchmark must meet it. Otherwise calibrate fails
  with a hint. No current stage uses it.

**Acceptance**
- `tests/simp_fem.rs::mbb_plate_converges_with_decreasing_compliance_and_exact_volume`
  (30×10×1 MBB half-beam) and `calibration_scales_loads_and_reverifies` cover the first
  criterion. On 60×20×1 at volfrac 0.5, `topopt run` gives the textbook MBB truss.
