---
id: T-203
title: Offline SIMP/OC optimiser — benchmark solutions, load calibration, star targets
status: done
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
- [x] Unit test: 2D-like MBB/cantilever problem converges, compliance decreases, volume
      constraint met within 1e-3.
- [x] All committed stages calibrated; `benchmark.volume` per stage listed in the log with
      a one-line ASCII/description of the shape (does it look like an arch/truss?).
- [x] Runtime per stage < 60 s native release.

## Log

### 2026-10-12 — implemented (status → review)

Last merged: main a527280 (T-201 done, multigrid default), which includes T-101 60cc6c6
(review fixes 0e4fdd6), T-103 40e999b and contract 27fa266. Calibrated stages are committed
in cdfb1c2. A forced recalibration with multigrid gives byte-identical files.

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

**Calibrated stages** (final, `TOPOPT_FORCE=1 bash scripts/build-stages.sh`, M-series Mac,
Jacobi PCG, single thread). Volume is a fraction of the initial solid. The projections in
`topopt judge stages/*.json` show solid cells per z-column.

| stage | bench volume (cells) | loads (N) | full block util | ★3/★2/★1 | sweep time | shape |
| --- | --- | --- | --- | --- | --- | --- |
| w1-01 | 0.2995 (230/768) | −12290 | 0.443 | 0.3495/0.4495/0.5995 | 6.3 s | Truss with full-depth top and bottom chords. The Warren diagonals sit in the two outer z-plates; the inner plates keep only the chords. |
| w1-02 | 0.2005 (154/768) | −23030 | 0.414 | 0.2505/0.3505/0.5005 | 2.4 s | Two-member truss: a top tie from the wall to the mid-span load and one inclined strut down to the wall foot. The rest is empty. |
| w1-03 | 0.3503 (269/768) | −12340 | 0.445 | 0.4003/0.5003/0.6503 | 10.2 s | Truss that uses the keep pillar as a vertical post. The wall panel has diagonals in the outer plates; a strut runs from the pillar foot to the tip in the inner plates. |
| w2-01 | 0.1499 (307/2048) | −35950 | 0.181 | 0.1999/0.2999/0.4499 | 30.7 s | Tied (bowstring) arch in the two outer z-plates, from both bearings up to the centre load, with a bottom tie. The middle is empty. |
| w2-02 | 0.2998 (614/2048) | 2 × −57330 | 0.526 | 0.3498/0.4498/0.5998 | 28.7 s | Trapezoidal truss: top chord between the two loads, inclined struts to the bearings, full-width bottom tie, thicker in the inner plates. |
| w2-03 | 0.4499 (691/1536) | −169000 | 0.657 | 0.4999/0.5999/0.7499 | 11.8 s | Keep deck (the load layer) carried by two inclined legs per side from the abutments, past the tunnel block, plus short end posts. |

- **Sweep efficiency v·u**: minima at 0.25–0.35 for w1-01, w1-03 and w2-02. 0.45 for w2-03
  (its deck keep layer alone is 17 % of the solid). w1-02 and w2-01 keep improving down to
  0.20 and 0.15 respectively.
- **Runtime** (native release; the table's sweep times are the Jacobi run):
  - Jacobi: every stage under 31 s; full forced build of 6 stages 94 s including Blender.
  - Multigrid (T-201, now default): 3.4/1.9/3.7/10.4/8.7/6.6 s per stage; full forced build
    38 s.
  - Results are identical: same bitmasks, loads, targets and maxUtilization.
  - `--check` takes ~5–9 s with the cache.
- **Determinism**: same code, same machine → identical files. Across solver revisions, a full
  recalibration can swap a near-tied mirror voxel (seen in w2-01/w2-03 between T-101
  revisions) without changing volume or utilisation. That is why `--check` relies on the
  cache, not on re-running SIMP.
- **Verify**:
  - `cargo test -p topopt`: 25 tests.
  - clippy is clean.
  - `build-stages.sh --check` is up to date.
  - `pnpm build:wasm && node crates/fem-wasm/tests/node-smoke.mjs` passes; uncarved
    utilisations 0.443/0.414/0.445/0.181/0.526/0.657 match the table.
  - `verify.sh fast` is green.

**Follow-ups**
- **W3–W5 grids (40×12×12)**: with multigrid, expect well under 60 s/stage (W2 is ≤ 10 s).
  Re-measure when T-406 adds stages. After a numerics change, if `--check` or
  `tests/stages.rs` complain, run `TOPOPT_FORCE=1 bash scripts/build-stages.sh`. The
  Jacobi→MG swap stayed within the rel. tol 1e-3.
- **Game side (T-301/T-304)**: compare the player's solid *count* with
  `popcount(benchmark.solid)` for "beat the algorithm". `benchmark.volume` is exactly
  count/initial, but float comparison is brittle.
- **w2-01** is very forgiving: the full block is at 18 % utilisation and the benchmark is a
  15 % tied arch. If playtests find it too loose, raise `--vmin` for that stage or change its
  supports. `calibrate` has no per-stage override yet; one could be added as a `stages/src`
  scene prop if needed. That needs a T-103 exporter field, and it is not a contract change if
  kept out of the JSON.
- **Floating keep cells**: the benchmark requires keep cells to be anchored (stricter than
  the load rule). If T-301 decides floating keep cells are allowed or dropped, this is still
  safe.

