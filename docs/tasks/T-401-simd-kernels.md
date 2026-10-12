---
id: T-401
title: WASM SIMD f64x2 element kernels
status: todo
phase: 2
depends: [T-204]
owns:
  - crates/fem/src/kernels/**
verify:
  - cargo test -p fem
  - pnpm build:wasm
  - node scripts/bench-gate.mjs
---
## Goal
Design doc: SIMDとスレッド (要素ループの行列ベクトル積をWASM SIMD f64x2で). Speed up the
finest-level matrix-free product, which dominates MGCG time.

## Requirements
- `crates/fem/src/kernels/`: element `Ke1 · x_e` (24×24) with `core::arch::wasm32` f64x2
  under `cfg(target_arch = "wasm32", target_feature = "simd128")`, scalar fallback for native
  (or `std::simd`-free portable code that LLVM auto-vectorises — measure both).
- Exploit structure: `Ke1` symmetric; consider structure-of-arrays gathers per element block.
- Bit-for-bit is not required, but results must agree with the scalar path to 1e-12 relative.

## Acceptance criteria
- [ ] Unit test comparing SIMD vs scalar kernels on random inputs (wasm via the node smoke).
- [ ] Measured speed-up of a warm carve on 40×12×12 in WASM recorded in docs/perf-results.md;
      perf gate green.

## Log
