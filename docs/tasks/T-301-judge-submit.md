---
id: T-301
title: Judgement, submission, stars and benchmark comparison
status: review
phase: 1
depends: [T-202, T-203]
owns:
  - apps/web/src/game/judge/**
  - apps/web/src/ui/result/**
touches:
  - apps/web/src/App.svelte
  - apps/web/src/ui/Toolbar.svelte
verify:
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web typecheck
---
## Goal
Design doc: 判定条件 / スコア / 1ステージの流れ step 5.

## Requirements
- Pure, unit-tested `judge(stage, solid, result)` → per-rule pass/fail: strength (judged max
  utilisation ≤ 1 for every load case), connectivity (`loadsConnected`), stiffness
  (`maxDisplacement`, if set), keep intact. Volume fraction and stars from `targets`.
- A result that is not converged (mechanism / stalled CG, see solver.md) fails the design
  with an explanatory message ("構造が安定していません"), never passes.
- Submit button enabled only when the latest result is converged and for the current `seq`.
- Result screen: stars, volume %, per-rule status, "最適化解との差" (volume − benchmark),
  special badge when the player beats the benchmark; toggle to overlay the benchmark solid
  semi-transparently in the 3D view (design doc 演出: 最適化解と半透明で重ねて比較).

## Acceptance criteria
- [x] Unit tests for every rule including multi-case stages and edge cases (no benchmark).
- [x] Manual check in `pnpm dev` described in the log (screenshot if browser tools exist).

## Log

### 2026-10-12 — T-301 worker: judge, submit, result screen, benchmark overlay (status → review)

**Built** (branch `worktree-agent-a1a413f9c320a0781`, main merged at 1ff2bcb incl. T-308/T-311).
- `apps/web/src/game/judge/` (pure, no DOM/Three): `judge(stage, solid, result) → Judgement`
  (`passed`, `outcome` clear/noStars/fail, `stars`, `volumeStars`, `volumeFraction`, counts,
  per-rule `rules[]`, per-case `cases[]`, `benchmark` comparison, `beatsBenchmark`, `headline`);
  `starsFor(targets, v)`; `submitGate(hud)`; `submit(controller, hud) → Submission` with the
  `StageClear` record agreed with T-304 `{stageId, stars, volumeFraction, beatsBenchmark, solid}`.
- `apps/web/src/ui/result/`: `ResultScreen.svelte` (card over the stage panel: outcome, stars,
  volume, star targets, goal line, 最適化解 % + 最適化解との差 ±pt, アルゴリズム超え! badge,
  overlay toggle 自分の形 / 重ねて比較 / 最適化解のみ, per-rule ✓✗?– list with values, per-case
  table on multi-case stages, 続けて削る / ステージ選択へ / 次のステージへ), `resultSession.svelte.ts`
  (open/close, fires `onClear` once, `bestOf` read before recording → 自己ベスト更新, camera turn,
  left-button lock), `benchmarkOverlay.ts` (Three group under `scene.domain`), `resultText.ts`.
- Shared files: Toolbar (optional `canSubmit/submitTitle/submitHint/onSubmit` props on the 提出
  button), App (`ResultSession`, `actions.submit`, `<ResultScreen>` slot, gate `$derived`).
  **No scene.ts / voxelMesh edits** — the overlay is a separate group added via `scene.domain`.

**Rules / decisions.**
- Order: connectivity, keep, stability, strength, stiffness. Status `pass | fail | unknown | na`;
  passed ⇔ every rule pass/na. Strength/stiffness are `unknown` (not pass) when the loads are
  disconnected (trivial zero-load solve) or the solve did not converge — so a non-converged
  result can never pass; headline then reads 構造が安定していません.
- Thresholds: utilisation ≤ 1 and displacement ≤ `maxDisplacement` exactly (no epsilon, same as
  the HUD's `> 1` magenta); NaN fails. Multi-case: every case judged, worst case named.
- Connectivity = solver `loadsConnected` AND an own 6-neighbour BFS from the supported cells over
  the submitted flags (guards against a stale result).
- **Keep intact** = every effective-keep cell (keep ∪ supported ∪ load cells, protocol
  `effectiveKeep`) is solid *and* attached to a support. A floating protected part would drop as
  debris per the spec, so it fails (`保護領域が支点から切り離されています`). T-203's benchmark
  satisfies the same stricter rule (confirmed with T-203). Not written in stage-format.md
  "Derived rules" yet → follow-up below.
- Stars from the volume fraction only when passed (`≤ target + 1e-9`, as the HUD meter).
  Passed with volume > star1 → outcome `noStars` (0 stars; the StageClear is still fired, T-304
  unlocks only on stars ≥ 1).
- Benchmark (T-203 confirmed: `volume = popcount(bench)/popcount(stage.solid)`): relation
  beaten/tied/behind by **cell count** (exact), fallback to `benchmark.volume` when the bitmask
  does not decode; `beatsBenchmark` = passed && strictly fewer cells. No `benchmark` → null.
- Submit gate: enabled iff no error, not solving, `resultCurrent` (newest seq, no pending diff)
  and converged. When current but unconverged the button shows a hint 構造が安定していません.
- Result screen is a card, not a modal: right-drag orbit and wheel zoom keep working; the left
  button (carve) and hover brush preview are swallowed by a capture listener on the canvas
  parent while it is open. Any design change (e.g. right-click / ⌘Z undo) makes
  `hud.resultCurrent` false → the screen closes. Esc closes.
- Clear (≥ 1 star): camera turns once (OrbitControls autoRotate, stopped after 2π measured via
  `getAzimuthalAngle`, safety 15 s, any pointer press takes over; skipped with
  prefers-reduced-motion), then the overlay switches to 重ねて比較 unless the player chose a
  mode. Overlay: translucent cyan Lambert (depthWrite off, polygon offset so shared faces read
  tinted) + crease edges; 最適化解のみ hides `scene.voxels.group` and draws it opaque.

**Tests** (`src/game/judge/*.test.ts`, `src/ui/result/result.test.ts`): 64 new; web total
148 passing. Covers stars thresholds/rounding, every rule pass/fail/unknown/na, NaN, empty
cases, multi-case strength + stiffness + case names, not-converged never passes, connectivity
via solver flag and via own BFS (cut beam, edge-only contact), keep missing / support & load
cells protected / floating keep, benchmark behind/tied/beaten/failed-but-lighter/undecodable/
absent, gate matrix, submit with fake source and with the real GameController + mock worker host
(gate closes while a carve is pending), ResultSession (onClear once, no clear on fail, overlay
modes, no benchmark, gate closed, reopen does not stack, bestOf read before onClear), overlay
mesh quad counts. **Bundled stages**: for every `stages/*.json` the full block passes topology;
for every stage with a `benchmark` the benchmark bitmask passes connectivity + keep, ties with
itself and earns ★★★ — run against T-203's calibrated stages (cdfb1c2, checked out temporarily,
not committed): 44/44 judge tests green.

**Manual check** (`vite` from this worktree on :5301, Claude Browser pane, T-203's calibrated
stages checked out temporarily, mock backend):
- w1-01 full block → 提出 enabled → card 合格(星なし) "条件は満たしていますが、星の目標体積率に
  届いていません", ★ goal "★の目標は体積率 60% 以下です", 最適化解 29.9% · 差 +70.1 pt, all rules ✓,
  剛性 – 対象外. No camera turn (not a clear).
- design set to the benchmark bitmask (via `window.__stressCarve`) → クリア! ★★★ 29.9%, 差 ±0.0 pt
  (最適化解と同じ体積); camera turned once, then 重ねて比較 switched on by itself (everything
  tinted cyan since the shapes coincide). ⌘Z → card and overlay gone, carving state restored.
- rows y = 3..4 carved (79.2 %) → 重ねて比較 shows the cyan ghost truss inside the carved slot;
  最適化解のみ shows the opaque benchmark truss alone (player voxels hidden). Left click on the
  model while open did not carve (solid count unchanged); Esc closed it, the next click carved.
- beam cut through at x = 10 → 不合格 "荷重点が支点につながっていません": 連結 ✗, 保護領域 ✗
  (8 floating protected cells), 安定/強度 ? "荷重が支点に伝わっていないため判定できません".
- unconverged result injected (`controller.onResult({...latest, converged:false})`) → 提出
  disabled with the red hint 構造が安定していません next to it. No console errors.
- T-306's e2e smoke (`pnpm --filter @stress-carve/web e2e`, merged on a throwaway branch,
  deleted afterwards): 2 passed, wasm spec skipped.

**Verify**: `pnpm --filter @stress-carve/web test` 148 passed; `typecheck` 0 errors / 0
warnings; `bash scripts/verify.sh fast` all PASS.

**Coordination.** T-304: StageClear shape agreed; App wiring for them when they land later:
`result.onClear = actions.clear; result.bestOf = (id) => {…progress.record(id) → {stars,
volumeFraction: r.volume}}`, `<ResultScreen onNext onSelect>`, and `result.close()` before
disposing a replaced/closed GameSession — in T-304's App (e6fb228) that is first in the
session `$effect` cleanup and first in `actions.restart`, plus `$effect(() => () => result.dispose())`
for unmount (agreed with T-304; whoever lands later wires it). T-303 never toggles `scene.voxels.group` (their X-ray
ghost lives in `scene.views.group`; in 最適化解のみ it stays as the player left it). T-305: the
tutorial reads `result.submission !== null` (result screen open). T-302: may call
`scene.loadTest.stop()` from `actions.submit` once it lands (not wired here).

**Follow-ups.**
- Contract (main): add to stage-format.md "Derived rules" that protected cells must stay solid
  and connected to a support ("keep intact"), matching T-203's benchmark rule and this judge.
- T-306: e2e step for submit → result card → Esc (selectors: button `提出`, section
  `[aria-labelledby="result-title"]`, buttons 重ねて比較 / 続けて削る).
- With T-303's X-ray/section active, 最適化解のみ hides only the player's voxel group; consider
  resetting the view mode when the result opens (`scene.views.set({section:null,xray:null})`).
- Optional: Enter as a submit shortcut (ui/shortcuts.ts is not mine).
