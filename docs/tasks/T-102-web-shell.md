---
id: T-102
title: Web game shell — Three.js voxel view, carving, undo, HUD, mock solver worker
status: doing
phase: 0
depends: [T-002]
owns:
  - apps/web/**
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
- [ ] `pnpm dev` shows the stage; carving/undo/redo/orbit work; colours update via worker.
- [ ] Unit tests (vitest, node env): mesher face count for full box = surface area and
      after carving; brush cell selection on each face orientation; history undo/redo;
      mock backend determinism + floating detection; SolverClient drops stale `seq`.
- [ ] `svelte-check` clean with `--fail-on-warnings`; `vite build` succeeds.
- [ ] If browser tools are available, take a screenshot of the running app and describe it
      in the log (not required to pass).

## Log
