# Phase 0 performance results (Gate 0)

Measured by task T-204. This replaces the desk-estimate table in the design doc
(`docs/削り出しパズル 企画・技術設計書.md` → 性能見積もりと制約). The gate that keeps these
numbers from regressing is `node scripts/bench-gate.mjs`; `scripts/verify.sh full` runs it,
and its limits and baseline are in [`perf-budget.json`](perf-budget.json).

> **Gate 0 verdict: PASS.** A warm-started re-solve after one carve on the W4/W5 grid
> (40×12×12) takes **22 ms** in single-thread WASM. The budget is 500 ms, so there is about
> 23× headroom. W1 (24×8×4) takes **3.1 ms** against a 100 ms budget. Every Phase 0 grid
> passes with multigrid (MGCG), and plain Jacobi-PCG would also pass on this machine.
>
> These are preliminary numbers. They were measured on the T-204 branch before
> integration, with T-201 multigrid at `5a6dcd3`. T-201 is still being tuned, so `main`
> re-runs the gate after integration and refreshes this page and the baseline.

## Measured, replacing the estimate table

WASM in Node, one thread, SIMD128 build, `tol = 1e-4`. *Warm* is the median over 10 random
3×3 carves on the top surface. *Load* is opening the stage: `new Session` (setup) plus the
cold solve.

| grid | elements | DOFs | stage | desk estimate (Jacobi, 1 move) | Jacobi warm (it) | **MGCG warm (it)** | MGCG load |
| --- | ---: | ---: | --- | --- | ---: | ---: | ---: |
| 24×8×4 | 768 | 3,375 | W1 | 0.09–0.18 s | 15 ms (299) | **3.1 ms** (12) | 4.5 ms |
| 32×8×8 | 2,048 | 8,019 | W2 | 0.24–0.47 s | 38 ms (278) | **8.4 ms** (10) | 10.8 ms |
| 32×12×12 | 4,608 | 16,731 | W3 | 0.5–1.1 s | 79 ms (257) | **14 ms** (9) | 21 ms |
| 40×12×12 | 5,760 | 20,787 | W4・W5 | 0.7–1.3 s | 125 ms (295) | **22 ms** (9) | 30 ms |
| 60×20×20 | 24,000 | 80,703 | sandbox (large) | 2.8–5.5 s | 510 ms (321) | **77 ms** (9) | 114 ms |

The desk estimate assumed 100 Jacobi iterations at 0.5–1 GFLOP/s. The measurements differ
on both counts:

- **Jacobi needs about 3× more iterations than assumed.** A warm re-solve after a notch
  takes 260–320 iterations, which is more than the cold solve of the uncarved block
  (140–350). The notch worsens the conditioning, and the warm start barely helps Jacobi.
- **The arithmetic is about 15–30× faster than assumed.** One Jacobi iteration on W4 costs
  0.42 ms in WASM and 0.31 ms native. That is about 16 and 21 GFLOP/s, counting the
  design doc's 1,152 flops per element.
- **The multigrid iteration count does not grow with the grid.** It stays at 9–12
  iterations from 3k to 81k DOFs. The 40×12×12 and 60×20×20 grids use 3 levels.
- **WASM costs about 1.1–1.45× native.** For example, MGCG W4 is 22.1 ms in WASM against
  15.3 ms native, and Jacobi W4 is 125 ms against 91 ms.
- **Post-processing per move is under 0.5 ms on W4.** This covers the utilisation field,
  the displacement copy into a Float32Array, the judged max and the load displacement.
  It is not included in the warm time.

## Full results

`node scripts/bench-gate.mjs --record --markdown` at commit 21ea6b9. Times are in ms.
*Setup* is `Problem::from_stage` plus `Solver::new`, including the multigrid hierarchy and
Galerkin build. *Warm max* is the slowest of the 10 carves.

