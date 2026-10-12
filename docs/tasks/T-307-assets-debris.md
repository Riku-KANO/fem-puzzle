---
id: T-307
title: Environment assets in Blender — workbench, jigs, debris pieces (glTF)
status: doing
phase: 1
depends: [T-002]
owns:
  - tools/blender/assets/**
  - apps/web/public/assets/**
verify:
  - bash tools/blender/assets/build.sh
  - bash tools/blender/assets/build.sh --check
---
## Goal
Design doc: Blenderで作るもの (環境・治具・演出素材). Text-only sources (procedural Python run
headless by Blender 5.2 at `/Applications/Blender.app/Contents/MacOS/Blender`, `$BLENDER`
override) that export compressed `.glb` files into `apps/web/public/assets/`.

## Requirements
- Workbench + workshop backdrop (low-poly, lighting baked into vertex colours or a small
  lightmap), clamp and pin supports, weight and hydraulic-cylinder load jigs whose direction
  reads at a glance, 3–4 debris chip variants, a crack decal texture.
- Scale/axes: metres, Y-up glTF; document pivot conventions (e.g. jig origin at the contact
  point, +Y "up" = opposite the load) in `tools/blender/assets/README.md` so T-310 can place them.
- `build.sh` exports all assets (meshopt or Draco compression), `--check` verifies the
  committed glbs are up to date (deterministic export) and total size < 1.5 MB.
- Render 128 px PNG UI icons (brush sizes, undo, load test, submit) with the same scripts.

## Acceptance criteria
- [ ] Headless build works; sizes listed in the log; a preview render PNG per asset
      committed under `tools/blender/assets/previews/` for review.

## Log
