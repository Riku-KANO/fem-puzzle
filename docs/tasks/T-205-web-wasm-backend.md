---
id: T-205
title: Web WASM backend — real solver in the worker with progressive display
status: done
phase: 0
depends: [T-102, T-202]
owns:
  - apps/web/src/solver/wasm/**
touches:
  - apps/web/src/solver/worker.ts
  - apps/web/src/solver/backends.ts
  - apps/web/src/game/boot.ts         # ?backend= → options (approved by main)
  - apps/web/src/game/controller.ts   # fallback toast in onReady (approved by main)
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
- [x] vitest (node) test drives the backend through the worker message handler with the
      real wasm (skipped with a clear message when `pkg/` is absent).
- [x] In `pnpm dev` carving re-solves with the real solver; colours visibly settle;
      stale results are discarded under rapid carving. Log per-carve times for W1/W2.
      (With multigrid a carve is one 3–9 ms solve, so colours change in one step; progress
      snapshots appear for solves > `progressEveryMs`, e.g. Jacobi — see Log.)

## Log

### 2026-10-12 — T-205 worker: WASM backend in the worker (status → review)

**Built** (`apps/web/src/solver/wasm/`):
- `wasmBackend.ts` — `WasmBackend implements Backend` over the fem-wasm `Session`.
  `solve`: one `await hooks.yield()` + cancel check up front (see below), `iterate(0)` (runs
  the implicit `begin()` — active set, MG update, warm start — outside the per-iteration
  timing; an unchanged set after a cancelled solve continues instead of restarting), then
  time-boxed chunks: `chunkSize(msPerIter)` = 8 ms / smoothed ms-per-iteration (first chunk
  8 it, clamp 1..4096, estimate kept across solves). Between chunks: `progress` with
  `utilization(0)` when `progressDue()`, `yield`, cancel check. Result readback per case
  (fresh typed arrays from wasm-bindgen, transferable), `converged = done && rel_residual <=
  tol` (tol = `options.tol ?? 1e-4`, the Session default). `dispose` → `free()` once.
  `createWasmBackend` passes only `tol/maxIters/preconditioner` as optionsJson.
  `wasmBackendFactory(load)` (strict) and `wasmWithFallback(mock, load)`: only a *load*
  failure falls back (console.warn with the reason); a stage the solver rejects is an `error`.
- `femWasm.ts` — typed subset of the package (`WasmSession`, `StepStatus`, `FemWasmModule`)
  + `loadFemWasm()` (dynamic `import('fem-wasm')` + default init, cached; failures not
  cached). The typed assignment checks the real `pkg/fem_wasm.d.ts` whenever pkg exists
  (verified: a wrong field type fails svelte-check).
- `femWasmStub.ts` — same export shape; init/initSync/`new Session` throw
  "fem-wasm is not built (run `pnpm build:wasm`, then restart Vite)". The only non-Svelte
  default export (mirrors wasm-bindgen's `__wbg_init`).
- `options.ts` — `backendFromUrl(search)`; `yield.ts` — `messageChannelYield()`.
- Wiring: `backends.ts` (none → `wasmWithFallback(mock)`, `'wasm'` → strict, `'mock'` →
  mock), `worker.ts` (`yieldFn: messageChannelYield()`: setTimeout(0) is clamped to 4 ms
  once nested, which would add 4 ms per chunk), `boot.ts` (`...backendFromUrl(location.search)`
  into the solver options — approved by main), `controller.ts` (`onReady`: toast
  `MESSAGES.wasmFallback` when `ready.backend === 'mock'` but mock was not requested; the
  existing badge keeps showing `mock`), `vite.config.ts` (alias `fem-wasm` → pkg if
  `pkg/fem_wasm.js` and `_bg.wasm` exist, else the stub; resolved at startup — **restart
  Vite after `pnpm build:wasm`**), `tsconfig.json` (paths fallback array pkg → stub; the old
  mapping to `fem_wasm.js` never resolved the `.d.ts` — "implicitly has an any type" — so it
  is now extensionless).
- `vite build` emits `assets/fem_wasm_bg-*.wasm` (265 KB, 114 KB gzip) + a 6 KB glue chunk
  that only the worker loads (`new URL(..., import.meta.url)` is rewritten by Vite);
  without pkg the 0.3 KB stub chunk is emitted instead.

**URL semantics:** no param → WASM, mock fallback with toast; `?backend=wasm` → WASM only
(load failure = `error`, HUD shows 解析エラー; T-306's wasm e2e relies on this);
`?backend=mock` → mock (no wasm fetched, no toast). Checked all three in the browser,
including the fallback with pkg moved away (toast + `mock` badge + worker console.warn).

**Tests** (`src/solver/wasm/wasmBackend.test.ts`, 23): fake-Session unit tests (chunk
sizing, progress only when due, skip when a request is already waiting, cancel at a chunk
boundary + continue, mechanism ⇒ not converged, info/free); selection/fallback/URL/stub/HUD
toast; and with the real package through `SolverHost` (results cloned with transfer like
postMessage): ready (wasm, levels > 0), converged seq 0, load point moves along −y;
warm carve == cold solve of the carved stage (util field within 1 %); queued carves → only
the newest solved, both diffs applied; a burst delivered one task apart → solved once
(fails without the up-front yield); Jacobi progress snapshots (seq 0, increasing
iterations, then the result); mid-solve carve and mid-solve cancel (injected on the 2nd
yield, i.e. after the first chunk); setSolid round trip; protected-cell error keeps the
session usable; w1-01/w2-01 cold + five 3×3 carves converged. Without pkg: 11 skipped,
the suite title says "skipped: crates/fem-wasm/pkg is not built (run `pnpm build:wasm`)".

**Burst / stale handling (Chrome, raw worker, w1-01):** 10 carves posted in one task —
before the up-front yield every carve was solved (10 results, 31.8 ms); after it only seq 10
is solved (1 result, 2.7 ms). Jacobi (multi-chunk) gave `[10]` either way. Through the UI
(24 single-voxel carves ~4 ms apart, solves 2–3 ms): 24 results, 8 arrived stale and were
dropped by `SolverClient`, the last result was current. Progress posts: none with MG
(solves < 60 ms); with Jacobi on w2-01 a carve takes 70 ms (≈350 it) and posts snapshots.

**In-browser per-carve timings** (for docs/perf-results.md — T-204 asked for this format).
Chrome 152 (Claude Browser pane, Chromium/Electron, tab hidden), macOS 26.6.2, Apple
M5 Pro; **load average 11–13 from other agents' builds**, so ±50 % run-to-run (one w2-01
run had a 16 ms median). Dev server (unbundled modules), release wasm, tol 1e-4, stages
as calibrated by T-203 on main. *Load* = post `init` to `result` seq 0 received (worker
module load + wasm fetch/compile + Session ctor + cold solve; *ready* in brackets);
*warm* = `result.elapsedMs` (host-timed `backend.solve` = iterate + readback; `set_solid`
is just flagging), median / max over 6–9 carves of a 3×3 top-surface patch; *RTT* = post
`carve` → `result` received incl. transfer; *apply* = `SolverClient.receive` → controller
(colour repaint, HUD), from the page session.

| browser | stage + grid | precond | load ms (ready) | cold ms (it) | warm med / max ms (it) | RTT med / max ms | apply ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Chrome 152 | w1-01 24×8×4 | MG, 2 levels | 17.5 (15.1) | 2.3 (10) | 3.1 / 3.9 (10–13) | 3.2 / 4.1 | 0.05–0.16 |
| Chrome 152 | w1-02 24×8×4 | MG, 2 | 18.7 (15.0) | 3.5 (9) | 3.1 / 5.1 (2–11) | 3.3 / 5.3 | – |
| Chrome 152 | w1-03 24×8×4 | MG, 2 | 20.4 (17.1) | 3.3 (10) | 3.8 / 4.3 (10–13) | 4.0 / 4.5 | – |
| Chrome 152 | w2-01 32×8×8 | MG, 2 | 28.2 (21.9) | 6.1 (9) | 7.5 / 8.9 (8–10) | 7.7 / 9.0 | 0.12–0.28 |
| Chrome 152 | w2-02 32×8×8 | MG, 2 | 34.7 (28.7) | 5.9 (10) | 7.4 / 8.9 (8–9) | 7.5 / 9.1 | – |
| Chrome 152 | cantilever 40×12×12 (W4-sized) | MG, 3 | 59 (30.8) | 28.0 (11) | 22.9 / 26.7 (8–10) | 23.1 / 27.0 | – |
| Chrome 152 | w2-01 32×8×8 | Jacobi | 18.7 | 38.6 (177) | 70.6 / 74.5 (191–361) | 70.7 / 74.6 | – |

Node through `SolverHost` (vitest, same machine, pre-calibration stages): w1-01 carve
median 2.5 / max 2.8 ms, w2-01 5.8 / 6.3 ms. RTT exceeds the in-worker time by only
0.1–0.4 ms (postMessage + transfer). Main-thread apply had one 1.5 ms outlier (GC).
Not measured: Safari/Firefox (agents only have Chromium) and frame render time (hidden tab).

**Visual check** (dev on :5180 and `vite preview` of the production build on :5187, both
stopped): w1-01 shows `解析完了 · 反復 10 · wasm`; uncalibrated stages read 11 % (w1-01) /
10 % (w2-01) as expected; after merging T-203's calibration w1-01 starts at 44 % with a
green band along the top at the clamped root (bending tension) and blue toward the free
end; 3×3 carves along the beam raise it to 47 % within one frame. w2-01: grey clamp + teal
roller, 10 % → 11 % after notching the front face. No console errors.

**verify:** `pnpm build:wasm`, web test (106), web build, T-306 `e2e` (3/3 incl. the wasm
spec), `verify.sh fast` all green; web typecheck/test/build also green with pkg moved away.

**Follow-ups / notes**
- HUD could show the MG level count from `ready.levels` next to the backend badge
  (hudState/SidePanel — not in this task's paths).
- A WASM trap (Rust panic, `panic = abort`) leaves the Session unusable: the host reports
  `error`, but nothing rebuilds the backend. Option: controller re-sends `init` + `setSolid`
  with the current bitmask after a fatal error.
- Safari/Firefox timings still open (T-204's JSC/SpiderMonkey risk).
- The Claude Browser pane is shared between parallel agents: another agent navigated my tab
  mid-measurement. Use your own tab (`tabs_create` + explicit `tabId`) — maybe worth a line
  in docs/loop/README.md lessons.
- With `?backend=wasm` and no package the HUD stays "解析エラー" with no `ready` (by design).
