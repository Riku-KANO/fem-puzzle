# Gate 1 — W1/W2 MVP playtest sheet

Design doc ロードマップ: "W1・W2だけのMVPを公開して試遊してもらいます". Gate 1 is a human
decision. Agents collected the tuning questions below while building; answer them by playing.

## How to run

```bash
pnpm install
pnpm build:wasm
pnpm dev            # http://localhost:5173  (?backend=mock to compare with the heuristic)
```

## Questions to answer

| # | Question | Knob / where | Raised by |
| - | --- | --- | --- |
| 1 | Is the stress colour map readable in the first minute without the tutorial? | tutorial `apps/web/src/ui/tutorial/` | design doc |
| 2 | Tutorial "low stress" glow threshold (15 %) right with the **real** solver? | tutorial threshold | T-305 |
| 3 | W1 load-test deformation visible enough (plates bend ≤ 0.4 voxel)? | `TARGET_FRACTION` in `render/deform/deform.ts` | T-302 |
| 4 | Star thresholds fair? (★3 = benchmark + 5 %) w2-04…07 need ~75 % carved for ★3 | topopt calibrate targets | T-203, T-305 |
| 5 | w1-08 / w1-09 start near 0.8 utilisation — too tight for W1? | stage sources | T-305 |
| 6 | World unlock: W2 opens after 75 % of W1 cleared (8 of 10) — ok? | `WORLD_UNLOCK_RATIO` (T-304) | T-304 |
| 7 | One layer per drag + double-click never carves — intuitive? | `game/brush.ts`, `render/gesture.ts` | T-102 |
| 8 | X-ray default threshold 30 % useful? Section default axis (thinnest) ok? | T-303 views | T-303 |
| 9 | Thin-wall count in voxels vs "N か所" regions? | T-308 | T-308 |
| 10 | Does carving feel instant (W2 ≈ 7.5 ms/carve in Chrome)? Safari/Firefox untested | perf | T-204, T-205 |
| 11 | Per-stage stress margin needed (T-314)? | T-314 | T-305 |
| 12 | Does the load cylinder (0.245 m) hide short W2 beams from the default camera? | camera (T-102) / jig scale (T-307) | T-310 |
| 13 | Debris: fun or distracting? (`?debris=physics`, reduced-motion fades instead) | T-310 | T-310 |
| 14 | First load acceptable? Rapier chunk 1.67 MB gzip (lazy); cold shader cache ~135 ms env map | T-309 / T-310 | T-310 |

## Known gaps (not bugs)

- Safari / Firefox not measured (agents only have Chromium).
- No records-reset screen (`ProgressStore.resetAll` exists).
- Multi-load-case stages (W4+) animate only the worst case in the load test.
