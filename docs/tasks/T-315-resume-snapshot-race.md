---
id: T-315
title: Fix 途中 marker race when leaving a stage < 500 ms after a carve
status: doing
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
