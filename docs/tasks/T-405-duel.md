---
id: T-405
title: Algorithm duel: live SIMP run alongside the player
status: todo
phase: 2
depends: [T-203, T-301]
owns:
  - apps/web/src/modes/duel/**
  - crates/fem-wasm/src/simp.rs
verify:
  - cargo test -p fem-wasm
  - pnpm --filter @stress-carve/web test
---
## Goal
Design doc: アルゴリズム対決 — SIMP solves the same stage live next to the player.

## Requirements
- `crates/fem-wasm/src/simp.rs`: incremental SIMP/OC `step()` API reusing `crates/topopt`
  logic (move shared code into a library module of topopt or fem — coordinate with owners).
- Second worker runs SIMP; split view shows its density field (thresholded preview) and volume
  over time; the race ends when the player submits or SIMP converges.

## Acceptance criteria
- [ ] SIMP in WASM reproduces the offline benchmark volume within 0.02 on W1 stages.

## Log
