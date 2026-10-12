---
id: T-407
title: Export the carved part as STL/glTF
status: todo
phase: 2
depends: [T-102]
owns:
  - apps/web/src/export/**
verify:
  - pnpm --filter @stress-carve/web test
---
## Goal
Design doc: 書き出しの約束 (プレイヤーの完成形をSTLやglTFで書き出し → Blender / 3D printing).

## Requirements
- Export the current solid as binary STL (merged outer surface, metres → mm option) and glb
  (Three.js GLTFExporter) from the result screen; watertight surface from the voxel mesher.

## Acceptance criteria
- [ ] STL of a solid box has 12 triangles and correct normals; exported mesh is watertight (test).

## Log
