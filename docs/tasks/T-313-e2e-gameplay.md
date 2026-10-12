---
id: T-313
title: E2E gameplay specs — wasm carve loop, submit/result flow, stage select, load test
status: doing
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
