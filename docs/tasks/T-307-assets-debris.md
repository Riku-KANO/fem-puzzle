---
id: T-307
title: Environment assets in Blender — workbench, jigs, debris pieces (glTF)
status: review
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
- [x] Headless build works; sizes listed in the log; a preview render PNG per asset
      committed under `tools/blender/assets/previews/` for review.

## Log

### 2026-10-12 — T-307 worker (branch worktree-agent-ada642fcb8f6cd5a5)
**Done.** Text-only procedural sources in `tools/blender/assets/` (`build_assets.py` entry,
`assetkit/` = mesh builder in glTF space, CPU light baker, export/render helpers, PNG I/O;
`assetdefs/` = one module per family + `palette.py`). `build.sh` runs Blender 5.2.2
headless (`-b --factory-startup`, `$BLENDER` override) in ~15 s and replaces
`apps/web/public/assets/` atomically (temp dir → copy). Conventions + placement recipe for
T-310 in `tools/blender/assets/README.md`; machine-readable metadata in each root node's
glTF `extras` and `apps/web/public/assets/manifest.json`.

**Assets (bytes)** — total 911 760 B < 1.5 MB budget:

| file | bytes | verts | notes |
| --- | ---: | ---: | --- |
| workbench.glb | 126 680 | 4 452 | bench + steel test bed 0.72×0.42 (top y=0), vise/mug/notebook; unlit, baked |
| workshop.glb | 376 348 | 12 804 | room 4×3.15×2.73 m, window, pegboard, shelf, cabinet, lamp; unlit, baked |
| jig_clamp.glb | 62 612 | 1 536 | fixed support (plate + hatched block) |
| jig_pin.glb / jig_roller.glb | 25 856 / 37 356 | 576 / 864 | pin, roller |
| jig_riser.glb | 18 900 | 404 | stand, `riser_column` unit height |
| jig_cylinder.glb | 55 388 | 1 288 | pusher, `cylinder_rod` travel 0.04 |
| jig_weight.glb | 48 836 | 1 120 | hanging weights (pull) |
| jig_spreader.glb | 3 096 | 44 | unit load-spreader plate (scale to patch) |
| debris.glb | 26 344 | 552 | chip_0..3 convex (centroid origin, mass in extras) + swarf_0 |
| crack_decal.png / crack_tile.png | 22 444 / 13 888 | | 512² centred burst / 256² tileable mask |
| icons/*.png (7) | 87 688 | | 128 px brush-1/3/5, undo, redo, load-test, submit |
| manifest.json | 6 329 | | |

Previews (15 PNG, 1.5 MB, `tools/blender/assets/previews/`): one per asset + `scene_w1`
/ `scene_w2` (jigs placed with the README rules exactly as w1-01 / w2-01 need) +
`icons.png`, `crack_tile.png`.

**Decisions**
- Plain `.glb`, no Draco/meshopt (orchestrator: < 1.5 MB → simpler loader). Blender 5.2's
  exporter also offers `EXT_meshopt_compression` (`export_meshopt_compression_enable`) if
  the budget ever gets tight — the web side would then need `MeshoptDecoder`.
- Lighting baked into `COLOR_0` (linear) by a deterministic BVH ray-caster (AO + lamp +
  ceiling tubes + window sun/sky), exported with `KHR_materials_unlit` →
  `MeshBasicMaterial`; render with `toneMapped = false`. Jigs/debris are PBR with mild AO
  in the vertex colours (metals want an env map, e.g. RoomEnvironment).
- Frames: supports +Y = outward face normal; loads −Y = F̂ (cylinder pushes from the
  face with normal −F̂, weight hangs from the underside); origin = contact-patch centre;
  bench frame origin = bed top, placed at (domainCentreX, −0.16, domainCentreZ) in the
  stage frame (agreed with T-102). All current stage loads are top-face, downward, wider
  than the pad → spreader + cylinder.
- Determinism: fixed seeds; exporter output is byte-stable; Blender writes render
  date/time/stats into PNG `tEXt` chunks → stripped after every render; icons rendered with
  Cycles CPU (seed 0, no denoiser) and previews with EEVEE are byte-stable on this
  machine. `--check` byte-compares glb + crack PNGs + manifest, checks icons exist at
  128×128 (rendered, so not byte-compared), flags stale files, enforces the 1.5 MB budget
  and parses every glb with three.js r186 `GLTFLoader` (`verify_three.mjs`; checks root
  names, listed nodes, vertex colours, unlit vs PBR, bounds vs manifest).
- Exporter quirk: `export_image_format="NONE"` silently drops `COLOR_0` on Principled
  materials (5.2 exporter only reads the colour-attribute link when images are enabled)
  → use `AUTO` (there are no images anyway).

**Messages**: conventions sent to T-102 (placeholder envelopes match) and to T-302
(crack textures + load-jig pivots/travel; T-302 currently draws procedural cracks and
animates arrows along −F̂, compatible with these pivots).

**Follow-ups**
- `scripts/verify.sh fast` gained a Blender-gated `stages-check`; an analogous
  `assets-check` step (`bash tools/blender/assets/build.sh --check`, skipped without
  Blender) would keep the assets honest — `scripts/verify.sh` is not in T-307's `owns`.
- T-310: load jigs via the README recipe (`manifest.json` lists files/nodes); debris
  colliders are in `workbench` extras; consider a ShadowMaterial plane on the bed for
  the part's realtime shadow (baked surfaces are unlit).
- T-102/T-304 may use `icons/*.png` in the toolbar (transparent, light-on-dark style).
- `--check` is exact only with the same Blender 5.2.x build/platform (build.sh warns on
  other versions); CI has no Blender, so it is a local gate like `stages-check`.

