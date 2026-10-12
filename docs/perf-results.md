# Phase 0 performance results (Gate 0)

Measured by task T-204. This replaces the desk-estimate table in the design doc
(`docs/削り出しパズル 企画・技術設計書.md` → 性能見積もりと制約). The gate that keeps these
numbers from regressing is `node scripts/bench-gate.mjs`; `scripts/verify.sh full` runs it,
and its limits and baseline are in [`perf-budget.json`](perf-budget.json).

> **Gate 0 verdict: PASS.** A warm-started re-solve after one carve on the W4/W5 grid
> (40×12×12) takes **14 ms** in single-thread WASM. The budget is 500 ms, so there is about
> 35× headroom. W1 (24×8×4) takes **2.3 ms** against a 100 ms budget. Every Phase 0 grid
> passes with multigrid (MGCG), and plain Jacobi-PCG would also pass on this machine.
>
> The numbers were measured on `main` at `a527280`, with T-101, T-201 and T-202 all
> integrated, plus the T-204 bench. The machine had other build jobs running (load average
> about 5), so expect ±20 % run-to-run.
>
> **Known issue:** the native build of the fine-level kernel got about 2× slower with T-201's
> last mg change. WASM is not affected. See [Known issue](#known-issue-native-codegen-regression).

## Measured, replacing the estimate table

WASM in Node, one thread, SIMD128 build, `tol = 1e-4`. *Warm* is the median over 10 random
3×3 carves on the top surface. *Load* is opening the stage: `new Session` (setup) plus the
cold solve.

| grid | elements | DOFs | stage | desk estimate (Jacobi, 1 move) | Jacobi warm (it) | **MGCG warm (it)** | MGCG load |
| --- | ---: | ---: | --- | --- | ---: | ---: | ---: |
| 24×8×4 | 768 | 3,375 | W1 | 0.09–0.18 s | 16 ms (299) | **2.3 ms** (12) | 4.4 ms |
| 32×8×8 | 2,048 | 8,019 | W2 | 0.24–0.47 s | 38 ms (278) | **6.5 ms** (10) | 9.8 ms |
| 32×12×12 | 4,608 | 16,731 | W3 | 0.5–1.1 s | 78 ms (257) | **9.3 ms** (9) | 19 ms |
| 40×12×12 | 5,760 | 20,787 | W4・W5 | 0.7–1.3 s | 117 ms (295) | **14 ms** (9) | 27 ms |
| 60×20×20 | 24,000 | 80,703 | sandbox (large) | 2.8–5.5 s | 510–670 ms (321) | **54 ms** (9) | 116 ms |

The desk estimate assumed 100 Jacobi iterations at 0.5–1 GFLOP/s. The measurements differ
on both counts:

- **Jacobi needs about 3× more iterations than assumed.** A warm re-solve after a notch
  takes 260–320 iterations, which is more than the cold solve of the uncarved block
  (140–350). The notch worsens the conditioning, and the warm start barely helps Jacobi.
- **The arithmetic is about 15–30× faster than assumed.** One Jacobi iteration on W4 costs
  0.40 ms in WASM, or about 17 GFLOP/s counting the design doc's 1,152 flops per element.
  Native cost 0.31 ms per iteration before the regression described below.
- **The multigrid iteration count does not grow with the grid.** It stays at 9–12
  iterations from 3k to 81k DOFs. The 40×12×12 and 60×20×20 grids use 3 levels.
  Rebuilding the hierarchy after a carve is incremental, and its cost is included in the
  warm time.
- **WASM was 1.1–1.45× slower than native** at T-201 `5a6dcd3`: MGCG W4 took 22.1 ms
  against 15.3 ms native. After T-201's final kernel change, WASM MGCG W4 dropped to 14 ms,
  but native rose to 21 ms. WASM is now *faster* than native; see the known issue below.
- **Post-processing per move is under 0.5 ms on W4.** This covers the utilisation field,
  the displacement copy into a Float32Array, the judged max and the load displacement.
  It is not included in the warm time.

## Full results

`node scripts/bench-gate.mjs --record --markdown` on `main` `a527280` plus the T-204
branch. These are the numbers recorded as the baseline. Times are in ms.
*Setup* is `Problem::from_stage` plus `Solver::new`, including the multigrid hierarchy and
Galerkin build. *Warm max* is the slowest of the 10 carves.

| grid | target | precond (levels) | setup ms | cold ms (it) | warm median ms (it) | warm max ms | post ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 24×8×4 | native | jacobi (0) | 0.07 | 12.8 (138) | 26.7 (299) | 27.1 | 0.04 |
| 24×8×4 | native | multigrid (2) | 1.32 | 3.0 (10) | 3.7 (12) | 4.0 | 0.04 |
| 24×8×4 | wasm | jacobi (0) | 0.14 | 7.8 (138) | 16.2 (299) | 17.8 | 0.10 |
| 24×8×4 | wasm | multigrid (2) | 2.39 | 2.0 (10) | 2.3 (12) | 2.5 | 0.07 |
| 32×8×8 | native | jacobi (0) | 0.09 | 43.5 (182) | 67.1 (277.5) | 86.5 | 0.10 |
| 32×8×8 | native | multigrid (2) | 3.90 | 8.1 (10) | 9.5 (10) | 10.4 | 0.10 |
| 32×8×8 | wasm | jacobi (0) | 0.16 | 24.9 (182) | 38.0 (277.5) | 51.5 | 0.18 |
| 32×8×8 | wasm | multigrid (2) | 5.24 | 4.6 (10) | 6.5 (10) | 7.3 | 0.16 |
| 32×12×12 | native | jacobi (0) | 0.19 | 105.0 (193) | 139.0 (257) | 149.1 | 0.22 |
| 32×12×12 | native | multigrid (3) | 8.06 | 21.5 (11) | 17.3 (9) | 20.6 | 0.23 |
| 32×12×12 | wasm | jacobi (0) | 0.23 | 62.1 (192) | 77.9 (257) | 85.0 | 0.34 |
| 32×12×12 | wasm | multigrid (3) | 8.45 | 10.5 (11) | 9.3 (9) | 10.5 | 0.34 |
| 40×12×12 | native | jacobi (0) | 0.21 | 158.9 (234) | 199.1 (294.5) | 228.8 | 0.27 |
| 40×12×12 | native | multigrid (3) | 8.15 | 24.8 (11) | 21.0 (9) | 25.1 | 0.28 |
| 40×12×12 | wasm | jacobi (0) | 0.26 | 92.0 (234) | 117.3 (294.5) | 158.0 | 0.43 |
| 40×12×12 | wasm | multigrid (3) | 11.45 | 15.1 (11) | 14.1 (9) | 16.6 | 0.44 |
| 60×20×20 | native | jacobi (0) | 0.73 | 1000.4 (354) | 900.9 (321) | 1409.9 | 1.15 |
| 60×20×20 | native | multigrid (3) | 38.16 | 105.3 (11) | 96.5 (9) | 132.3 | 1.20 |
| 60×20×20 | wasm | jacobi (0) | 0.96 | 632.6 (354) | 667.2 (321) | 895.0 | 2.05 |
| 60×20×20 | wasm | multigrid (3) | 51.94 | 63.6 (11) | 54.2 (9) | 64.8 | 1.89 |

## Machine and build

| | |
| --- | --- |
| CPU | Apple M5 Pro (15 logical CPUs; the bench uses 1 thread) |
| OS | macOS 26.6.2 (Darwin 25.6.0), arm64 |
| Native | rustc 1.97.1, `--release` profile (opt-level 3, fat LTO, codegen-units 1) |
| WASM | wasm-pack 0.15.0, `+simd128` (`.cargo/config.toml`), `wasm-opt -O3 --enable-simd`. The bench reports 15 functions with v128 locals, so the SIMD is really in the binary |
| WASM size | `fem_wasm_bg.wasm` 254.5 KiB raw, 108.7 KiB gzip |
| Runtime | Node v26.7.0 (V8 14.6) |
| Code | `main` `a527280` (T-101, T-201 and T-202 integrated) merged into the T-204 branch |

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
a bench cannot run. A full run takes about 45 s; half of that is the Jacobi reference rows
on 60×20×20.

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

- **A limit fails on a slower machine.** This page's headroom (35× on W4) is from a fast
  Apple Silicon core. Measure on the target low-end device first. If that confirms the
  failure, then in order: show solves progressively (already in the worker protocol); cap
  the stage grids (W4/W5 to 32×12×12); add the SIMD kernels (T-401) and threads (T-402).
- **`requested multigrid but ran jacobi`.** The multigrid wiring in `make_precond` is
  broken. Fix it; do not relax the gate.
- **An iteration regression.** A preconditioner or smoother change made convergence worse.
  Compare `cargo run -p fem-bench --release -- --precond both` before and after the change.
- **A time regression without an iteration regression.** The fine-level kernel got slower,
  for example lost vectorisation or an allocation per iteration. The known issue below is
  an example.

## Known issue: native codegen regression

The gate caught a native-only slowdown when T-201's final commit `b97e3cd` was merged.
`b97e3cd` brought "faster element loops" in `crates/fem/src/mg/level.rs`.

On native aarch64 (fat LTO), the Jacobi-PCG path got about **2.1×** slower:
`Operator::apply`, `pcg.rs`, `precond.rs` and `hex8.rs` did not change, yet W4 warm went
from 91 ms to 199 ms and 60×20×20 cold went from 460 ms to 1000 ms. MGCG got about 1.4×
slower natively: W4 warm went from 15.3 ms to 21 ms. The same code compiled to WASM got
*faster* (MGCG W4 from 22 ms to 14 ms) and its iteration counts are unchanged.

Bisect: putting `crates/fem/src/mg/` back at its `5a6dcd3` version restores the native
numbers (W4 Jacobi warm 102 ms). Forcing `#[inline(always)]` on `hex8::mul24` does not.
`sample` shows the time inside a non-inlined `fem::operator::Operator::apply`. This points
to an LTO inlining or code-layout interaction between `Operator::apply` and the
near-identical `mg::Level::apply` loop, not to a source change on the Jacobi path.

The game ships WASM, so the player is not affected. Native matters for `topopt` (T-203)
throughput and for the T-401 SIMD work. The baseline was recorded **after** the regression,
so the gate is green. The pre-regression native baseline is the version of
`docs/perf-budget.json` at commit `db4aee4`. Follow-up: profile both `apply` loops; for
example, share one `#[inline(always)]` element-kernel function, or mark the hot loops
`#[inline(never)]` and compare.

## Caveats and follow-ups

- **One machine.** Nothing was measured on a phone or an old laptop. The 35× W4 headroom
  should absorb a 3–10× slower device, but this is not verified.
- **Node is not a browser.** Node shares V8 with Chrome; Safari (JSC) and Firefox were not
  measured. Worker `postMessage` and rendering are not included. T-205 (web WASM backend)
  will log in-browser per-carve timings in the format requested in its log; fold them in
  here.
- **The stage is synthetic, with one load case.** Real W4/W5 stages have two load cases,
  which are solved one after another, so expect about 2× the solve time (about 30 ms) —
  still far inside the budget. Keep cells and blocks change the active set, not the cost
  per iteration.
- **The tol is 1e-4 throughout**, the game default. The offline tools (topopt) use 1e-6.