| grid | target | precond (levels) | setup ms | cold ms (it) | warm median ms (it) | warm max ms | post ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 24×8×4 | native | jacobi (0) | 0.08 | 6.5 (138) | 13.7 (299) | 17.6 | 0.04 |
| 24×8×4 | native | multigrid (2) | 1.32 | 1.6 (10) | 2.6 (12) | 2.7 | 0.04 |
| 24×8×4 | wasm | jacobi (0) | 0.11 | 7.5 (138) | 15.2 (299) | 16.8 | 0.07 |
| 24×8×4 | wasm | multigrid (2) | 2.49 | 2.0 (10) | 3.1 (12) | 3.1 | 0.07 |
| 32×8×8 | native | jacobi (0) | 0.10 | 20.4 (182) | 33.6 (277.5) | 42.8 | 0.10 |
| 32×8×8 | native | multigrid (2) | 3.89 | 4.4 (10) | 6.9 (10) | 7.6 | 0.10 |
| 32×8×8 | wasm | jacobi (0) | 0.13 | 24.7 (182) | 37.9 (277.5) | 67.4 | 0.17 |
| 32×8×8 | wasm | multigrid (2) | 5.54 | 5.3 (10) | 8.4 (10) | 9.5 | 0.17 |
| 32×12×12 | native | jacobi (0) | 0.18 | 52.2 (193) | 64.1 (257) | 73.9 | 0.23 |
| 32×12×12 | native | multigrid (3) | 6.62 | 10.5 (11) | 11.7 (9) | 12.5 | 0.22 |
| 32×12×12 | wasm | jacobi (0) | 0.25 | 65.4 (192) | 79.2 (257) | 87.4 | 0.37 |
| 32×12×12 | wasm | multigrid (3) | 8.50 | 12.2 (11) | 14.2 (9) | 15.8 | 0.34 |
| 40×12×12 | native | jacobi (0) | 0.22 | 72.3 (234) | 91.2 (294.5) | 104.1 | 0.27 |
| 40×12×12 | native | multigrid (3) | 8.38 | 13.8 (11) | 15.3 (9) | 19.4 | 0.28 |
| 40×12×12 | wasm | jacobi (0) | 0.28 | 89.0 (234) | 124.8 (294.5) | 151.3 | 0.47 |
| 40×12×12 | wasm | multigrid (3) | 12.52 | 17.4 (11) | 22.1 (9) | 24.8 | 0.52 |
| 60×20×20 | native | jacobi (0) | 0.84 | 459.5 (354) | 434.8 (321) | 647.3 | 1.19 |
| 60×20×20 | native | multigrid (3) | 36.85 | 59.2 (11) | 63.2 (9) | 75.5 | 1.17 |
| 60×20×20 | wasm | jacobi (0) | 1.05 | 549.9 (354) | 510.4 (321) | 724.1 | 1.79 |
| 60×20×20 | wasm | multigrid (3) | 47.04 | 66.6 (11) | 77.4 (9) | 92.1 | 1.79 |

## Machine and build

| | |
| --- | --- |
| CPU | Apple M5 Pro (15 logical CPUs; the bench uses 1 thread) |
| OS | macOS 26.6.2 (Darwin 25.6.0), arm64 |
| Native | rustc 1.97.1, `--release` profile (opt-level 3, fat LTO, codegen-units 1) |
| WASM | wasm-pack 0.15.0, `+simd128` (`.cargo/config.toml`), `wasm-opt -O3 --enable-simd`. The bench reports 15 functions with v128 locals, so the SIMD is really in the binary |
| WASM size | `fem_wasm_bg.wasm` 254.5 KiB raw, 108.7 KiB gzip |
| Runtime | Node v26.7.0 (V8 14.6) |
| Code | T-204 branch, commit 21ea6b9. It merges T-101 `952ba34`, T-201 `5a6dcd3` and T-202 `96917ae` |

## Method

The native bench is the `crates/fem-bench` crate. The WASM bench is
`scripts/bench-wasm.mjs`, which runs the built `crates/fem-wasm/pkg` through the same
`Session` API the worker uses. The two are mirror images: they use the same stage, the same
carve sequence (mulberry32, seed 42; a unit test pins Rust to the JS output) and the same
timing boundaries.

