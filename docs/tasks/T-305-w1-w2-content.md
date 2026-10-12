---
id: T-305
title: W1 tutorial flow and full W1/W2 stage set (8–10 each)
status: todo
phase: 1
depends: [T-203, T-301]
owns:
  - stages/src/**
  - apps/web/src/ui/tutorial/**
touches:
  - stages/*.json
  - apps/web/src/App.svelte
verify:
  - bash scripts/build-stages.sh --check
  - pnpm --filter @stress-carve/protocol test
---
## Goal
Design doc: ステージ設計 (W1 工房入門, W2 橋), リスク (応力表示の難しさ → W1をチュートリアル化).

## Requirements
- 8–10 stages per world with a difficulty ramp using the three knobs (target volume,
  allowable margin, keep/block obstacles); avoid "memorise the bone shape" (multiple load
  positions, obstacles).
- W1 tutorial overlay: utilisation %, highlight low-stress regions as hints, step-by-step
  first stage.
- Every stage calibrated by `topopt` and solvable: the benchmark design passes `judge`.

## Acceptance criteria
- [ ] A test asserts every stage's benchmark passes the judge rules with the real solver.

## Log
