---
id: T-302
title: Load test (Space): exaggerated deformation animation and collapse feedback
status: doing
phase: 1
depends: [T-202]
owns:
  - apps/web/src/render/deform/**
touches:
  - apps/web/src/App.svelte
  - apps/web/src/render/scene.ts
verify:
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web typecheck
---
## Goal
Design doc: 操作 (載荷テスト), 演出, 応力の可視化 (変形表示).

## Requirements
- Space / toolbar button plays: load jig descends, deformation ramps 0 → scale with the
  nodal displacement from the last result; auto scale so the max displacement is ~10 % of
  the smallest domain extent (show the factor, e.g. ×250).
- Vertex displacement in the voxel mesh (trilinear from nodal values — mesh vertices are
  grid nodes, so it is a direct lookup).
- If utilisation > 1 anywhere: crack decals / flashing, then over-stressed elements break
  off in order of utilisation (purely visual; the state is restored afterwards).
- Respect `prefers-reduced-motion`.

## Acceptance criteria
- [ ] Unit test: displacement lookup for mesh vertices matches nodal indices.
- [ ] Animation runs at 60 fps on W2 grids on this machine (log the measurement).

## Log
