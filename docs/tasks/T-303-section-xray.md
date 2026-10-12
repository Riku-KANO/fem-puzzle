---
id: T-303
title: Cross-section clipping (3 axes) and X-ray mode
status: doing
phase: 1
depends: [T-102]
owns:
  - apps/web/src/render/views/**
  - apps/web/src/ui/views/**
touches:
  - apps/web/src/App.svelte
  - apps/web/src/ui/SidePanel.svelte
verify:
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web typecheck
---
## Goal
Design doc: 断面ビュー, X線モード — 内部が見えない問題への対策 (highest UI priority).

## Requirements
- Section: axis toggle x/y/z + slider; Three.js clipping plane; the cut face is capped and
  coloured with the utilisation of the cut voxels (not just hollow).
- X-ray: elements below a utilisation threshold (slider, default 30 %) become translucent so
  only the load path stays opaque.
- Picking must ignore clipped / x-rayed-away voxels sensibly (carve what you see).

## Acceptance criteria
- [ ] Unit tests for the visibility/picking predicate.
- [ ] Works together with carving and the colour-map toggle; screenshot or description in log.

## Log
