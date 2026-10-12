---
id: T-308
title: Minimum thickness (2 voxels) warning overlay
status: doing
phase: 1
depends: [T-102]
owns:
  - apps/web/src/game/thickness/**
touches:
  - apps/web/src/App.svelte
verify:
  - pnpm --filter @stress-carve/web test
---
## Goal
Design doc: リスク (ボクセルの粗さ → 最小肉厚2ボクセルのルール、下回ると警告表示).

## Requirements
- Detect solid voxels belonging to members thinner than 2 voxels (e.g. a voxel with
  empty/void neighbours on both sides along some axis) and show an unobtrusive warning tint
  plus a HUD count. Not a failure rule.

## Acceptance criteria
- [ ] Unit tests on hand-made patterns (1-thick plate, 2-thick plate, diagonal strut).

## Log
