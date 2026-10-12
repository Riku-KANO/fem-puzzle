---
id: T-202
title: WASM binding (Session) for the browser worker
status: review
phase: 0
depends: [T-101]
owns:
  - crates/fem-wasm/**
verify:
  - pnpm build:wasm
  - cargo test -p fem-wasm
  - node crates/fem-wasm/tests/node-smoke.mjs
---
## Goal
Expose the solver to the browser through the `Session` API in
`docs/specs/worker-protocol.md`. The web-side backend that uses it is T-205.

## Requirements
- `crates/fem-wasm`: `Session` exactly as specified; errors as `JsError`; typed-array returns
  (`Float32Array::from` is fine). Keep release `wasm-opt` on; report `.wasm` size (raw/gzip).
- `crates/fem-wasm/tests/node-smoke.mjs`: loads `pkg/` in Node with `initSync({ module: bytes })`,
  builds a Session from a stage JSON (a committed `stages/*.json` if present, else an inline
  24×8×4 cantilever), carves a few voxels, iterates to convergence in chunks, and checks
  utilisation/displacement sanity (finite, non-zero, load point moves along the force).
  Prints per-solve timings for 24×8×4 and 40×12×12 (WASM, single thread).
- Native `cargo test -p fem-wasm` for the pure-Rust parts (option parsing, conversions).

## Acceptance criteria
- [x] `pnpm build:wasm` works from a clean checkout; the Node smoke test passes.
- [x] Log: wasm size, per-carve timings in Node for W1 and W4-sized grids.

## Log

### 2026-10-12 — implementation (early start against T-101 skeleton)
- **T-101 commit last merged: `8d44d07`** (API skeleton, Jacobi PCG; validation still in
  progress on their side). Branch must be integrated after T-101. Did not merge T-103; the
  smoke test reads `stages/*.json` at run time (or `FEM_SMOKE_STAGES=<dir>`).
- Layout: `src/options.rs` (optionsJson parsing), `src/convert.rs` (f32/u32 conversion,
  atomic `set_solid` validation, case-index checks), `src/core.rs` (`SessionCore`: plain
  Rust over `fem::Solver`, natively tested), `src/lib.rs` (1:1 wasm-bindgen `Session`
  wrapper: `JsError`, `Vec<f32>`/`Vec<u32>` → fresh `Float32Array`/`Uint32Array` copies,
  plain-object `StepStatus` + TS interface via `typescript_custom_section`, camelCase
  param names as in the spec, `console.error` panic hook on wasm32).
  `cargo test -p fem-wasm`: 14 native tests. Added `serde`/`serde_json` (workspace deps)
  to fem-wasm → 2-line `Cargo.lock` change.
- Decisions (told T-102 for T-205):
  - optionsJson = `SolverOptionsMsg` as-is; `""`/`"{}"`/`"null"` = defaults; unknown and
    JS-side keys (`progressEveryMs`, `backend`) ignored. Defaults: **tol 1e-4** (game value
    from the protocol, not fem's 1e-6), maxIters 20 000 per case, preconditioner
    `multigrid` (fem falls back to Jacobi until T-201). Bad values throw.
  - `StepStatus.iterations` is cumulative since `begin()` over all cases (fem semantics);
    `rel_residual` is the max over cases once done ⇒ `converged = done && rel_residual <= tol`.
  - `set_solid` is idempotent; a batch is rejected as a whole (nothing applied) on an
    out-of-range index, carving a protected element (keep incl. implicit support/load
    cells) or restoring an element outside the initial solid set. `iterate` begins
    implicitly after `set_solid` (fem behaviour).
- `node crates/fem-wasm/tests/node-smoke.mjs`: inline 24×8×4 cantilever suite (cold solve,
  3×3 carve, floating island, cut that disconnects the load → `loads_connected=false`, no
  NaN, restore matches cold solve within 1 %, error paths keep the session usable), every
  committed stage (cold + 3 carves, prints uncarved judged max utilisation), then .wasm size
  and timings. Ran it against T-103's six stages (`d645ca5`) via `FEM_SMOKE_STAGES`: all
  pass (uncarved max util w1-01 0.108, w1-02 0.108, w1-03 0.144, w2-01 0.101, w2-02 0.110,
  w2-03 0.047).
- **wasm size** (release, wasm-opt -O3 with SIMD flags, SIMD instructions present):
  `fem_wasm_bg.wasm` **210.2 KiB raw / 91.6 KiB gzip -9**. Clean build
  (`rm -rf pkg target/wasm32-unknown-unknown; pnpm build:wasm`) ≈ 7.5 s with the
  wasm-bindgen CLI cached (≈ 34 s on the very first run, which installs it).
- **Timings** (Node 26, Apple Silicon, WASM single thread, Jacobi PCG, tol 1e-4; warm =
  3×3 top-surface carve, median/max of 10, includes set_solid + begin + iterate):

  | grid | elems | DOFs | cold ms (it) | warm carve med / max ms (it) | readback ms |
  | --- | --- | --- | --- | --- | --- |
  | 24×8×4 (W1) | 768 | 3 375 | 7.1 (138) | 15.4 / 16.0 (299) | 0.08 |
  | 40×12×12 (W4) | 5 760 | 20 787 | 88.2 (234) | 117.4 / 137.6 (≈314) | 0.46 |

  Well inside the Phase 0 budget (≤ 0.5 s for W4). Observation sent to T-101: with Jacobi
  the carved geometry needs ~2× the iterations of the full block and the warm start saves
  little (24×8×4 3×3 carve: warm 298 vs cold-on-carved 295; 40×12×12: 337 vs 440).
- Follow-ups: (1) re-run `pnpm build:wasm && node crates/fem-wasm/tests/node-smoke.mjs`
  after T-101's final commit / T-201 multigrid land (the test asserts `levels >= 0` only,
  so MG needs no change here); (2) T-204 can reuse the smoke test's cantilever generator
  and bench loop for `scripts/bench-wasm.mjs`; (3) if bundle size matters later, the bulk
  is serde_json + core::fmt (not investigated, 92 KiB gzip seems fine).
