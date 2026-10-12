---
id: T-402
title: Multithreaded solver (graph colouring + wasm-bindgen-rayon, COOP/COEP)
status: todo
phase: 2
depends: [T-401]
owns:
  - crates/fem/src/parallel/**
  - crates/fem-wasm/**
verify:
  - cargo test -p fem
  - pnpm build:wasm
  - node scripts/bench-gate.mjs
---
## Goal
Design doc: 並列化 (Web Worker + wasm-bindgen-rayon, SharedArrayBuffer, COOP/COEP).

## Requirements
- 8-colour element colouring (parity of x, y, z) so each colour's elements share no nodes;
  parallel scatter-add per colour with rayon; same for smoother/residual loops.
- wasm-bindgen-rayon needs nightly + `-Z build-std=panic_abort,std` and
  `+atomics,+bulk-memory,+mutable-globals`: add a separate build profile/script
  (`pnpm build:wasm:mt`), keep the single-thread build as the baseline and fallback
  (design doc リスク: ブラウザ差). Pin the nightly in a dedicated toolchain file for that build.
- Runtime: feature-detect `crossOriginIsolated` and SharedArrayBuffer; choose thread count
  `min(navigator.hardwareConcurrency - 1, 4)`.

## Acceptance criteria
- [ ] Results identical (to tolerance) between 1 and N threads.
- [ ] Speed-up on 40×12×12 and 60×20×20 recorded; single-thread path still green everywhere.

## Log
