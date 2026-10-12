---
id: T-311
title: Web shell review fixes — history/debris, host cancel tests, HUD reset, context loss
status: review
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
- [x] Each finding has a test that fails on the old code (say so in the Log).

## Log

### 2026-10-12 — T-311 worker (T-102 author): all six fixed (status → review)

Verify: web test 69 passed (11 files), web typecheck 0 errors / 0 warnings, web build OK,
`scripts/verify.sh fast` all PASS.

| # | fix | test (`apps/web/test/…`) | fails on old code? |
| --- | --- | --- | --- |
| 1 | `carveState.ts`: debris joins the open stroke only if it carved something, else `history.peek()`; `endStroke` commits only strokes with `carved.length > 0` (no-op presses never push / clear redo) | controller: *debris during a no-op press joins the carve that caused it* (exact sequence: carve island → flush → `strokeStart(null)` → result → `strokeEnd` → undo restores carve + debris); *a press that carves nothing keeps the redo stack* (regression guard) | yes (first test); second passes on old code |
| 2 | host tests drive real cancellation: `Gate` yieldFn pins a solve between chunks, spy backend records `done`/`cancelled`; fake `post` is `structuredClone(msg, { transfer })` for every host test | host: *a carve arriving mid-solve…*, *cancel mid-solve stops it…* | host code was already correct, so they pass on it; **mutation check**: with `cancelled: () => false` both new tests fail while every pre-existing host test still passed — the old tests never exercised cancellation. Old misleading test renamed (*a carve queued while init is loading…*) |
| 3 | (guard already in `controller.onResult`) | controller: *no debris when an undo is pending* | passes on old code (guard existed); **mutation check**: removing `!this.batcher.pending` makes it fail |
| 4 | controller constructor resets iteration, relResidual (NaN), backend, maxUtilization, loadsConnected, converged, error, toast; syncHud covers the rest | controller: *the constructor resets every HUD field* (stale HUD in, defaults out) | yes |
| 5 | `host.ts`: `applySolid()` updates the mirror right after each successful `backend.setSolid` (carve and setSolid) | host: *a rejected restore does not desync the solid mirror* (`StrictBackend` applies a batch fully or throws, like fem-wasm) | yes |
| 6 | `scene.ts`: `releaseRenderer()` = `dispose()` → `forceContextLoss()` → canvas `remove()` (dispose first so the forced loss does not hit three's context-lost handler) | controller.test.ts › *StageScene teardown* (fake renderer, call order) — placed there because T-311 owns only controller/host tests | yes (helper did not exist; old dispose never called `forceContextLoss`) |

Coordination: controller.ts edit is limited to the constructor's HUD-reset block — told
T-205 (onReady) and T-303 (select) before editing; told T-205 about the host mirror fix.