- **Stage:** a solid cantilever per grid, using the same generator as T-202's node smoke
  test. It is clamped on x-, with a downward load on the top edge at x = nx−1, sized so the
  root bending stress is about half the allowable. E = 70 GPa, ν = 0.33, h = 1 cm, and one
  load case.
- **Cold:** `Solver::new` / `new Session` (setup), then a solve from u = 0. This is the
  median of 3.
- **Warm:** `set_solid(3×3 patch on y = ny−1, false)` plus a warm-started solve. The timing
  includes `begin()`: the active set, masks and incremental multigrid rebuild. Each carve
  is restored and re-solved (untimed) before the next one, so the 10 samples are
  independent. The patch centres are at x ∈ [2, nx−3], which keeps every patch clear of the
  support layer and the load cells.
- **Preconditioner:** both benches request `jacobi` and `multigrid` in turn. The column
  shows which one actually ran: `multigrid` exactly when the solver reports more than 0
  levels. A fallback would show as `multigrid→jacobi`, and the gate fails on it
  (`requireMultigrid`).

Reproduce:

```bash
cargo run -p fem-bench --release                       # native table (all grids, both preconds)
cargo run -p fem-bench --release -- --grid 40x12x12 --precond mg
pnpm build:wasm && node scripts/bench-wasm.mjs         # → .artifacts/bench/wasm.json
node scripts/bench-gate.mjs [--markdown]               # both benches + budget check
```

## The gate

`scripts/bench-gate.mjs` reads `docs/perf-budget.json`. It exits 1 on a violation and 2 if
a bench cannot run.

1. Every timed solve must reach `tol`.
2. `requireMultigrid`: a row that requests multigrid must actually run it.
3. **Limits** apply on any machine: the WASM warm-carve median must be ≤ 100 ms for W1 and
   ≤ 500 ms for W2, W3 and W4/W5. W4/W5 also has a worst-carve limit of ≤ 500 ms and a
   stage-load limit (setup + cold) of ≤ 1 s.
4. **Regression** is checked against the recorded `baseline`. Iteration counts are compared
   on any machine (≤ 1.25× and ≤ 2 iterations more), because they are deterministic.
   Times are compared only when the CPU model matches the baseline's (≤ 2× and ≤ 5 ms
   more). On CI, whose x86 runners differ from the baseline CPU, the gate therefore checks
   iteration counts and absolute limits only.

When a slowdown is intentional, or after hardware or toolchain changes, refresh the baseline
with `node scripts/bench-gate.mjs --record`. It refuses to record results that break a limit.

## If the gate fails

- **A limit fails on a slower machine.** This page's headroom (23× on W4) is from a fast
  Apple Silicon core. Measure on the target low-end device first. If that confirms the
  failure, then in order: show solves progressively (already in the worker protocol); cap
  the stage grids (W4/W5 to 32×12×12); add the SIMD kernels (T-401) and threads (T-402).
- **`requested multigrid but ran jacobi`.** The multigrid wiring in `make_precond` is
  broken. Fix it; do not relax the gate.
- **An iteration regression.** A preconditioner or smoother change made convergence worse.
  Compare `cargo run -p fem-bench --release -- --precond both` before and after the change.
- **A time regression without an iteration regression.** The fine-level kernel got slower,
  for example lost vectorisation or an allocation per iteration.

## Caveats and follow-ups

- **One machine.** Nothing was measured on a phone or an old laptop. The 23× W4 headroom
  should absorb a 3–10× slower device, but this is not verified.
- **Node is not a browser.** Node shares V8 with Chrome; Safari (JSC) and Firefox were not
  measured. Worker `postMessage` and rendering are not included. A follow-up should run the
  same bench in real browsers through the web app's worker.
- **The stage is synthetic, with one load case.** Real W4/W5 stages have two load cases,
  which are solved one after another, so expect about 2× the solve time (about 45 ms) —
  still far inside the budget. Keep cells and blocks change the active set, not the cost
  per iteration.
- **The tol is 1e-4 throughout**, the game default. The offline tools (topopt) use 1e-6.
