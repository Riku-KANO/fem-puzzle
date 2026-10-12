---
id: T-305
title: W1 tutorial flow and full W1/W2 stage set (8–10 each)
status: review
phase: 1
depends: [T-203, T-301]
owns:
  - stages/src/**
  - apps/web/src/ui/tutorial/**
touches:
  - stages/*.json
  - apps/web/src/App.svelte
verify:
  - bash scripts/build-stages.sh --check
  - pnpm --filter @stress-carve/protocol test
---
## Goal
Design doc: ステージ設計 (W1 工房入門, W2 橋), リスク (応力表示の難しさ → W1をチュートリアル化).

## Requirements
- 8–10 stages per world with a difficulty ramp using the three knobs (target volume,
  allowable margin, keep/block obstacles); avoid "memorise the bone shape" (multiple load
  positions, obstacles).
- W1 tutorial overlay: utilisation %, highlight low-stress regions as hints, step-by-step
  first stage.
- Every stage calibrated by `topopt` and solvable: the benchmark design passes `judge`
  (`cargo run -p topopt --release -- judge <stage>` now; the web judge from T-301 later).
- Use the depth-count ASCII view of `benchmark.solid` (see T-203 Log / `topopt run --ascii`) to
  check each stage teaches something different (cantilever truss, tied arch, arch bridge,
  asymmetric loads, obstacles that break the textbook answer).
- Playability: the uncarved block should not be absurdly over-designed (w2-01 sits at 18 %
  utilisation — consider a per-stage design tweak); note concerns for playtest.

## Acceptance criteria
- [x] A test asserts every stage's benchmark passes the judge rules with the real solver.
  (`crates/topopt/tests/campaign.rs`, see Log.)

## Log

### 2026-10-12 — W1/W2 campaign (10 + 10 stages) and the w1-01 tutorial (status → review)

Last merged: main dcc065c (T-301, T-302, T-304 done). Commits on this branch: 613dcda (stage
set), f3016f0 (tutorial + content test), eb78ab1 (visible load arrows), 35ab17f, 0e581f7
(T-302 wiring).

**Stages.** 10 per world, unlock order = id order. Six starter ids kept; only w2-01 changed
(see below). Every stage teaches one idea; the knobs are geometry, supports, load
position/direction, keep and block (targets and the 0.9 margin come from `topopt calibrate`).
"full" = judged max utilisation of the uncarved block under the calibrated loads (real
solver, `topopt judge`). Volume = benchmark cells / initial cells; ★3 = volume + 0.05.

| id | title | grid | bench volume | full | teaches |
| --- | --- | --- | --- | --- | --- |
| w1-01 | はじめての片持ちはり | 24×8×4 | 0.2995 (230/768) | 0.443 | tutorial: reading the colour map; truss with top/bottom chords |
| w1-02 | 途中で押される片持ちはり | 24×8×4 | 0.2005 (154/768) | 0.414 | everything beyond the load is dead (blue) — carve it all |
| w1-03 | 柱のある片持ちはり | 24×8×4 | 0.3503 (269/768) | 0.445 | keep regions; use the protected pillar as a post |
| w1-04 | まっすぐ押す | 24×8×4 | 0.2995 (230/768) | 0.495 | load direction decides the path: axial load → straight bar, no truss |
| w1-05 | 看板の柱 | 12×20×4 | 0.3000 (288/960) | 0.363 | same reading on a floor support + sideways load: A-frame of two legs |
| w1-06 | 棚受け | 24×8×4 | 0.3997 (307/768) | 0.667 | distributed load (top layer is load = keep): fan of struts into the root |
| w1-07 | 窓のあいた板 | 24×8×4 | 0.4500 (288/640) | 0.713 | obstacles (block): the flow splits around the window, corners concentrate |
| w1-08 | 下だけ留めた腕 | 24×8×4 | 0.3451 (265/768) | 0.835 | partial support: bring the load down to a narrow fixing (knee brace) |
| w1-09 | クレーン | 24×16×4 (L) | 0.4498 (367/816) | 0.808 | L-shape: re-entrant corner, diagonal brace between arm and mast |
| w1-10 | 工房の卒業試験 | 24×8×4 | 0.4497 (313/696) | 0.623 | finale: inclined load + window + protected stub used as a strut |
| w2-01 | 両端で支えるはり | 32×5×8 | 0.3500 (448/1280) | 0.446 | neutral axis: chords work, web gets holes (I-beam), pin vs roller |
| w2-02 | 二点で押されるはり | 32×8×8 | 0.2998 (614/2048) | 0.526 | four-point bending: constant moment between loads, trapezoid truss |
| w2-03 | トンネルをまたぐ橋 | 32×8×8 | 0.4499 (691/1536) | 0.657 | tunnel block + keep deck: inclined legs past an obstacle to pinned abutments |
| w2-04 | 片寄った荷重 | 32×8×8 | 0.2002 (410/2048) | 0.393 | no symmetry: the nearer support takes more, lopsided truss |
| w2-05 | 両岸で押し返すアーチ | 32×8×8 | 0.2002 (410/2048) | 0.411 | same load as a beam but two pins: pure arch, no tie (contrast with w2-01) |
| w2-06 | 谷にかける橋 | 32×8×8 | 0.2500 (512/2048) | 0.414 | supports at deck level: the answer hangs below (V tie + post), use depth |
| w2-07 | 両側に張り出したはり | 32×8×8 | 0.2002 (410/2048) | 0.306 | overhangs: hogging over the supports, idle middle span |
| w2-08 | 三つの支点 | 32×8×8 | 0.3501 (717/2048) | 0.427 | continuous beam: tension on top over the middle support, two arches |
| w2-09 | 高さのちがう両岸 | 32×8×8 | 0.3502 (650/1856) | 0.589 | supports at different heights (rock block): asymmetric arch under a keep deck |
| w2-10 | 川をまたぐ道路橋 | 32×8×8 | 0.3500 (560/1600) | 0.504 | finale: off-centre river + deck + truck: arch on one side, short strut on the other |

Depth-count sketches of `benchmark.solid` (`topopt judge`; `#` = full depth, digit = solid
cells in that z-column, `x` = block, y up):

w1-01
```
|#######222222#22222222##|
|#     22222          22 |
|#       2222        #2  |
|#     22   22      22   |
|#    22     22    22    |
|#   22       22  22     |
|#  22        22222      |
|#############2222       |
```
w1-02
```
|#########22##           |
|#    2   222            |
|#      22222            |
|#     22222             |
|#    22222              |
|#   2#22                |
|#####2                  |
|####                    |
```
w1-03
```
|######22222##222222222##|
|#    222222##       222 |
|#      2222##      222  |
|#     22   ##     222   |
|#    22    ##    221    |
|#   22     ##   22      |
|#  22      ##2222       |
|#############222        |
```
w1-04
```
|#                       |
|#                       |
|#322                    |
|########################|
|########################|
|#322                    |
|#                       |
|#                       |
```
w1-05
```
|#           |
|##          |
|###         |
|# ##        |
|#  ##       |
|#   ##      |
|#    ##     |
|#     ##    |
|#     2##   |
|#     22#   |
|#     22##  |
|#    22 ##  |
|#   22   #2 |
|#  22    ## |
|# 22     2# |
|#22       ##|
|#2        2#|
|#2        2#|
|#2        ##|
|############|
```
w1-06
```
|########################|
|#2222 22   22    222    |
|#2222222 222    222     |
|#  22222222    ##2      |
|#   222222   2##        |
|# 2222222222222         |
|##32222222222           |
|#######22222            |
```
w1-07
```
|#############2   22222##|
|#2222  222  2###22   22 |
|#   2222xxxxxxxx##   22 |
|#    222xxxxxxxx 22 22  |
|#    222xxxxxxxx 22#2   |
|#   2222xxxxxxxx###2    |
|#2222  222  2####       |
|#############           |
```
w1-08
```
|   222######2222222222##|
|  2222    222        22 |
| #2222      22      22  |
|##2222       22    22   |
|##22221       22  #2    |
|##2222 22      2222     |
|###222222   222222      |
|###########22222        |
```
w1-09
```
|   3##########22222222##|
|  ##22    22222      22 |
| ##222    22  22    ##  |
|2#2222   22    22 222   |
|#2222#2222     22222    |
|#2222###########222     |
|#2222#                  |
|#   2#                  |
|#   2#                  |
|#   2#                  |
|#   2#                  |
|#   2#                  |
|#   2#                  |
|#   2#                  |
|#   2#                  |
|######                  |
```
w1-10
```
|##########2   11111111##|
|#222222 2####21      22 |
|#  222xxxxxx3222    222 |
|#   22xxxxxx22222   22  |
|#   22xxxxxx22  ## 33   |
|#  2222   2221  ####    |
|#322222222222222##3     |
|##########222222##      |
```
w2-01
```
|       22244446##644444222      |
|      222222444  6442222222     |
|244422222222422  224222222222442|
|66444222222244422444422222224444|
|##6442222444466##6644442222246##|
```
w2-02
```
|          ############2         |
|        4##          ##4        |
|       4662          2666       |
|      6662            2666      |
|     6642              2466     |
|    6642                2466    |
|4###64222              22246###6|
|####66666##############66666####|
```
w2-03
```
|################################|
|  44   6#6642      2466#6   44  |
|  42  4#644          446#4  24  |
|  42 6#642            246#6 24  |
|  446#64xxxxxxxxxxxxxxxx46#644  |
|  4##62 xxxxxxxxxxxxxxxx 26#74  |
|  ##6   xxxxxxxxxxxxxxxx   6##  |
|####    xxxxxxxxxxxxxxxx    ####|
```
w2-04
```
|        ####4222222222          |
|       ##  2222222222222        |
|      6#    22     222222       |
|      #6     22    22  222      |
|     6#       22  22    222     |
|    6#4        2222      222    |
|#####42   222222222       22222 |
|####44444444442222222222222224##|
```
w2-05
```
|             ######             |
|           6###  ###6           |
|         4666      6664         |
|       26664        46662       |
|      5666            6665      |
|    4666                6664    |
|  46662                  26664  |
|###66                      66###|
```
w2-06
```
|#66           2##2           66#|
|#6664        242242        4666#|
|   666      24422442      666   |
|    4662    242  242    2664    |
|     2664  2422  2242  4662     |
|       6#62242    24226#6       |
|        2##442    244##2        |
|          6##########6          |
```
w2-07
```
|##4444444444444444444444444444##|
| 664                        466 |
| 6442                      2446 |
|  444                      444  |
|   444                    444   |
|    444                  444    |
|     444                444     |
|      46##444444444466##66      |
```
w2-08
```
|      ####            ####      |
|     6##6#6          6#65#6     |
|    2##  664        466  ##2    |
|    ##   266        662   ##    |
|   6#4    466222222664    4##   |
|  4#4     246644446642     4#6  |
|  #64222222446644664422222246#  |
|###644444444446##644444444446###|
```
w2-09
```
|################################|
|  6    6####6       26####4442  |
|  6   4###4            6####4   |
|  6  4##6                6######|
|  646##6                  xxxxxx|
|  6###                    xxxxxx|
|  ###                     xxxxxx|
|####                      xxxxxx|
```
w2-10
```
|################################|
|   22 24442222          ###2    |
|   2444422222           6##2    |
|   46444222              6##    |
| 246xxxxxxxxxxxxxx        ##4   |
|4664xxxxxxxxxxxxxx         ##   |
|66  xxxxxxxxxxxxxx         6##  |
|##  xxxxxxxxxxxxxx          ####|
```

**Decisions**
- **w2-01 is now a 32×5×8 shallow beam** (was 32×8×8: full block 0.18, benchmark a 15 % tied
  arch at the sweep floor). Depth decides the regime: 32×7×6 is again a tied arch at 0.15
  (full 0.22); 32×6×8 gives a truss at 0.25 (full 0.31); 32×5×8 gives the I-beam with web holes
  the design doc asks for (中立軸付近が削れる理由) at 0.35, full 0.45. This needed the
  one-row update of the starter-stage expectation in `tools/blender/tests/test_export.py`
  (outside owns; `build-stages.sh --test` is green: 31 tests).
- **Loads must be "push" loads for now.** The load arrow is drawn with its tip on the loaded
  cells, pointing along the force, so a pull (free-end pull, hook under an arm, weight under a
  beam) puts the arrow inside the material — invisible (checked in the browser). w1-04
  therefore pushes towards the wall (identical von Mises field and benchmark as a pull),
  w1-09 loads the top of the arm end, and w2-06 became the deck-level bridge whose answer
  hangs below. All 20 arrows are visible.
- **Knob limits.** Targets (★3 = v + 0.05 …) and the margin (benchmark at 0.9) are fixed by
  `topopt calibrate`, so the ramp uses geometry: full-block utilisation rises through W1
  (0.44 → 0.84) and obstacles/keep appear from w1-03/w1-07 on; W2 alternates open stages
  with obstacle stages (w2-03, w2-09, w2-10). Textbook-breaking stages: w1-03, w1-07, w1-08,
  w1-10, w2-03, w2-06, w2-09, w2-10.
- **Solvability test: Rust, real solver** — `crates/topopt/tests/campaign.rs` (new file under
  the T-203 crate, as agreed with main), runs in `verify.sh fast` (0.35 s):
  - W1 and W2 each have 8–10 stages numbered w*N*-01.. without gaps;
  - unique non-empty titles, 1–3 hints, every load spread over ≥ 8 cells;
  - every benchmark: inside the domain, keep/support/load cells intact, loads and keep
    anchored (`design::is_valid`), volume ≤ ★3, and the player-mode judge
    (`driver::judge`, tol 1e-8) converges with loads connected, no floating cells and max
    utilisation ≤ 1 (and `maxDisplacement` if set);
  - the uncarved block converges, passes (< 1) and is not over-designed (≥ 0.25).
  T-301's web judge test (`apps/web/src/game/judge/judge.test.ts`) also runs all 20 stages
  (connectivity, keep, ★★★ with the stored utilisation) and is green.
- **Tutorial** (`apps/web/src/ui/tutorial/`): `steps.ts` is a pure 7-step machine
  (ようこそ → 色は応力の大きさ → 青いところを削ろう → 色の変化を見よう → 載荷テスト →
  星をめざそう → 提出しよう). Steps auto-advance from HUD snapshots (carved a voxel; volume
  ≤ 85 % with a settled result; load-test run counter increased; ★1 volume with utilisation
  ≤ 100 %; result screen opened) and always have 「次へ」/「スキップ」. The load-test counter
  is re-based when it first appears or drops (per-session counter, T-302). Finished/skipped is
  remembered in localStorage `stress-carve:tutorial-seen:v1` (try/catch, store injectable).
  - Low-stress hint glow: exposed, unprotected solid cells with utilisation < min(15 %,
    35 % of the current max) pulse (additive cyan instanced boxes in `scene.domain`, no edit
    to scene.ts; static when `prefers-reduced-motion`). On during the carve/watch/goal steps;
    in W1 a 「低応力を光らせる」 toggle in the hint card; hidden while the result screen is open
    or the load test deforms the part.
  - `StageGuide.svelte` sits under the stage panel: the tutorial on w1-01 (first visit), the
    stage hints (pager, open by default in W1, collapsed in W2) everywhere else, plus a
    「チュートリアル」 button on w1-01. App.svelte change: one import + one component.
- Browser check (mock backend, 1280×800): went through all 7 steps on `#/stage/w1-01` — carve
  click advanced step 3, 5×5 drags to 82.7 % advanced step 4 ("はじめ 45% → いま 57%"), Space
  advanced step 5, submit opened T-301's result screen and closed the tutorial; the hint card
  and glow toggle appear afterwards. e2e smoke (Playwright, mock) still passes.

**Measurements** (multigrid calibration on this machine): new stages 1.2–6.2 s (W1) and
7.5–12.1 s (W2) each; a build that recalibrates 15 stages took 130 s; `--check` with the
cache 12 s for 20 stages.

**Playtest concerns (Gate 1)**
- w2-04/05/07 (and w2-06) start loose (full 0.31–0.41) with benchmarks at 0.20–0.25:
  ★3 asks to carve ~75 % of 2048 cells. Watch for boredom; a per-stage margin would help.
- w1-08 and w1-09 start at 0.81–0.84: little room before red; fine as late W1 stages but
  check that new players do not break them on the first drag.
- w1-04 is deliberately trivial (a straight bar) as a breather; linear analysis has no
  buckling, so a slender compressed bar is "safe" in-game.
- The mock backend's utilisation differs from the real solver (w2-09 shows 108 % uncarved in
  the mock, 0.59 real). Tune nothing on the mock; replay after T-205.
- The glow threshold (15 %) was set by eye on the mock; recheck with the WASM backend.

**Follow-ups**
- Per-stage difficulty knob for the margin: let a stage source set the calibration
  utilisation target (e.g. 0.75 for w1-01..03, 0.95 for finales) or `--vmin`; needs a
  `stagekit`/exporter scene prop that stays out of the JSON + `topopt calibrate` support.
- Load jigs for pull loads (render/jigs.ts or T-310's env jigs): draw the arrow/weight
  outside the material when the force points away from the loaded face, so hanging loads
  become possible content again.
- If T-304 ever keeps StageGuide mounted across routes with a remount per session, the
  tutorial state survives restarts by design; key it by stage id if that is not wanted.
