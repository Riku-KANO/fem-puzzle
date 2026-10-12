---
id: T-205
title: Web WASM backend — real solver in the worker with progressive display
status: doing
phase: 0
depends: [T-102, T-202]
owns:
  - apps/web/src/solver/wasm/**
touches:
  - apps/web/src/solver/worker.ts
  - apps/web/package.json
  - apps/web/vite.config.ts
  - apps/web/tsconfig.json
verify:
  - pnpm build:wasm
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web build
---
## Goal
Replace the mock with the real solver by default (mock stays as fallback and for tests).

## Requirements
- `wasmBackend` implements the Backend interface from T-102: progressive solving via
  `iterate(chunk)` with `progress` posts every `progressEveryMs`; checks for a newer `seq`
  between chunks (yield to the event loop); `cancel` supported.
- Backend selection: `options.backend` or URL param `?backend=mock|wasm`; automatic fallback
  to mock if WASM fails to load (small HUD notice).
- `vite build` and `svelte-check` must work with and without `crates/fem-wasm/pkg` present
  (dynamic import guarded by a build-time flag or a stub module) so `verify fast` never
  needs wasm-pack.

## Acceptance criteria
- [ ] vitest (node) test drives the backend through the worker message handler with the
      real wasm (skipped with a clear message when `pkg/` is absent).
- [ ] In `pnpm dev` carving re-solves with the real solver; colours visibly settle;
      stale results are discarded under rapid carving. Log per-carve times for W1/W2.

## Log
