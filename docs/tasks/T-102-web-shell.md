---
id: T-102
title: Web game shell — Three.js voxel view, carving, undo, HUD, mock solver worker
status: done
phase: 0
depends: [T-002]
owns:
  - apps/web/**
  - '!apps/web/public/assets/**'   # T-307 exports glTF assets here in parallel
verify:
  - pnpm --filter @stress-carve/web typecheck
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web build
---
## Goal
A playable carving loop in the browser against a **mock** solver that speaks the real
worker protocol, so the WASM solver (T-202) can be dropped in without UI changes.
Design doc sections: コアゲームプレイ / 操作, 3D表現・UI/UX, 画面構成.

## Read first
- `docs/specs/worker-protocol.md` and `packages/protocol/src/worker.ts` (normative)
- `docs/specs/stage-format.md`, `packages/protocol/src/stage.ts`
- Design doc: `docs/削り出しパズル 企画・技術設計書.md`

## Scope
- **Structure** (keep `App.svelte` thin; later tasks plug in here):
  `src/game/` (state: stage, solid flags, history, derived volume fraction),
  `src/render/` (scene, voxel mesher, colour maps, picking, jigs),
  `src/ui/` (Svelte HUD components), `src/solver/` (`SolverClient` on the main thread,
  `worker.ts` entry, `mockBackend.ts`, a `Backend` interface the WASM backend will implement).
- **Stage loading**: load `stages/*.json` (repo root) via `import.meta.glob`; if none exist
  yet, use a built-in demo stage (24×8×4 cantilever, x- face fixed, downward load at the
  x+ end) built with the protocol's `encodeBitmask`.
- **Voxel mesh**: only faces between solid and non-solid; chunked (e.g. 8³) so a carve
  rebuilds only touched chunks; per-face colour from element utilisation;
  keep voxels visibly distinct (e.g. hatched/darker tint); block voxels as grey obstacles;
  placeholder jigs: arrows for loads, clamp boxes for supports.
- **Colour map** (design doc 応力の可視化): utilisation 0 → blue, 1 → red, > 1 magenta
  blinking; a viridis-style palette toggle for colour-vision accessibility; legend with %.
- **Input** (design doc 操作 table): left click/drag carves surface voxels with brush
  1 / 3×3 / 5×5 (in the plane of the hit face; keys 1/2/3); keep cells cannot be carved
  (brief feedback); one drag = one history entry; Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z redo;
  right *click* (no movement) = undo, right *drag* = orbit, wheel = zoom, double-click =
  move orbit target to the hit point. Initial camera: 45° above, loads and supports visible.
- **Solver client**: sends `carve` diffs with increasing `seq`, ignores stale replies,
  shows a "solving…" indicator with iteration/residual from `progress`, applies `result`.
  Floating elements reported by the solver are removed from the solid set (fall as debris
  later — T-307) and recorded in the same history entry.
- **Mock backend**: deterministic, fast (< 20 ms for 40×12×12), qualitatively plausible
  (e.g. beam-slice heuristic: per cross-section bending stress from remaining voxels),
  real 6-neighbour BFS for floating/loadsConnected. Runs in the worker.
- **HUD** (画面構成): top-left stage name + volume meter with star thresholds; right
  legend, max utilisation %, view-mode toggle (normal; section/X-ray are stubs for T-303);
  bottom toolbar: brush size, undo/redo, load test (disabled, T-302), submit (disabled, T-301).
  Japanese UI text.

## Acceptance criteria
- [x] `pnpm dev` shows the stage; carving/undo/redo/orbit work; colours update via worker.
- [x] Unit tests (vitest, node env): mesher face count for full box = surface area and
      after carving; brush cell selection on each face orientation; history undo/redo;
      mock backend determinism + floating detection; SolverClient drops stale `seq`.
- [x] `svelte-check` clean with `--fail-on-warnings`; `vite build` succeeds.
- [x] If browser tools are available, take a screenshot of the running app and describe it
      in the log (not required to pass).

## Log

### 2026-10-12 — T-102 worker: shell built (status → review)

**Built.** Playable carve loop against the mock solver over the real worker protocol.
Verify: web typecheck (svelte-check, 0 warnings), 61 vitest tests in 11 files, `vite build`,
`scripts/verify.sh fast` all green.

**Module map (`apps/web/src`)** — pure TS unless marked; tests in `apps/web/test/`.
- `game/` — `grid.ts` (indexing, face dirs), `demoStage.ts`, `stages.ts` (glob of
  `../../../../stages/*.json` = repo `stages/`, validated, sorted by world/id, demo fallback;
  `?stage=<id>` picks one), `history.ts`, `carveState.ts` (solid flags, effective keep, block,
  strokes, undo/redo, floating, volume fraction, `toBitmask()`), `brush.ts`, `supports.ts`
  (fixed nodes; supported cells via protocol `supportedCells`), `connectivity.ts` (BFS,
  `debrisCells`), `controller.ts` (**GameController**: input → CarveState → DiffBatcher →
  SolverClient; results → view + HUD; `ViewPort` / `HudModel` interfaces), `boot.ts`
  (DOM/Three/worker wiring, one `GameSession` per stage; dev-only `window.__stressCarve`).
- `render/` — `mesher.ts` (8³ chunks, quads only between flagged/unflagged cells, per-quad
  element + face, **per-vertex grid node id**), `colormap.ts` (stress + viridis palettes,
  legend gradient, `paintQuads`, case envelope), `picking.ts` (grid DDA with a hit
  predicate), `gesture.ts` (click vs drag, double-click), Three glue: `voxelMesh.ts`
  (chunk meshes, Lambert + `onBeforeCompile`: keep hatch, over-stress pulse, voxel grid
  lines), `jigs.ts` (placeholder clamps/arrows + pure `supportPatches`/`loadArrows`),
  `scene.ts` (**StageScene**, implements `ViewPort`), `input.ts` (pointer → controller).
- `solver/` — `backend.ts` (**Backend interface**), `mockBackend.ts` + `mockPhysics.ts`,
  `host.ts` (**SolverHost**: the worker's whole protocol logic, DOM-free and unit-tested),
  `worker.ts` (6-line module-worker entry), `backends.ts` (factory selection),
  `client.ts` (**SolverClient** + `spawnSolverWorker()`), `diffBatcher.ts`.
- `ui/` — `hudState.svelte.ts` (runes, implements `HudModel`), `StagePanel`, `SidePanel`,
  `Legend`, `Toolbar`, `Toast` (.svelte), `shortcuts.ts`, `format.ts`. `App.svelte` only
  composes these and maps keys/buttons to `GameSession` actions.

**Extension points for later tasks.**
- T-205 (WASM backend): add `solver/wasm/wasmBackend.ts` implementing `Backend`
  (`info`, `setSolid(Uint32Array, bool)`, `solve(hooks)` → `SolveOutput | null`, `dispose`);
  register it in `solver/backends.ts::selectBackendFactory(options)` (mock stays fallback).
  The host already does seq/cancel/progress throttling/timing/transferables; a backend calls
  `hooks.cancelled()` between `iterate` chunks, `hooks.progressDue()`/`progress()`, and
  `await hooks.yield()`. Test pattern: `test/host.test.ts` drives `SolverHost` in-process.
  T-202's Session notes (sent to me for relay): `iterations` in StepStatus is cumulative over
  cases (use directly); `set_solid` is idempotent but **throws and applies nothing** when
  carving a protected cell or restoring outside the initial solid set (the UI never sends
  either: CarveState filters keep, debris skips keep components); StepStatus is a plain
  object; `floating()`/`loads_connected()` reflect the last `begin()`; call `free()` on
  re-init. Node load: `initSync({ module: bytes })`.
- T-301 (judge/result): `session.controller.state` (stage, solid, keep, volumeFraction),
  `controller.latestResult`; `hud.resultCurrent` is true only when the latest result has the
  newest seq and no diff is pending (submit gate). Submit button is in `ui/Toolbar.svelte`.
- T-302 (deformation): `scene.lastResult` holds displacements; `scene.voxels.meshes()` gives
  each chunk's mesh + `data.vertexNode` (vertex → node index) for direct lookup.
  Space is already mapped to `{kind:'loadTest'}` in `ui/shortcuts.ts` (no-op in App).
- T-303 (section/X-ray): `hud.viewMode` + disabled buttons in `ui/SidePanel.svelte`;
  `scene.pickFilter` (cells that stop picking rays); voxel material is Lambert, so clipping
  planes work; `paintQuads` writes per-vertex colour (switch to rgba for X-ray alpha).
- T-304 (stage select): `listStages()` / `buildCatalogue()`; `startGame(host, stage, hud,
  palette)` returns a disposable `GameSession`; replace `pickInitialStage` with hash routing.
- T-307/T-310 (env/debris): `ViewPort.elementsRemoved(cells, 'carve' | 'floating')`
  (empty in `scene.ts`), `scene.cellCenter(e)`, `scene.env` group (placeholder bench grid at
  y = −0.16 m). World frame = stage frame (metres, Y-up, grid min corner at origin) — agreed
  with T-307; jig placeholders use T-307's anchors (support patch centre + outward normal,
  load patch centre + F̂ along local −Y).

**Decisions.**
- Brush: square in the plane of the hit face, same layer; only *surface* cells (neighbour
  across the hit face empty — blocks hide). Cells exposed only by the current drag are
  skipped, so one drag shaves one layer instead of drilling; click again to dig.
- Double-click: a second left press within 350 ms / 5 px of a plain click reverts that
  click's carve (dropped from history, not redoable) and moves the orbit target (camera pans
  with it). Rapid same-spot double clicks therefore do not dig.
- Floating: removed as debris only when the result has the newest seq and no diff is
  pending; recorded in the open stroke, else the newest history entry (redo stack untouched).
  Floating components that contain a protected (keep/load/support) cell are *not* removed —
  they stay, and the HUD shows 荷重点が支点につながっていません.
- Diffs are coalesced per animation frame (`DiffBatcher`), so a drag sends ~1 `carve`/frame.
- Colours: per-element envelope (max over load cases) for results; progress shows case 0
  (protocol). Keep cells are a neutral hatched grey (excluded from judgement, so no stress
  colour); over-stress pulses (static glow with `prefers-reduced-motion`).
- Mock physics (`mockPhysics.ts`): span axis = axis of largest mean load↔support distance;
  cantilever or simply-supported statics; per-slice section (A, centroid, I) → bending +
  axial + parabolic shear → von Mises; Euler–Bernoulli deflection for displacements.
  Connectivity from protocol `supportedCells` (merged main 27fa266). In the browser the
  mock adds 6 × 16 ms simulated chunks so progress/solving UI is exercised.

**Measurements (node, M-series Mac).** Mock solve 40×12×12: 0.63 ms (test gate < 20 ms);
full remesh 40×12×12 (20 chunks): 0.52 ms, one 8³ chunk: 0.012 ms. Bundle: 652 kB
(172 kB gzip) main chunk, mostly three.js — Vite prints its >500 kB advisory (not an error).

**Browser check** (Claude Browser pane, `vite` from this worktree on :5199): demo and all six
`stages/*.json` render. w1-01: grey clamp plate on the x− face, hatched protected x=0 layer
and load cells, orange load arrow pointing down at the x+ top edge, voxel grid lines,
blue→cyan utilisation gradient, HUD 体積率 100.0% / ★ 70% ★★ 55% ★★★ 45%, 最大利用率 11%,
解析完了 · mock. Carving with 1/3×3/5×5 updates colours via the worker (cut demo beam to
109 % → magenta blinking, max shown in magenta); right click and Ctrl/⌘+Z undo,
⇧⌘Z redo; right drag orbits (synthetic events), wheel zooms, double-click re-targets with
volume unchanged; cutting the beam through leaves the load side in place with the red
"not connected" notice; w2-03 shows the dark tunnel obstacle and hatched loaded deck;
viridis toggle recolours; w2-01 shows the grey clamp and teal roller under the ends.
No console errors.

**Follow-ups / open questions.**
- Mock utilisation is low on the real W1 stages (11–15 % at start) because beam theory has
  no stress concentrations; stage tuning must use the real solver (T-203/T-205).
- Progress shows case 0 only (protocol); for W4 multi-case stages the colours jump from
  case-0 progress to the envelope on `result` — consider an envelope progress field when
  multi-case stages land (contract change, not done here).
- `cancel` stops the running (or about-to-start) solve; the UI does not send it yet.
- e2e hook (T-306) for production builds: `boot.ts` exposes `window.__stressCarve` in DEV
  only; T-306 can extend the condition (e.g. `?e2e`).
- Touch input is left to OrbitControls (no carving) — T-409.
- Bundle >500 kB advisory: consider a separate three.js chunk (T-309).
