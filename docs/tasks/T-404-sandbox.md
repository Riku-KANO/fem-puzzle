---
id: T-404
title: Sandbox editor with URL-compressed stage sharing
status: todo
phase: 2
depends: [T-301]
owns:
  - apps/web/src/modes/sandbox/**
verify:
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web typecheck
---
## Goal
Design doc: サンドボックス — place loads, supports and the design domain freely; share the
stage compressed into the URL (no server).

## Requirements
- Editor mode: resize grid (≤ 60×20×20), paint domain/keep/block voxels, add supports (face +
  fix) and loads (cells + force vector gizmo), material preset.
- Serialise the Stage JSON → deflate (CompressionStream) → base64url in `#/sandbox/<data>`;
  version prefix; graceful error for corrupt links. Validate with `validateStage`.
- Play the shared stage with the normal game screen (no stars without targets → show volume only).

## Acceptance criteria
- [ ] Round-trip tests: stage → URL → stage is identical; URLs for 60×20×20 stay < 8 KB typical.

## Log
