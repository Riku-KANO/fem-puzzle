---
id: T-302
title: Load test (Space): exaggerated deformation animation and collapse feedback
status: done
phase: 1
depends: [T-202]
owns:
  - apps/web/src/render/deform/**
touches:
  - apps/web/src/App.svelte
  - apps/web/src/render/scene.ts
  - apps/web/src/ui/Toolbar.svelte   # load-test button props (orchestrator-approved shared edit)
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
- [x] Unit test: displacement lookup for mesh vertices matches nodal indices.
- [x] Animation runs at 60 fps on W2 grids on this machine (log the measurement).

## Log

### 2026-10-12 — T-302 worker: load test built (status → review)

**What it does.** Space or the toolbar 載荷テスト button plays a show on the latest result.
1. The load jig backs off its resting contact (0.3 s) and slowly descends (0.8 s).
2. The deflection ramps 0 → auto scale (1.6 s), and the jig follows the loaded cell's displacement.
3. Within limits: hold 1 s, then release.
4. Over-stressed: crack decals grow, and the over-stressed cells flash for 1 s. Elements with u > 1 then break off highest-first as chips (0.5–2.2 s). Any part cut off from the supports falls as a rigid piece, and everything settles on the bench (1.8 s).
5. Release: the deformation springs back to 0, debris fades out, and the normal view returns. The jig stays seated, so nothing jumps.

Pressing Space again ends the show at once. Any carve, undo or debris change also cancels it (`StageScene.solidChanged`). Pressing it while a newer state is unsolved shows 解析の完了を待っています… and starts on the next result. The HUD chip (`LoadTestBadge`) shows 変形 ×N, then 許容応力以内 or 許容応力超過 N要素 · 破断 b · 崩壊 k片が脱落, plus the load-case name on multi-case stages.

**prefers-reduced-motion:** one static frame with no movement or flashing. It shows full deformation, cracks, and the broken/fallen cells removed, and holds until Space (スペースで終了).

**Design.** All new code is in `apps/web/src/render/deform/`; nothing is added to the shared voxel material.
- `deform.ts` (pure):
  - `vertexDisplacements`: direct nodal lookup through `ChunkMesh.vertexNode` (mesh vertices are grid nodes, so trilinear interpolation = lookup).
  - `maxActiveDisplacement`, over nodes of solid elements.
  - `autoScale`: niceFloor(0.1·min extent / max|u|), in steps 1/2/2.5/5·10^k, so the shown max lands in (5 %, 10 %] of the smallest grid extent.
  - `formatScale`, `normalDeltas` (bent normals per quad from the diagonals' cross product), `cellDisplacement`.
  - `breakOrder` (solid, not keep, u > 1 or NaN, highest first).
  - `crackField`: 0.35 → 1 between 100 % and 150 %.
  - `criticalCase`: animates the case with the highest judged utilisation. Cracks and breaks use the envelope, like the colour map.
- `collapse.ts` (pure): `detachedComponents` = new 6-connected components cut off from supported cells. Pieces that already floated before the test (e.g. a protected load island) don't count.
- `timeline.ts` (pure): `timelineAt(plan, t)`, a function of elapsed time, so frame drops never desync the show.
- `deformMaterial.ts`: a fresh `createVoxelMaterial()` instance with a chained onBeforeCompile.
  - Vertex: `transformed += uDeform * aDisp` after the base copied the undeformed `position` into `vGridPos`, so grid lines, hatches and T-308 dots stay glued to the voxels. Plus `objectNormal = normalize(objectNormal + uDeformT * aNormalDelta)`.
  - Fragment: crack mask and flash before `#include <opaque_fragment>`.
  - Cracks use T-307's `assets/crack_tile.png` (1 tile per face, random per-cell shift, `textureGrad`). It is loaded lazily; a procedural Worley-edge pattern is the fallback.
  - Cache key = base key + `+deform-v1`. A test checks the anchors against `THREE.ShaderLib.lambert`.
- `deformView.ts`: own chunk meshes (`meshChunk` + `paintQuads`) over a private copy of the solid flags (∧ section mask). Breaking rebuilds only the touched chunks. The bounding sphere is grown by max|aDisp|·scale. `pieceMesh()` bakes a falling piece at the current factor.
- `debris.ts`: seeded ballistic chips (InstancedMesh, visual gravity 2.5 m/s², bounce, friction, rest on the bench at −0.16 m) and rigid falling pieces (pivot at the centroid, tip over, land on the floor). This is separate from T-310's Rapier debris.
- `loadTest.ts` (`LoadTest`, owned by `StageScene.loadTest`): toggle/start/stop/cancel/update, `onStatus` (changes only), and `frameStats()`.
  - `freezeAt` (dev aid for screenshots/e2e) pins the timeline.
  - `LoadTestStatus.runs` is the tutorial signal for T-305.
  - Hooks agreed with peers: `sectionMask` (T-303), `hideWhilePlaying` (T-303 pushes its X-ray ghost), `loadJigs` (T-310 swaps in the glTF jig roots).
  - Jig contract with T-310: origin = contact, local −Y = F̂. Only `position` is driven, in world space, and restored exactly on stop. A root with `userData.setStroke(t)` stays seated and extends its rod instead of lifting.
- Wiring:
  - scene.ts: `jigs` + `loadTest` fields; forwards in setResult, setPalette and solidChanged (cancel); `update` in frame; dispose.
  - App.svelte: status `$state`, Space (ignores key repeat), badge above the toast.
  - Toolbar.svelte: optional `canLoadTest` / `loadTestActive` / `onLoadTest` props. Only the 載荷テスト button changed; T-301 owns 提出.

**Tests** (vitest, node): 27 in `src/render/deform/*.test.ts`.
- Lookup vs node index from vertex positions on a carved 11×6×5 grid with 4³ chunks, every vertex.
- Linear field reproduced exactly, auto-scale bounds, nice numbers, normals (zero / translation / rotation), break order, crack field, critical case.
- Timeline phases/monotonicity/reduced motion, collapse components.
- Headless `LoadTest` on the demo cantilever via mock physics:
  - Within limits: view swap, auto scale, jig lift/follow/restore.
  - Notched: 8 breaks → 1 piece falls, chips settle on the bench, game state untouched.
  - Cancel, Space-stop, waiting for a result, reduced motion, section mask.
- Shader anchors.

**Measurements** (Claude Browser pane, `vite` from this worktree on :5181, M-series Mac, Chrome, canvas 2048×1536 @ dpr 2):
- W2-01 with two 6-deep notches (u_max 163 %, 32 over-stressed elements → 32 chips + 1 falling piece, full 7.5 s show, measured just before the 0.3 s lift pre-phase was added): **451 frames, mean 60.0 fps, p95 frame 17.6 ms, worst 17.7 ms**.
- `LoadTest.update`: mean 0.04 ms, p95 0.28 ms, max 0.8 ms (the break frame: chunk rebuild + connectivity). `renderer.render` CPU: mean 0.13 ms.
- Intact W2-01 at ×50 and W2-02 at ×25 bend visibly, with the arrows riding the deflection.
- Space with the toolbar button focused toggles exactly once. No console errors.
- e2e smoke (`pnpm --filter @stress-carve/web e2e`, T-306) green after merging main.

**Notes / follow-ups.**
- The 10 % target makes W1 plates (4 voxels thick) bend by ≤ 0.4 voxel, which is subtle. If playtests want more, raise `TARGET_FRACTION` or base it on the span. Design doc: 数十〜数百倍, auto.
- Breaks are capped at `MAX_BREAKS = 400` visual chips. Beyond that, cells only crack (the badge still shows the full count).
- After a collapse the load jig stays where the load point was, rather than following the fallen piece.
- T-310 adds `this.loadTest.loadJigs = () => this.workshop.loadJigs();` and `this.workshop.jigsLocked = () => this.loadTest.active;`.
- T-306 could add an e2e step: press Space, then assert the badge and `scene.loadTest.current.state === 'playing'`, using `freezeAt` for deterministic screenshots. `apps/web/e2e` is not mine.
- Multi-case (W4): only the critical case animates. Playing each case in turn would be a small extension of `start()`.

### 2026-10-12 — T-302: merged main with T-301, T-303, T-306 and T-308

- **T-303:** the StageScene constructor now sets `loadTest.sectionMask = () => views.sectionMask` and pushes `views.ghost.group` into `hideWhilePlaying`.
  - In section view the load test bends only the cut part. The obstacle blocks and cut frame stay visible.
  - Changing the section axis or position, or leaving section view, while the show plays ends it (mask compared each frame).
  - Checked in the browser: the axis switch ends the show and restores voxel and ghost visibility. Also unit-tested.
- **T-301:** both toolbar buttons are kept. 提出 now also stops the load test before the result screen opens.
- **T-306:** the e2e smoke passes after merging main (2 passed, wasm spec skipped until T-205).
- **Browser measurement caveat:** when the Browser pane is hidden, rAF stops, so a later in-browser check drove `scene.frame()` by hand. The 60 fps figure above was measured with the pane visible.
- **T-310 (not landed yet):** add `this.loadTest.loadJigs = () => this.workshop.loadJigs();` and `this.workshop.jigsLocked = () => this.loadTest.active;` after `new LoadTest(...)`.

### 2026-10-12 — T-302: merged main with T-304 (stage select / routing)
- App.svelte is rebuilt on T-304's version, so a stage switch or restart can't leak a listener or leave a show running.
  - `bindSession()` hooks `loadTest.onStatus` for the new session and resets the badge.
  - `unbindLoadTest()` drops the listener, stops the show and resets the badge. It runs in the route effect's cleanup and in `restart`, before `runner.close()` / `runner.restart()`.
  - The scene's `dispose()` still disposes the `LoadTest`.
- Space follows T-304's rule (game shortcuts only while a stage is open). It is also ignored while the result screen is open, and the toolbar button is disabled then too.
- `LoadTestStatus.runs` is per game session: it resets to 0 when a stage is opened or restarted. T-305's tutorial counter should treat a drop as a re-base.
- Verify: fast PASS. `pnpm build:wasm && pnpm --filter @stress-carve/web e2e`: 3 passed (mock ×2 and wasm).
