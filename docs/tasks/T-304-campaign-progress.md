---
id: T-304
title: Stage select, campaign progression and local records
status: review
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
- [x] Unit tests for the storage module (versioning, corrupt data, unavailable storage).

## Log

### 2026-10-12 — T-304 worker: campaign, records, resume, routing (status → review)

**Built.** Verify: web typecheck (svelte-check 0 warnings), web vitest 253 tests (6 new files,
86 T-304 tests), `vite build`, T-306 e2e (2 passed, wasm skipped: T-205 not on main),
`scripts/verify.sh fast` all green. Main merged at ac64fb9 (incl. T-301, T-303, T-306, T-308,
T-311). T-303: `views.setStage(grid)` is called in `bindSession` (stage switch and restart);
checked section view on w1-01 (z cut 2/4) → switch to w2-01 keeps 断面 with the cut reset to
4/8.

**Module map.**
- `game/progress/storage.ts` — `VersionedValue<T>`: JSON envelope `{v, data}`; load never
  throws and reports `empty | ok | migrated | corrupt | newer`. Corrupt (bad JSON, bad
  envelope, invalid shape, older version without migration, throwing migration/parse) → raw
  copied to `<key>:corrupt`, key removed, value reset. Newer version → ignored *and*
  read-only (save/remove refuse, so an old cached build never destroys newer progress).
  `migrations[v]` upgrades v → v+1 step by step. `browserStorage()` probes localStorage with a
  write (SecurityError, sandbox, quota 0 → null).
- `game/progress/records.ts` — `ProgressStore`: key `stress-carve:progress` (v1:
  `{records: {[stageId]: StageRecord}, last}`) and `stress-carve:carve:<stageId>` (v1:
  `{solid, volume, savedAt}`). Unavailable storage → in-memory `MemoryStore`
  (`persistent=false`): unlocks/resume work until the tab closes. Writes are
  read-modify-write with a per-record best-of merge (two tabs do not lose clears). Invalid
  records are dropped one by one. `StageRecord = {stars (max), volume (min), beatBenchmark (OR),
  clears, firstAt, lastAt, solid (design of the best volume)}`.
- `game/progress/campaign.ts` — pure unlock rules: worlds ascending, stages in catalogue
  order; next stage opens on clear (≥ 1 star; a 0-star pass is recorded but does not
  unlock); world w+1 opens at `ceil(0.75 × stages)` clears of world w (10 stages → 8);
  world 0 (demo/sandbox) always open. `nextUnlockedStageId`, `continueStageId` (つづきから).
- `game/progress/session.ts` — `StageRunner`: `open(stage)` starts a session via the injected
  `startGame`, applies the saved carve through the public GameSession API (CarveState carve
  + `history.clear()` → no undo entry, `scene.solidChanged`, `solver.carve` after `init`),
  autosaves every 500 ms when the bitmask changed (identical to the authored block → key
  deleted) and on `pagehide`/hidden; `close()` saves then disposes; `restart()` drops the
  carve and reopens. boot.ts is untouched.
- `ui/select/routes.ts` (pure) + `router.svelte.ts` (`HashRouter`, runes): `#/` title,
  `#/select[/w<n>]`, `#/stage/<id>` (stable deep link, opens locked stages too — locks only
  gate the select UI). Unknown path → title; unknown stage → select + notice; hash
  normalised with replaceState. Legacy `?stage=<id>` → `#/stage/<id>` keeping other params
  (`?backend=`), an existing hash wins. World tab switches use replaceState.
- `ui/select/` components: `MenuScreen` (title/select switch; snapshots records on mount),
  `TitleScreen` (はじめる/つづきから + target stage, ステージ選択, total stars, storage warning),
  `StageSelect` (world tabs with lock + stars, cards: number, title, best ★/volume, grid,
  最適化解超え badge, 途中 volume, locked hint; keyboard tabs with ←/→), `GameMenu` (in-game
  ← ステージ選択 and 最初から with a second-press confirm, "前回の続きから再開しました"),
  `selectView.ts` (pure labels/warnings).
- `App.svelte` (touch): router + `entry`/`stage` `$derived`; `game` is `$state.raw` and
  changes per opened stage (null on menus); session lifecycle in one `$effect` (+
  `bindSession`, T-308's thin-wall attach moved there); `<main hidden={!entry}>`;
  `<MenuScreen>` after main; `<html data-screen="title|select|stage">` (T-306 waits on it);
  game shortcuts ignored off-stage (Space must activate menu buttons). `actions.clear/next/
  select` are the T-301 hooks.

**Agreed with T-301** (StageClear contract, structural, in their `game/judge` and my
`records.ts`): `{stageId, stars 0..3, volumeFraction, beatsBenchmark, solid}` fired once per
passed submit. T-301 landed first (839bf53), so I wired it in App.svelte when merging main
(44326bf): `result.onClear = (c) => actions.clear(c)`; `result.bestOf` maps `record.volume`
→ `volumeFraction` (read before recording → 自己ベスト更新); `<ResultScreen onNext={actions.next}
onSelect={actions.select}>`; `result.close()` first in the session `$effect` cleanup and in
`actions.restart` (before the old GameSession is disposed); `$effect(() => () =>
result.dispose())` for unmount (replaces T-301's onMount cleanup).
**Agreed with T-306**: deep link `/?backend=mock#/stage/<id>`; `?stage=` keeps working;
data-screen on `<html>`; fresh Playwright context ⇒ no resume. Trial-merged their branch and
ran their e2e green before they landed; green again after merging main.

**Browser check** (vite from this worktree, :5314, Claude Browser pane): title → はじめる opens
w1-01; carving to 92.2 % then reload resumes 92.2 % with the resume note and undo disabled;
← ステージ選択 disposes the canvas (0 canvases) and shows 1-1 "途中 92.2 %", 1-2/1-3 locked;
injected records (★3 + benchmark, ★1, ★2) → W1 cleared 3/3, W2 unlocked, title shows
つづきから 両端で支えるはり; `?backend=mock&stage=w1-02` → `?backend=mock#/stage/w1-02`;
`#/stage/w9-99` → `#/select` + notice; 最初から (two presses) → 100 %, saved carve removed;
back/forward between select and stage switch sessions cleanly; 375 px wide: no horizontal
scroll; Space on a focused card opens it. After merging T-301 (calibrated stages on main):
saved carve = w1-01 benchmark bitmask → resumed at 29.9 %, 提出 → クリア! ★★★, record
`{stars 3, volume 0.2995, beatBenchmark false (tie), clears 1}` stored; 次のステージへ →
`#/stage/w1-02` (old session and result card gone, one canvas); ステージ選択へ → 1-1 ★★★ 最良
29.9 %, 1-2 open, 1-3 locked, "クリア 1 / 3 ・ あと 2 ステージで ワールド2 解放". No console
errors after reload.

**Follow-ups / notes.**
- `game/stages.ts::pickInitialStage` (+ its test) is now unused — remove in a T-102-owned
  cleanup.
- Records store the submitted bitmask of the best volume (≤ 1 KB/stage): ready for a
  "show my best" overlay or STL export (T-407).
- No "erase records" UI yet (`ProgressStore.resetAll` exists) — settings screen later.
- With T-305's 10-stage worlds, W2 opens after 8 W1 clears (`WORLD_UNLOCK_RATIO`); tune at
  the Gate 1 playtest.
- The daily challenge (T-403) can reuse `VersionedValue` for its per-day record.

