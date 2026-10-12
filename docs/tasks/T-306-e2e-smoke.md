---
id: T-306
title: Playwright E2E smoke tests wired into verify full
status: done
phase: 1
depends: [T-202]
owns:
  - apps/web/e2e/**
  - apps/web/playwright.config.ts
touches:
  - apps/web/package.json
  - apps/web/src/game/boot.ts   # one line: expose the test hook in the e2e build
  - pnpm-lock.yaml              # @playwright/test devDependency
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
- [x] `pnpm --filter @stress-carve/web e2e` green locally; documented runtime (< 60 s).

## Log

### 2026-10-12 — T-306 worker: e2e smoke green (status → review)

**Run it.** `pnpm --filter @stress-carve/web e2e` (= `playwright test`; first time on a machine:
`pnpm --filter @stress-carve/web exec playwright install chromium`). The Playwright
`webServer` does `vite build --mode e2e --outDir e2e/dist` then `vite preview` on that
directory, so one command builds, serves and tests. `E2E_PORT=<n>` overrides the port.

**Files.** `apps/web/playwright.config.ts`; `apps/web/e2e/`: `smoke.spec.ts` (mock backend),
`wasm.spec.ts` (`?backend=wasm`), `flows.ts` (the shared flows), `game.ts` (page helpers:
open stage, hook snapshot, canvas read-back, carvable-spot finder, result waits),
`hook.ts` (typed `window.__stressCarve` shape + compile-time check against `GameSession`),
`skipReasons.ts` (reporter that prints skip reasons), `tsconfig.json`.

**What the tests do** (chromium, 1280×800, fresh context per test → empty localStorage):
1. *carve loop* (mock, and wasm): open `/?backend=<b>&stage=w1-01#/stage/w1-01` → wait for the
   first `result` (seq = latest request) → assert backend id, converged, volume 1 and HUD
   `100.0%` → canvas really draws (rAF read-back of the WebGL canvas: > 2 % non-background
   pixels, triangles > 0) → key `2` (brush 3×3, toolbar `aria-pressed`) → real mouse hover +
   left click on a carvable spot → wait for a `result` with a newer seq that answers the newest
   request → 1–9 voxels gone, volume and HUD text dropped, 解析完了 shown → right click (undo)
   → newer result, volume and HUD back to 100.0 % → ⇧Ctrl/⌘Z redo → Ctrl/⌘Z undo → no page
   errors / console errors. Screenshots `1-loaded`, `2-carved`, `3-undone` + Playwright's
   `test-finished-1.png` per test in `apps/web/test-results/<test>/`.
2. *one drag is one history entry* (mock): left drag 48 px over carvable voxels → ≥ 2 voxels
   carved → one Ctrl/⌘Z restores all and leaves nothing to undo.

**Decisions.**
- Test hook: `boot.ts` now sets `window.__stressCarve` when
  `import.meta.env.DEV || import.meta.env.MODE === 'e2e'`. Production (`MODE=production`)
  folds the branch away — checked: the prod bundle keeps only the `dispose()` cleanup
  reference, the assignment is gone; the e2e bundle has it. The e2e build goes to
  `apps/web/e2e/dist` (ignored by `dist/`), never `apps/web/dist`, so a deploy can't pick it up.
- Hook typing: `e2e/hook.ts` declares only the fields the specs read and asserts
  `GameSession` satisfies it. `apps/web` `typecheck` is now `svelte-check … && tsc -p e2e`
  (+~1.3 s), so a refactor that breaks a field the e2e relies on fails `verify fast`, not
  only `verify full`.
- Where to click: computed with the app's own `scene.pick()` over a 5 px screen grid —
  canvas must be the top element (no HUD panel), cell solid and not keep/block, ±2 px
  neighbourhood on the same cell; nearest to the canvas centre. No hard-coded pixels, so
  camera/HUD layout changes don't break it.
- Routing (agreed with T-304): `#/stage/<id>` is the stable deep link; `?stage=<id>` is kept in
  the URL so the same test works before T-304 lands (T-304 rewrites `?stage=` to the hash
  and keeps other params like `backend`). T-304 also sets `data-screen` on `<html>`.
- Backend (agreed with T-205): `?backend=mock` is explicit in the default run (T-205 makes WASM
  the default); `?backend=wasm` is strict (no silent mock fallback), and the spec asserts
  `ready.backend === 'wasm'`. The wasm spec is skipped with a printed reason while
  `apps/web/src/solver/wasm/` (T-205) or `crates/fem-wasm/pkg/fem_wasm_bg.wasm` is missing.
- Port: `4179 + sha1(apps/web path) % 400` (4179–4578), `--strictPort`,
  `reuseExistingServer: false` — parallel worktrees get different ports instead of one
  silently testing another checkout's build. `retries: 0`, `workers: 2`.

**Measurements** (M-series Mac, headless chromium 156 / Playwright 1.64):
- this branch (mock; wasm spec skipped — T-205 not merged): whole command 4.4–5.0 s
  (build + preview ≈ 1.5 s, each test ≈ 2 s).
- with T-205 (7b315da) merged temporarily + `pnpm build:wasm`: 3 passed, 13.0 s wall
  (wasm test 4.0 s; HUD showed `wasm`, 301 iterations on w1-01 — Jacobi, because this pkg
  predates T-201 multigrid on main; T-205 expects ~10–13 with MG). Merge was reset afterwards.
  The mock tests took ~3.7 s each in that run vs ~1.9 s alone: likely CPU contention with
  the parallel wasm test (T-205 confirmed `?backend=mock` never fetches the wasm).
- flake check: `--repeat-each=8 --workers=4` → 16/16 passed (20.5 s).
- `scripts/verify.sh full` on this branch: all PASS, `e2e 5s` (perf-gate SKIP, no gate yet).

**Follow-ups.**
- CI (`.github/workflows/ci.yml`, not mine): add
  `pnpm --filter @stress-carve/web exec playwright install --with-deps chromium` before
  `verify.sh full`, and upload `apps/web/test-results/` on failure. On Linux the canvas
  check relies on SwiftShader WebGL; simulated locally with
  `--use-angle=swiftshader --enable-unsafe-swiftshader`: green, 7.3 s (not on Linux itself).
- `pnpm-lock.yaml` / `apps/web/package.json` also change in T-205: expect a trivial merge.
- Wave-3 features (T-301 judge, T-302 load test, T-303 section, T-308 thin wall) could each add
  one short spec here later (e.g. submit → result dialog; Space → deformation scale label).
