---
id: T-307
title: Workbench environment, jigs and debris (Blender glTF + Rapier)
status: todo
phase: 1
depends: [T-102, T-103]
owns:
  - tools/blender/assets/**
  - apps/web/public/assets/**
  - apps/web/src/render/env/**
touches:
  - apps/web/src/render/scene.ts
  - apps/web/package.json
verify:
  - pnpm --filter @stress-carve/web typecheck
  - pnpm --filter @stress-carve/web build
---
## Goal
Design doc: Blenderで作るもの, 演出 (削ったボクセルは破片になって落ち、作業台に積もる).

## Requirements
- Procedural Blender scripts (text, no binary sources) for the workbench, clamp/pin
  supports and weight/hydraulic load jigs; baked lighting; export `.glb` with
  meshopt/Draco compression via a headless script; keep total < 1.5 MB.
- Debris: carved and floating voxels spawn small fragments simulated by Rapier (WASM,
  lazy-loaded, capped count, sleeping bodies merged into a static pile mesh).

## Acceptance criteria
- [ ] Asset build script runs headless; glb sizes in the log; frame time on W2 in the log.

## Log
