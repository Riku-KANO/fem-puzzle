---
id: T-301
title: Judgement, submission, stars and benchmark comparison
status: todo
phase: 1
depends: [T-202, T-203]
owns:
  - apps/web/src/game/judge/**
  - apps/web/src/ui/result/**
touches:
  - apps/web/src/App.svelte
  - apps/web/src/ui/Toolbar.svelte
verify:
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web typecheck
---
## Goal
Design doc: 判定条件 / スコア / 1ステージの流れ step 5.

## Requirements
- Pure, unit-tested `judge(stage, solid, result)` → per-rule pass/fail: strength (judged max
  utilisation ≤ 1 for every load case), connectivity (`loadsConnected`), stiffness
  (`maxDisplacement`, if set), keep intact. Volume fraction and stars from `targets`.
- Submit button enabled only when the latest result is converged and for the current `seq`.
- Result screen: stars, volume %, per-rule status, "最適化解との差" (volume − benchmark),
  special badge when the player beats the benchmark; toggle to overlay the benchmark solid
  semi-transparently in the 3D view (design doc 演出: 最適化解と半透明で重ねて比較).

## Acceptance criteria
- [ ] Unit tests for every rule including multi-case stages and edge cases (no benchmark).
- [ ] Manual check in `pnpm dev` described in the log (screenshot if browser tools exist).

## Log
