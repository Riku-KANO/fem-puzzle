---
id: T-304
title: Stage select, campaign progression and local records
status: todo
phase: 1
depends: [T-102, T-103]
owns:
  - apps/web/src/ui/select/**
  - apps/web/src/game/progress/**
touches:
  - apps/web/src/App.svelte
verify:
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web typecheck
---
## Goal
Design doc: ゲームモード (キャンペーン), 公開形態 (記録はブラウザ内に保存).

## Requirements
- Title → world/stage select (W1, W2 unlocked progressively), best stars/volume per stage.
- Records in `localStorage` behind a small versioned storage module (try/catch; works when
  storage is unavailable). Remember the in-progress carve per stage (bitmask) so a reload
  resumes.
- URL hash routing (`#/stage/w1-01`) — no server.

## Acceptance criteria
- [ ] Unit tests for the storage module (versioning, corrupt data, unavailable storage).

## Log
