---
id: T-306
title: Playwright E2E smoke tests wired into verify full
status: todo
phase: 1
depends: [T-202]
owns:
  - apps/web/e2e/**
  - apps/web/playwright.config.ts
touches:
  - apps/web/package.json
verify:
  - pnpm --filter @stress-carve/web e2e
---
## Goal
Close the loop on the UI: an agent (or CI) can prove the game works end-to-end without a human.

## Requirements
- Playwright (chromium only) against `vite preview` with the real WASM build:
  load W1 stage → canvas renders → carve via mouse → a `result` arrives (expose a
  test-only `window.__stressCarve` hook with last result / seq) → undo restores volume.
- Screenshot artifact per test in `apps/web/test-results/`.
- Add `e2e` script to apps/web/package.json; `scripts/verify.sh full` already runs it when
  `playwright.config.ts` exists.

## Acceptance criteria
- [ ] `pnpm --filter @stress-carve/web e2e` green locally; documented runtime (< 60 s).

## Log
