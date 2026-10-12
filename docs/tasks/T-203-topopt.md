---
id: T-203
title: Offline SIMP/OC optimiser — benchmark solutions, load calibration, star targets
status: todo
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
