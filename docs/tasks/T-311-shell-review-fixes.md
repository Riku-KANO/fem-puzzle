---
id: T-311
title: Web shell review fixes — history/debris, host cancel tests, HUD reset, context loss
status: doing
phase: 1
depends: [T-102]
owns:
  - apps/web/src/game/carveState.ts
  - apps/web/src/solver/host.ts
  - apps/web/test/host.test.ts
  - apps/web/test/controller.test.ts
touches:
  - apps/web/src/game/controller.ts   # T-205 (onReady) and T-303 (select) also add lines here
  - apps/web/src/render/scene.ts      # dispose only
verify:
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web typecheck
---
## Goal
Fix the findings of the T-102 post-merge review (reviewer report, 2026-10-12).

## Requirements
1. **History/debris bug** (carveState.ts:114/134, controller.ts:93-96): a press that carves
   nothing must not turn into a debris-only history entry. Record debris into the open stroke
   only if `stroke.carved.length > 0`, otherwise into `history.peek()`. A no-op stroke must not
   clear the redo stack. Controller test for the exact sequence: carve island → flush →
   strokeStart(null) → result arrives → strokeEnd → undo restores the *carve* (and debris).
2. **Host tests must exercise cancellation** (host.test.ts): a backend whose `yieldFn` resolves
   on a deferred / after the first progress, then carve/cancel mid-solve ⇒ the running solve
   returns null and the stale seq produces no result. The fake `post` uses
   `structuredClone(msg, { transfer })` so buffer reuse / double transfer fails.
3. **Debris guard test**: undo before the result arrives ⇒ island stays solid, no `'floating'`
   removal, history unchanged (controller.ts:199 `!batcher.pending`).
4. **HUD reset on new session**: the controller constructor resets every `HudModel` field
   (loadsConnected, converged, iteration, relResidual, backend, toast, …).
5. **Host solid mirror** (host.ts:112-130): update the mirror after *each* successful
   `backend.setSolid` call so a throwing second call cannot desync bitmask diffs.
6. **WebGL context** (scene.ts:176-190): `renderer.forceContextLoss()` before removing the canvas.

## Acceptance criteria
- [ ] Each finding has a test that fails on the old code (say so in the Log).

## Log
