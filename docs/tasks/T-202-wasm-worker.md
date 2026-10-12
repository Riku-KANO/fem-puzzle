---
id: T-202
title: WASM binding (Session) and WASM worker backend
status: todo
phase: 0
depends: [T-101, T-102]
owns:
  - crates/fem-wasm/**
  - apps/web/src/solver/**
touches:
  - apps/web/package.json
  - apps/web/vite.config.ts
  - apps/web/tsconfig.json
verify:
  - pnpm build:wasm
  - cargo test -p fem-wasm
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web build
---
## Goal
Run the real solver in the browser worker through the `Session` API in
`docs/specs/worker-protocol.md`, replacing the mock by default (mock stays as fallback
and for tests).

## Requirements
- `crates/fem-wasm`: `Session` exactly as specified; errors as `JsError`; zero-copy-ish
  typed array returns (`Float32Array::from` is fine). Size: report `.wasm` size (gzip) in
  the log; keep release `wasm-opt` on.
- `apps/web/src/solver/wasmBackend.ts` implements the backend interface from T-102:
  progressive solving via `iterate(chunk)` with `progress` posts every
  `progressEveryMs`; checks for newer `seq` between chunks (yield to the event loop with
  `await new Promise(r => setTimeout(r))` or MessageChannel); `cancel` supported.
- Backend selection: `options.backend` or URL param `?backend=mock|wasm`; automatic
  fallback to mock if WASM fails to load (show a small HUD notice).
- Vite: the `fem-wasm` alias exists already; make `vite build` work both with and without
  `crates/fem-wasm/pkg` present (e.g. dynamic import guarded by a build-time flag, or a
  stub module) so `verify fast` never needs wasm-pack.

## Acceptance criteria
- [ ] vitest (node) test that loads the built wasm via `initSync` with the file bytes and
      solves `stages/w1-01.json` (or the demo stage) — skipped with a clear message when
      `pkg/` is absent.
- [ ] In `pnpm dev`, carving re-solves with the real solver; progress messages visibly
      update colours; stale results are discarded under rapid carving.
- [ ] Log: wasm size, and per-carve time on W1 and W4-sized grids in the browser.

## Log
