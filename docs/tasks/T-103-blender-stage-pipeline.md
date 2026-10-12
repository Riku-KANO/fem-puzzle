---
id: T-103
title: Blender stage pipeline — stagekit, voxelising exporter, W1/W2 starter stages
status: doing
phase: 0
depends: [T-002]
owns:
  - tools/blender/**
  - '!tools/blender/assets/**'   # T-307 builds environment assets in parallel
  - stages/**
  - scripts/build-stages.sh
verify:
  - bash scripts/build-stages.sh --test
  - bash scripts/build-stages.sh --check
  - pnpm --filter @stress-carve/protocol test
---
## Goal
Stages are authored in Blender (design doc: Blenderアセットパイプライン / ステージ作成フロー)
and exported headlessly to `stages/<id>.json` in the contract format.

Blender: `/Applications/Blender.app/Contents/MacOS/Blender` (5.2 LTS, Python 3.13,
numpy bundled). Allow override with `$BLENDER`. Run headless only (`-b --factory-startup`).

## Read first
- `docs/specs/stage-format.md` (normative), `packages/protocol/src/stage.ts` (validation rules)

## Design
- **Text sources, no binary .blend in git**: each stage is `stages/src/<id>.py`, which
  builds the scene through a small helper module `tools/blender/stagekit.py`
  (`domain_box(...)`, `support(...)`, `load(...)`, `keep(...)`, `block(...)`,
  `stage_props(...)`). Artists may also author a `.blend` by hand using the same
  naming convention; the exporter treats both the same.
- **Naming convention** (design doc): design domain `domain*` meshes; `support_*`
  (custom props `face`, `fix`), `load_*` (custom prop `force` = [fx, fy, fz] N in
  *stage* axes), `keep_*`, `block_*`. Support/load/keep/block objects select the cells
  whose centres lie inside them. Scene custom props: `stage_id`, `title`, `world`,
  `voxel_size`, `material_E/nu/allowable`, `targets`, `hints`.
- **Axes**: Blender is Z-up, stages are Y-up (glTF). Stage `(x, y, z)` = Blender
  `(x, z, -y)`; the grid origin is the min corner of the domain bounds. Document it in
  `tools/blender/README.md` and test it.
- **Voxeliser**: cell-centre inside test against the domain mesh (BVHTree ray parity or
  equivalent), grid size from domain bounds / voxel size.
- **Exporter** `tools/blender/export_stage.py` (`blender -b [file.blend] -P export_stage.py -- --out stages/`):
  writes pretty JSON with sorted keys matching the contract, validates it (same rules as
  `validateStage`) **and** checks that the supports remove all 6 rigid-body modes
  (rank of the rigid-mode matrix at fixed DOFs = 6, numpy).
- `scripts/build-stages.sh`: builds every `stages/src/*.py` → `stages/*.json`;
  `--check` rebuilds to a temp dir and diffs against committed JSON (drift check);
  `--test` runs `tools/blender/tests/` inside Blender. Leave a clearly marked hook where
  T-203 will chain `topopt calibrate` after export.

## Starter stages (loads/targets are provisional; T-203 calibrates them)
- W1 (24×8×4, voxel 0.01 m, aluminium E=70e9 ν=0.33 allowable 120e6):
  `w1-01` cantilever, end load down (tutorial); `w1-02` cantilever, load at mid-span top;
  `w1-03` cantilever with a keep pillar in the middle.
- W2 (32×8×8): `w2-01` simply supported, centre load (pin xyz at one bottom end, roller
  at the other — make sure rigid modes are removed); `w2-02` two-point load;
  `w2-03` bridge with a `block` tunnel under the deck.
- Japanese `title`, 1–3 `hints` each (W1 hints teach reading the colour map).

## Acceptance criteria
- [ ] All six stages build headlessly; JSON validates (protocol test reads `stages/*.json`).
- [ ] Tests (inside Blender): box voxel count exact; axis conversion; a stage with only a
      roller support fails the rigid-mode check; a hand-made `.blend` path works.
- [ ] `--check` passes on a clean tree.
- [ ] `tools/blender/README.md` explains authoring a new stage in < 1 page.

## Log
