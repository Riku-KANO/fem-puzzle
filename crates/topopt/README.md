# topopt: offline SIMP/OC optimiser (T-203)

`topopt` computes the optimiser's own solution (the "benchmark") for every stage with the
same `fem` solver the game uses, built natively. It then calibrates the stage around that
solution: it scales the loads and sets the star targets.

```bash
cargo run -p topopt --release -- run stages/w1-01.json --volfrac 0.3 --ascii   # one SIMP run
cargo run -p topopt --release -- calibrate stages/*.json [--write]             # sweep + calibrate
cargo run -p topopt --release -- judge stages/*.json                           # re-check stored benchmarks
```

## Numerics

- **SIMP**: `E = E_min + ρ^p (E₀ − E_min)` with `p = 3`. The solver runs in `Mode::Optimizer`,
  warm-started across iterations, with relative residual `1e-6`.
- **Density filter**: radius 1.5 voxels, so each cell sees itself plus 18 face and edge
  neighbours. Weights are precomputed and only domain cells take part.
- **Fixed cells**: keep cells (explicit keep, supported cells and load cells) are forced to
  `ρ = 1`. Block cells and other non-domain cells are fixed at `ρ = 0`.
- **Volume constraint**: applies to the physical (filtered) densities over the whole domain,
  keep cells included. `volfrac` therefore means the same as the game's volume fraction.
- **OC update**: move limit 0.2, damping η = ½, bisection on log λ. The run stops when
  `max|Δx| < 0.01` or after `--iters` iterations (default 150).
- **Thresholding**: keep the keep cells plus the densest free cells, up to the requested
  count. If a load or keep cell is not 6-connected to a supported cell, add cells in density
  order until it is (smallest such prefix). Finally drop floating material. The resulting 0/1
  design is judged with the player-mode solver (`judged_max_utilization`, max over cases).

## Calibration policy (`calibrate`)

1. **Sweep**: volfrac 0.60 → 0.15 in steps of 0.05 (`--vmin/--vmax/--vstep`). Each run starts
   from the previous run's design (continuation). Every run is thresholded and judged under
   the stage's current loads.
2. **Pick the benchmark**: loads are rescaled anyway, so utilisation alone cannot rank
   designs. Ranking by volume alone would always pick the bottom of the sweep. The ranking
   uses the load-invariant efficiency `volume × utilisation` instead. The benchmark is the
   **lightest design whose efficiency is within 5 % of the best**. Very light designs lose
   efficiency: one-voxel members and jagged thresholded edges concentrate stress. This rule
   stops the sweep where the optimiser is at its best for the voxel resolution.
3. **Scale all loads** by `0.9 / utilisation`. Each force component is rounded **toward
   zero** to 4 significant digits, so the benchmark never exceeds 0.9 because of rounding.
   The benchmark is then re-judged with the rounded forces at tolerance `1e-8`, and
   `maxUtilization` is stored to 4 decimals.
4. **Full block**: the initial block is judged under the new loads. If its utilisation is
   ≥ 1, `calibrate` prints a warning.
5. **Write the results**: `benchmark = {volume: count / initial count (exact), solid,
   maxUtilization, method: "simp-oc"}`. `targets = {star3: v + 0.05, star2: v + 0.15,
   star1: min(v + 0.30, 0.95)}`, rounded to 4 decimals.
6. **`--write`**: rewrites only `loads[].force` (and `loadCases[].loads[].force`), `targets`
   and `benchmark`. The output format is the exporter's `serde_json::to_string_pretty(Value)`
   plus `"\n"`. Untouched fields round-trip byte-identically (`float_roundtrip`).

## Cache, `--check`, and when to force a recalibration

`scripts/build-stages.sh` runs `calibrate --write --cache stages/` on every fresh export
(the `calibrate_hook`), in both build mode and `--check` mode. A committed stage is reused
when three conditions hold:

- the fresh export equals it in everything except forces, targets and benchmark;
- its forces are a common positive multiple of the fresh ones (relative tolerance 2e-3);
- its benchmark re-verifies.

Re-verification means: the benchmark is inside the domain, keeps every keep cell, and has
its loads and keep cells connected. Its `volume` and `targets` follow the formulas above.
One player-mode solve at **`VERIFY_TOL = 1e-8`** gives a utilisation within
**`VERIFY_REL_TOL = 1e-3` (relative)** of the stored `maxUtilization`, and that utilisation
is ≤ 1.

The calibrated values are then copied over literally, so `--check` stays byte-identical
and fast. It takes about 0.05 s per stage, plus one release build of `topopt`.

These tolerances absorb preconditioner and iteration-count differences, such as multigrid
replacing Jacobi. A real change to the numerics breaks `--check`: element, stress
recovery, keep or connectivity rules. When that happens, recalibrate everything and commit
the result:

```bash
TOPOPT_FORCE=1 bash scripts/build-stages.sh   # full SIMP sweep for every stage (~1–2 min)
```

A stage whose geometry, supports, keep cells or load cells change is recalibrated
automatically on the next build. A change to the load *directions* or *ratios* also
triggers it.
