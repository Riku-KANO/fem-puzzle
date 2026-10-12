---
id: T-308
title: Minimum thickness (2 voxels) warning overlay
status: review
phase: 1
depends: [T-102]
owns:
  - apps/web/src/game/thickness/**
touches:
  - apps/web/src/App.svelte
  - apps/web/src/render/scene.ts       # thinWalls field + one line in solidChanged
  - apps/web/src/render/voxelMesh.ts   # aFlags bit 4 shader block, setThin()
  - apps/web/src/render/colormap.ts    # FLAG_THIN, PaintInput.thin
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
- [x] Unit tests on hand-made patterns (1-thick plate, 2-thick plate, diagonal strut).

## Log

### 2026-10-12 — T-308 worker: thin-wall warning (status → review)

**Definition of "thin" (decided).** Morphological opening by the 2-voxel cube. A *window* is
a 2×2×2 block of cells (size 1 along an axis whose grid extent is 1); it is *full* when it
lies inside the grid and all 8 cells are solid. A cell is **thin** iff it is solid, not
protected (`keep` = keep ∪ support ∪ load) and no full window contains it.
- Grid boundary = outside of the part (windows never leave the grid): a 1-thick plate on the
  grid face is thin. Obstacles are simply non-solid.
- Protected cells count as material for their neighbours' windows but are never flagged
  (player cannot change them; excluded from the judgement).
- Why not the "both opposite neighbours empty along an axis" test from the requirement
  text: it misses the corner cell of a 1-thick L and 2-wide diagonal staircases (perpendicular
  thickness 1.4 voxels, every step joint is a single shared face). The cube definition flags
  both, keeps 2-thick plates/2×2 beams clean including edges and corners, and lets a 3-wide
  staircase (2.1 voxels) through — except the two acute end tips where the grid boundary cuts
  it, which really are slivers. One-voxel spikes on a thick block are thin.

**Code (`apps/web/src/game/thickness/`).**
- `thinWalls.ts` — `ThinWallMap(grid, solid, keep)`: live `thin: Uint8Array`, `count`,
  `subscribe(listener)`, `update(changedCells) → flipped cells`, `recomputeAll()`;
  `thinCells()` one-shot. Incremental: bounding box of the changed cells; refresh windows
  touching it, then the cells of those windows (box ±1). Single code path (full = whole box).
- `thinWallHud.svelte.ts` — `ThinWallHud` runes state (`count`, `tint`), `attach(view)`
  follows a `ThinWallView` (`{ thinWalls, voxels.setThin }` = `StageScene`), `toggleTint()`.
- `ThinWallBadge.svelte` — pill under the stage panel: 「薄い部分 N ボクセル」, hidden at 0,
  tooltip explains it is a precision warning (判定には影響しません); click toggles the dots.
- Tests next to the code: `thinWalls.test.ts` (every pattern checked against an independent
  brute-force reference: 1-thick plate mid/on boundary, 2-thick plate incl. inset, 2×2 beam vs
  1×2/1×1 struts, diagonal staircase 1/2/3/4 wide, L-corner 1/2 thick, spike, protected cells,
  degenerate axis, 200-step random incremental vs reference incl. exact flipped list,
  CarveState carve/undo on the demo stage, perf), `thinWallHud.test.ts` (HUD follow/toggle/
  detach, `paintQuads` sets FLAG_THIN on thin unprotected cells only, with FLAG_OVER).

**Rendering hook (orchestrator-approved edits outside `owns`, listed under `touches`).**
- `colormap.ts`: `FLAG_THIN = 4`, optional `PaintInput.thin`; `paintQuads` ORs the bit.
- `voxelMesh.ts`: shader block reading bit 4 — 3×3 grid-space dots per voxel face, dark ink
  on light colours / light ink on dark ones (hard switch on linear luminance 0.18, so it is
  readable on both palettes), fwidth-anti-aliased into an even tint when far; 75 % strength.
  Emissive pulse test changed from `scFlags >= 2.0` to a bit test (else thin cells pulsed).
  Cache key v2 → v3. `VoxelMesh.setThin(flags | null)`.
- `scene.ts`: `readonly thinWalls` built after the voxel mesh; `solidChanged` also marks the
  chunks of cells whose thin flag flipped (a cell's quads live in its own chunk).
- `App.svelte`: `thinWalls.attach(game.scene)` after `startGame`, badge in `.top-left`.
- Agreed with T-302/T-303/T-301 by message: aFlags bits 1 keep, 2 over, 4 thin; others take 8+
  and use bit tests. T-302 shows no dots during the load test (leaves `thin` out of its
  paintQuads input); T-303 does not tint its ghost (X-ray) mesh; T-301 adds no voxel bits.

**Measurements (node, M-series Mac, vitest).** Full recompute 40×12×12 (perforated):
0.097 ms median (gate < 2 ms); incremental update of a 5×5 brush step: 0.002 ms.

**Browser check** (vite from this worktree, :5308). w1-01: 5×5 brush clicked three layers
deep into the front face → 「薄い部分 15 ボクセル」 and dots on the remaining 1-thick back wall;
a 2-thick pocket floor stays clean; light dots on blue, dark dots on green/yellow (forced
utilisation gradient). w2-01: 1-thick web I-beam → 64 thin, layout dump matches the
definition; badge click hides/shows the dots (badge dims); 元に戻す → badge disappears.
No console errors.

**Follow-ups.**
- The count is in voxels; a "members" count (connected components of thin cells) would read
  more naturally (「薄い部分 3 か所」) — cheap BFS over thin cells if wanted.
- Authored stages start at 0 thin cells (all grids ≥ 4 per axis); stage authors (T-305/T-406)
  could assert that in the stage pipeline.
- Judge (T-301) could optionally list thin cells in the result screen; intentionally not a
  failure rule here.

