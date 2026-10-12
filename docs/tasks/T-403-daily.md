---
id: T-403
title: Daily challenge (date-seeded generator, local record, share image/text)
status: todo
phase: 2
depends: [T-301]
owns:
  - apps/web/src/modes/daily/**
verify:
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web typecheck
---
## Goal
Design doc: デイリーチャレンジ — date-seeded stage generated in the browser, same for
everyone, local record, share as image + text.

## Requirements
- Deterministic PRNG (e.g. xoshiro128**) seeded from `YYYY-MM-DD` (UTC+9 day boundary, document it).
- Generator: W1/W2-sized domain, random support layout from a vetted set, 1–2 loads with
  random positions/directions; reject candidates whose supports leave rigid-body modes or whose
  full block fails; calibrate loads in-browser with a quick solve so the full block sits at
  ~35 % utilisation; targets relative to that (no offline benchmark available).
- Share: canvas snapshot PNG + text (`応力彫刻 デイリー 2026-10-12 ★★☆ 体積 41.2%`), Web Share
  API with clipboard fallback. Record per day in local storage.

## Acceptance criteria
- [ ] Same date ⇒ identical stage JSON (test); 30 consecutive dates all produce valid stages.

## Log
