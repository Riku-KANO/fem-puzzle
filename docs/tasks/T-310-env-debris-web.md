---
id: T-310
title: Workshop environment, jigs and debris physics in the web view (Rapier)
status: doing
phase: 1
depends: [T-102, T-307]
owns:
  - apps/web/src/render/env/**
touches:
  - apps/web/src/render/scene.ts
  - apps/web/package.json
verify:
  - pnpm --filter @stress-carve/web typecheck
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web build
---
## Goal
Design doc: 演出 (削ったボクセルは小さな破片になって落ち、作業台に積もる).

## Requirements
- Load the T-307 glbs (lazy), place jigs at stage supports/loads (replacing placeholders).
- Debris: carved and floating voxels spawn chips simulated by Rapier (WASM, lazy-loaded,
  capped count, sleeping bodies merged into a static pile); independent of the FEM solve.

## Acceptance criteria
- [ ] Frame time on a W2 stage while carving logged; no main-thread stalls > 50 ms from debris.

## Log
