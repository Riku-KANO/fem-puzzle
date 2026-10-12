---
id: T-202
title: WASM binding (Session) for the browser worker
status: doing
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
- [ ] `pnpm build:wasm` works from a clean checkout; the Node smoke test passes.
- [ ] Log: wasm size, per-carve timings in Node for W1 and W4-sized grids.

## Log
