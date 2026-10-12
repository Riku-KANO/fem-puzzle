---
id: T-303
title: Cross-section clipping (3 axes) and X-ray mode
status: review
phase: 1
depends: [T-102]
owns:
  - apps/web/src/render/views/**
  - apps/web/src/ui/views/**
touches:
  - apps/web/src/App.svelte
  - apps/web/src/ui/SidePanel.svelte
  - apps/web/src/render/scene.ts       # wiring (orchestrator: shared, additive)
  - apps/web/src/render/voxelMesh.ts   # setMask + public material (shared, additive)
  - apps/web/src/game/brush.ts         # BrushContext.hidden (approved by main)
  - apps/web/src/game/controller.ts    # optional ViewPort.isHidden (approved by main)
  - apps/web/test/views.test.ts        # new test file
verify:
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web typecheck
---
## Goal
Design doc: 断面ビュー, X線モード — 内部が見えない問題への対策 (highest UI priority).

## Requirements
- Section: axis toggle x/y/z + slider; Three.js clipping plane; the cut face is capped and
  coloured with the utilisation of the cut voxels (not just hollow).
- X-ray: elements below a utilisation threshold (slider, default 30 %) become translucent so
  only the load path stays opaque.
- Picking must ignore clipped / x-rayed-away voxels sensibly (carve what you see).

## Acceptance criteria
- [x] Unit tests for the visibility/picking predicate.
- [x] Works together with carving and the colour-map toggle; screenshot or description in log.

## Log

### 2026-10-12 — T-303 worker: section + X-ray views (status → review)

**Built.** 断面 / X線 buttons are live. Section: axis X/Y/Z, slider over layer boundaries
(0..n), 反転 (kept side), capped cut face coloured by the cut cells' utilisation, orange frame
on the cut plane; clicking the cut face carves the cut layer (hollowing from inside). X-ray:
threshold slider (default 30 %, step 5 %); solid cells with known utilisation below it are
drawn translucent (opacity 0.22, depthWrite off), the load path stays opaque; NaN / > 100 %
never fade; before the first result everything stays opaque (hint 解析結果を待っています).

**Files.** `render/views/visibility.ts` (pure: `ViewSpec`, `viewSpecFor`, `viewMasks`,
`isGhost`, `keptBySection`, `pickPredicate`, `hiddenByView`, `facingFlip`, `cellLook`),
`render/views/viewLayers.ts` (Three side: ghost `VoxelMesh`, clipped obstacle mesh, cut
frame; `scene.views`), `ui/views/viewSettings.svelte.ts` (runes: axis/cut/flip/threshold,
`chooseAxis`, `setStage`), `ui/views/ViewControls.svelte`. Shared, additive:
`VoxelMesh.setMask(mask)` + `material` public; scene wires `views` (solidChanged /
setUtilization / setPalette / frame / dispose, `pickFilter = views.pickable`, `isHidden`);
the block mesh moved from scene into `views.group`; SidePanel enables the modes and renders
ViewControls; App keeps `game` in `$state.raw` and pushes `viewSpecFor(hud.viewMode, …)` to
`scene.views.set()` from one `$effect`. Approved by main: `BrushContext.hidden` and optional
`ViewPort.isHidden` (controller passes `this.view.isHidden?.bind(this.view)`).

**Decision: mesh masking instead of clipping planes + stencil caps.** On a voxel grid the cut
always lies on a layer boundary, so the voxel mesh simply meshes `solid & mask`: faces between
kept and hidden solid cells *are* the cap — exact, coloured by the cut cell, carrying
`quadElement` / `vertexNode` like any quad (picking, overlays and T-302 deformation treat
it like any surface). No stencil passes, no shader edits, no z-fighting, no capping of
obstacles by hand. Masks are independent of the solid flags, so carving never touches them;
`setMask` diffs against the previous mask and rebuilds only chunks around changed cells
(unit-tested: moving the cut 20 → 18 on 24×8×4 rebuilds chunk 2 only). X-ray needs the same
thing (translucent outer cells would otherwise reveal nothing — interior faces are not
meshed): the opaque mesh gets the "not ghost" mask and a second `VoxelMesh` over the same live
solid flags gets the ghost mask with a transparent material copy (no vertex-colour change to
rgba, so T-308's flag bits and colour paths stay untouched).

**Decision: picking / brush ("carve what you see").** Hidden (section-clipped) cells do not
stop rays, are never carved, and count as empty for the brush's surface rule, so the cut face
is carvable and a 5×5 brush straddling the plane only takes kept cells. X-ray ghosts are
visible material: they stop rays and carve normally — the translucent skin is exactly the low-
utilisation material worth removing, and passing rays through it would put the brush on the
load path. Obstacles beyond the cut are clipped (mesh + picking). The first section axis cuts
across the thinnest grid dimension (`defaultAxis`, ties → z: the side profile of the W1/W2
beams); entering section mode turns the cut face towards the camera (`facingFlip`); a new
axis starts cut at the middle.

**Tests.** `apps/web/test/views.test.ts` (19): spec clamping, default axis, section masks on all axes
(+flip), ghost rules (threshold edge, NaN, > 1, unsolved), cell looks, DDA picking through
hidden cells to the cap / flipped / ghosts stop rays / clipped obstacles, brush on the cap
(9 cells with hidden; 0 without — fails on the old brush), brush straddling the cut, masked
mesh = surface of the kept box with the cap on the last kept layer, masked mesh = mesh of the
combined flags after carving, chunk-local rebuild, ViewLayers X-ray split (18+6 boxes) and
section API, and the controller test main asked for (section on: a 3×3 click on the cut face
carves the 9 cut-layer cells, hidden layer untouched, undo restores; section off: nothing).

**Measurements (node, M-series).** Section slider step (mask + rebuild): 0.27 ms on
40×12×12, 0.87 ms on 64×32×32. X-ray utilisation update with unchanged classes: 0.30 ms /
2.8 ms; pathological random field (every cell flips, checkerboard meshes): 4.4 ms / 39 ms —
real fields are smooth, so only chunks near the threshold contour rebuild.

**Browser check** (Browser pane, vite on :5303). w1-01: 断面 opens on Z 2/4 with the
mid-plane cap facing the camera (green at the root's top/bottom fibres, blue neutral axis);
X 12/24 shows the cap on the kept half; a 3×3 click on the cap carves 9 cells (98.8 %) leaving
a pocket, and 通常 shows the beam closed again (T-308's thin-wall badge counts the new thin
skin); the hover preview sits on the cap; viridis recolours cap and walls. After carving a window
through the demo beam, X線 at 10 % leaves only the root flanges opaque. w2-03: Z cut 4/8
shows the over-stressed (magenta) band above the tunnel and green/yellow zones inside the
deck, the tunnel obstacle is cut with it; X線 30 % fades the bridge ends so the supports show
through, and clicking a translucent cell carves it. No console errors. T-306's e2e smoke
(merged temporarily, then dropped): 2 passed, wasm skipped.

**Coordination.** T-302 (load test): agreed hooks, whoever lands second adds in the
StageScene constructor `this.loadTest.sectionMask = () => this.views.sectionMask;` and
`this.loadTest.hideWhilePlaying.push(this.views.ghost.group);` (blocks + frame stay visible).
T-308: no tint on the ghost mesh (agreed); merged its scene/voxelMesh changes. T-301: overlay
unaffected; `scene.views.set(NORMAL_VIEW)` resets the view if the result screen wants it.

**Merges.** main merged at 26d7cb2 (T-308), a07a6f6 (T-311), 6015437 (T-301/T-306/T-309/
T-204). App.svelte conflict with T-301 resolved by keeping both; `actions.submit` now sets
`hud.viewMode = 'normal'` before opening the result screen (the result camera turn and
benchmark overlay should show the whole part, not a section or X-ray ghosts). Post-merge:
web typecheck clean, 167 web tests pass, e2e smoke 2 passed (wasm skipped: T-205 not on main),
X線 checked again in the browser on w1-02.

**Follow-ups.**
- T-301: in 最適化解のみ the overlay hides `scene.voxels.group`; with the submit reset above
  the ghost mesh is empty anyway, but hiding `scene.views.group` alongside would be robust.
- T-304 (stage switching): call `views.setStage(stage.grid)` on the App's `ViewSettings` when
  the stage changes (the `$effect` already re-applies the view to the new `game`).
- The cap looks like any other face (frame marks the plane). If playtests show confusion, add
  a cap flag bit (8) in `paintQuads` + a subtle shader pattern — needs a mesher/paint hook to
  know which quads face a hidden neighbour.
- Optional keyboard shortcuts for the modes / slider (e.g. V to cycle, [ ] to move the cut) —
  `ui/shortcuts.ts` belongs to the shell.

