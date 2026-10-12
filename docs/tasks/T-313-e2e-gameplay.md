---
id: T-313
title: E2E gameplay specs — wasm carve loop, submit/result flow, stage select, load test
status: review
phase: 1
depends: [T-205, T-301, T-304]
owns:
  - apps/web/e2e/**
verify:
  - pnpm build:wasm
  - pnpm --filter @stress-carve/web e2e
---
## Goal
Extend the T-306 smoke suite to the MVP gameplay loop so Gate 1 (W1/W2 playtest) starts from a
machine-checked build.

## Requirements
- Un-skip `wasm.spec.ts` (real solver, converged result, `levels > 0`, `crossOriginIsolated`).
- Submit flow (T-301): 提出 enabled only for a current converged result → result card
  `section[aria-labelledby="result-title"]` → 重ねて比較 / 続けて削る → Esc closes; canvas does
  not carve while the card is open. Stars for a known carve on w1-01 (deterministic with mock).
- Stage select (T-304): title → W1 → stage → back; unlock after a ★1 clear; reload resumes
  the in-progress carve.
- Load test (T-302) and section/X-ray (T-303) if merged: one smoke step each.
- Whole suite < 60 s; no flakes over `--repeat-each=5`.

## Log

### 2026-10-12 — T-313 worker: gameplay e2e suite (status → review)

**Run it.** `pnpm build:wasm && pnpm --filter @stress-carve/web e2e` → 12 passed, 3 skipped
(reasons printed), 12.0–12.4 s wall on this machine (each test 0.9–2.9 s, 2 workers).
`E2E_RUN_FIXME=1 … e2e -g 途中` runs the known-bug repro below.

**Requirements.**
- [x] `wasm.spec.ts` un-skipped: fails with "run `pnpm build:wasm`" when pkg is missing (verify
  full / task verify build it first). Real solver: converged carve loop, `ready.levels > 0`,
  `crossOriginIsolated`, HUD badge `wasm`, then the T-301 judge on real output (w1-01 uncarved
  → 合格(星なし), 4 rules pass) → Esc.
- [x] Submit flow (`submit.spec.ts`, mock): 提出 enabled for the current converged block;
  disabled while a mouse carve is solved (MutationObserver log `[true, …, false]`); a current
  but *unconverged* result (re-delivered through `SolverClient.receive`, the public worker entry)
  disables it with the hint 構造が安定していません; card `section[aria-labelledby="result-title"]`
  (合格(星なし), 星 0, volume) → 重ねて比較 / 自分の形 → left click under the open card carves
  nothing and sends no request → Esc closes → 続けて削る closes and the next click carves →
  right-click undo closes an open card. Stars for a known carve (see below): 60.9 % → 合格(星なし)
  + goal line + 最適化解 29.9 % / +31.0 pt, then 47.9 % → クリア! ★1, +18.0 pt, 自己ベスト更新,
  no failed rule, 重ねて比較 switched on by itself, 次のステージへ.
- [x] Stage select (`campaign.spec.ts`, mock): title (はじめる, 星 0/N) → ステージ選択 → W1 tab
  selected, W2 locked, 1-1 open / 1-2 locked → 1-1 (`?backend=` survives) → ← ステージ選択
  (canvas + hook disposed, `#/select/w1`) → ← タイトル (つづきから). Unlock: 0-star pass is
  recorded (`星 0、最良 60.9%、途中 60.9%`) but 1-2 stays locked → back in, carve resumed
  (no undo) → ★1 → 次のステージへ opens w1-02 → select shows 1-1 ★1 47.9 %, 1-2 open, 1-3
  locked, クリア 1 / … → reload keeps it; title shows 星 1. Reload resume: mouse carve → autosave
  (key polled) → reload → same solid count/volume, canUndo false, 前回の続きから再開しました →
  最初から ×2 → 100 %, saved carve gone.
- [x] Load test (T-302, `views.spec.ts`): `loadTest.freezeAt = 3` (hold phase) → Space → badge
  `載荷テスト 変形 ×5 許容応力以内`, state playing/hold, runs 1, scale > 1, canvas draws,
  screenshot → Space → idle; with the result card open the button is disabled and Space is
  ignored. Section / X-ray (T-303): 断面 → `scene.views.view` = Z cut 2/4 with a section mask,
  slider ← → 1/4 reaches the scene, canvas draws; X線 → threshold 0.3, no mask; 通常 → both off.
  Thin-wall badge (T-308): hidden on the block, appears after the known slot (1-voxel bottom
  chord), toggles `aria-pressed`.
- [x] T-305 tutorial (`tutorial.spec.ts`): 1/N → 次へ ×2 → 3/N 青いところを削ろう → a mouse carve
  auto-advances to 4/N → スキップ → ヒント card; remembered after reload; チュートリアル restarts.
  Every other w1-01 flow skips it explicitly (`skipTutorial`, asserts it is visible first).
- [ ] T-310 env/debris: not on main → `env.spec.ts` is skipped with the reason, written against
  the hook T-310 announced (`scene.workshop.envReady`, `loadJigs()`, `debris.stats {ready, live,
  queued, spawned, piled, faded, lost, failed, mode}`; `?debris=physics`, off in the e2e build;
  Rapier lazy, one request). Header says how to activate.
- [x] < 60 s and no flakes: `--repeat-each=5` (2 workers) 60/60 passed in 52 s;
  `--repeat-each=5 --workers=4` at load average 9 (other agents) 60/60 in 54 s.

**Decisions.**
- *Known carve via synthetic strokes* (`brushStrokes` in game.ts): the exact controller calls the
  pointer input makes (`strokeStart(hit)` → `strokeEnd()`), hit given as cell + face — real
  brush/surface rule/history/batcher/solver, only screen picking skipped (mouse flows cover it).
  `W1_01_SLOT`: 5×5 brush on z+ at y = 3, centres 3/8/13 (→ 468 cells, 60.9 %, 0 ★) then 18
  (→ 368, 47.9 %, ★1, mock max utilisation 83 %). Verdicts worked out offline with game/judge on
  mockPhysics (scratch script, not committed); the mock is deterministic, so exact text is asserted.
- `reducedMotion: 'reduce'` in submit/campaign specs: no clear camera turn, so the overlay
  switch is immediate and deterministic. The load-test spec keeps motion (state `playing`).
- Hook (`e2e/hook.ts`) grew: `latestResult: ResultMsg`, `state.solid/stage.grid`,
  `strokeStart/strokeEnd`, `solver.ready.levels`, `solver.receive`, `scene.views.{view,
  sectionMask}`, `scene.loadTest.{active,current,freezeAt}` — all compile-checked against
  `GameSession`. No app source touched.
- `campaign.spec.ts` imports `CARVE_KEY_PREFIX` from `src/game/progress/records.ts` (runtime
  constant) instead of hard-coding the storage key.
- `skipReasons.ts` also prints `fixme` reasons and dedupes lines across `--repeat-each`.

**Bug found (follow-up for the T-304 area: App.svelte / ui/select/MenuScreen.svelte).** Leaving a
stage within the 500 ms autosave interval: `runner.close()` saves the carve in the session
`$effect` cleanup, but `MenuScreen` already took its records snapshot on mount, so the 1-1 card
shows no 途中 until a reload (the badge is right after reloading). Repro: `campaign.spec.ts`
"leaving right after a carve shows 途中…" — carves and clicks ← ステージ選択 in one task; fails
3/3 with `E2E_RUN_FIXME=1`, skipped (fixme) by default. Fix idea: save in `actions.select` /
before navigating, or snapshot in MenuScreen after the cleanup (e.g. `$effect.pre` / tick). The
main campaign flow waits for the autosave before leaving so it stays deterministic.

**Follow-ups.**
- T-310: when its wiring lands, delete the `test.skip` line in `e2e/env.spec.ts`, move the
  `EnvHook` fields into `e2e/hook.ts`, run the suite (T-310 needs `apps/web/e2e/env.spec.ts` +
  `hook.ts` under `touches`). Agreed by message with aff23da52ac2bd50b (c88cc59).
- Not covered yet: the clear camera turn itself, 最適化解のみ, carving on the section cap,
  browser back/forward between select and stage, W2 unlock (needs 8 W1 clears — could seed
  records through the versioned store).
- CI (T-306's note still open): `playwright install --with-deps chromium` before `verify.sh full`.
