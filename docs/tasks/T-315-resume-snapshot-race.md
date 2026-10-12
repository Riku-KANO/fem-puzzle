---
id: T-315
title: Fix 途中 marker race when leaving a stage < 500 ms after a carve
status: done
phase: 1
depends: [T-304, T-313]
owns:
  - apps/web/src/ui/select/**
  - apps/web/src/game/progress/**
touches:
  - apps/web/src/App.svelte
  - apps/web/e2e/campaign.spec.ts   # remove the fixme marker only
verify:
  - pnpm --filter @stress-carve/web test
  - E2E_RUN_FIXME=1 pnpm --filter @stress-carve/web e2e
---
## Goal
Found by T-313: leaving a stage within 500 ms of the last carve shows no 途中 on the select card
until a reload — the carve is saved on close, but the select screen read the records before that.
Deterministic repro: `apps/web/e2e/campaign.spec.ts` (marked `fixme`; `E2E_RUN_FIXME=1` fails 3/3).

## Requirements
- Flush the pending autosave synchronously before the route switches (or make the select screen
  reactive to record writes); no lost carve on fast navigation, tab close, or restart.
- Unit test in progress/ for the flush ordering; remove the e2e `fixme` so the repro runs always.

## Log

### 2026-10-12 — T-304 author: fixed (status → review)

**Cause.** `MenuScreen` snapshots the records when it mounts. On stage → select, Svelte
mounts the `{#if !entry}` block first and only afterwards runs the cleanup of the session
`$effect`, where `runner.close()` saves. A carve made less than 500 ms before leaving was
saved, but after the select screen had already read the records.

**Fix.** Flush the carve synchronously before the route changes:
- `HashRouter.onBeforeChange(from, to)` runs inside `sync()` before `route` is assigned. Every
  route change passes through it: `navigate` push via hashchange, `navigate({replace})`,
  back/forward and address-bar edits. The route still switches if the hook throws (try/finally).
- `App.svelte` sets `router.onBeforeChange = () => runner.save()`. This is a no-op without an
  open stage or when the bitmask is unchanged. Close (effect cleanup) and `pagehide` still save
  as before. Restart discards on purpose.
- The select/title snapshot is extracted into `ui/select/menuSnapshot.ts` (pure).
  `MenuScreen` calls it once per mount inside `untrack`. `StageInfo` moved there from
  `StageSelect`.

**Tests.**
- `test/progress-leave.test.ts` drives the real router, StageRunner and menuSnapshot in the
  app's order: navigate → snapshot ("mount") → close. With the hook, the snapshot shows the
  carve. Without it, it shows null while the store has the carve, which is the race itself.
  It also checks that flush is a no-op without a stage or without changes.
- `select-routes.test.ts`: the hook runs while `route` is still the old one, for push, back,
  replace and unknown-stage redirect, and not for unchanged routes. A throwing hook still
  switches the route. `FakeWindow` moved to `test/fakeWindow.ts`, shared by both tests.
- `e2e/campaign.spec.ts`: removed the `test.fixme` (comment now marks it a T-315 regression).

**Verify.**
- Web vitest: 320 passed.
- typecheck: 0 warnings.
- `E2E_RUN_FIXME=1 pnpm --filter @stress-carve/web e2e`: 13 passed, 2 skipped.
- Plain e2e: the same result. campaign.spec 4/4 passed, including the repro that failed 3/3
  before the fix. The 2 skips are T-310 env/debris specs (not on main).
- `scripts/verify.sh fast`: green.

**Follow-up.** The 0-star test in `campaign.spec.ts` still polls for the autosave before
leaving. Its comment ("leaving sooner hides 途中 … (fixme below)") is now stale. The poll is
harmless, and I left it alone because this task may only touch the fixme marker in that
file. T-313's owner can drop it.

