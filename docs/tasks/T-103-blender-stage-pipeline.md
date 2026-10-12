---
id: T-103
title: Blender stage pipeline — stagekit, voxelising exporter, W1/W2 starter stages
status: review
phase: 0
depends: [T-002]
owns:
  - tools/blender/**
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
- [x] All six stages build headlessly; JSON validates (protocol test reads `stages/*.json`).
- [x] Tests (inside Blender): box voxel count exact; axis conversion; a stage with only a
      roller support fails the rigid-mode check; a hand-made `.blend` path works.
- [x] `--check` passes on a clean tree.
- [x] `tools/blender/README.md` explains authoring a new stage in < 1 page.

## Log

### 2026-10-12 — implemented (status → review)

**Design**
- `tools/blender/stagecore.py` has no `bpy`. It holds:
  - the bitmask codec (numpy `packbits`, little bit order);
  - the canonical JSON writer `dumps`;
  - `validate_stage`, a rule-for-rule mirror of `validateStage`/`Stage::validate` with the same messages;
  - `check_stage`, which adds exporter-only checks: rigid-mode rank = 6, single 6-connected
    solid, support faces on the solid boundary, non-zero force, unique cells, id pattern, and
    warnings for single-cell loads and hint counts outside 1–3.
- `voxelize.py` turns a scene into a stage dict.
  - The `domain*` union is voxelised. The grid comes from the domain bounds in stage axes:
    n = extent/h, rounded when within 1e-3 (float32 mesh coordinates), otherwise ceil.
  - Inside test: BVHTree ray parity with 3 skewed rays and a majority vote. Role meshes must be
    closed; non-closed meshes are rejected with a message.
  - Matrices and modifiers are honoured because the evaluated depsgraph is used.
  - `solid = domain & ~block`.
  - Supports and loads are sorted by object name; cells by element index.
- `stagekit.py` provides authoring helpers. Boxes are given in stage *cell* coordinates and created
  in Blender metres. Sources are `stages/src/<id>.py`.
- `export_stage.py` is the CLI (`--source`, `--out`, `--expect-id`, `--save-blend`).
  - Any error exits 1 and nothing is written.
  - Without `-b` the built scene stays open for inspection. This UI path was not exercised headlessly.
- Supports: added an optional `whole_face` support prop, which exports `{face, fix}` without
  `cells`. The W1 walls use it, matching the design doc example. It is not a contract change:
  the spec already allows supports without `cells`.
- `scripts/build-stages.sh`: one headless Blender process per source.
  - Exports into a temp dir, runs `calibrate_hook`, then copies (build) or `cmp`/`diff`s (`--check`).
  - `--check` also flags missing and orphan JSON.
  - `--test` runs `tools/blender/tests/run_tests.py`.
  - `$BLENDER` overrides the Blender path. Logs go to `.artifacts/stages/<id>.log`.
- **T-203 hook**: `calibrate_hook()` in `scripts/build-stages.sh`, between
  `# >>> T-203 hook: chain topopt calibrate here` and `# <<< T-203 hook`.
  - It runs on the fresh temp dir (`$1`) in both build and `--check`, before stages/ is touched.
  - T-203 plans the body `cargo run -q -p topopt --release -- calibrate --write --cache "$ROOT/stages" "$1"/*.json`.
- **JSON format** is byte-identical to `serde_json::to_string_pretty(&serde_json::Value) + "\n"`.
  - Keys are sorted (BTreeMap), 2-space indent, all arrays expanded.
  - f64 fields are always floats (`-500.0`, `70000000000.0`); usize fields are integers.
  - serde float layout: `0.00001`, `1e-7`, `1e+16`. `-0.0` is written as `0.0`.
  - Absent optionals are omitted: `block`, `benchmark`, `loadCases`, `maxDisplacement`, empty `hints`.
  - Verified with a scratch Rust crate: all six files survive a `Value` round-trip byte-for-byte
    and pass `Stage::from_json`. Golden float strings from serde_json 1.0.154 are in `test_stagecore.py`.
- Added `tools/blender/.gitignore` (`__pycache__/`), and the exporter sets `dont_write_bytecode`.

**How to add a stage**: see `tools/blender/README.md` ("Add a stage").
1. Copy `stages/src/w1-01.py` to `stages/src/<id>.py` (the file name is the id).
2. Edit the boxes, given in cell coordinates.
3. Run `bash scripts/build-stages.sh`.
4. Commit the source and the JSON together.

**Stages**: aluminium E=70e9, ν=0.33, allowable 120e6, density 2700, h=0.01 m. Targets are
provisional at 0.7/0.55/0.45. "σ beam" is a rough beam-theory peak for the uncarved block, ignoring
support and corner concentration.

| id | grid | solid | keep | block | supports | loads | σ beam |
| --- | --- | --- | --- | --- | --- | --- | --- |
| w1-01 はじめての片持ちはり | 24×8×4 | 768 | 0 | 0 | x- whole face, xyz | 3 kN down, 2×1×4 strip at x22–23, y7 | ≈16 MPa (0.13) |
| w1-02 途中で押される片持ちはり | 24×8×4 | 768 | 0 | 0 | x- whole face, xyz | 6 kN down, x11–12, y7 | ≈17 MPa (0.14) |
| w1-03 柱のある片持ちはり | 24×8×4 | 768 | 64 (pillar x11–12, full height) | 0 | x- whole face, xyz | 4 kN down, x22–23, y7 | ≈22 MPa (0.18) |
| w2-01 両端で支えるはり | 32×8×8 | 2048 | 0 | 0 | pin y- xyz at x0–1 + roller y- y at x30–31; 2×1×8 strips | 20 kN down, x15–16, y7 (16 cells) | ≈18 MPa (0.15) |
| w2-02 二点で押されるはり | 32×8×8 | 2048 | 0 | 0 | same as w2-01 | 2 × 12 kN down at x10–11 and x20–21, y7 | ≈14 MPa (0.12) |
| w2-03 トンネルをまたぐ橋 | 32×8×8 | 1536 | 0 | 512 (tunnel x8–23, y0–3, all z) | two pinned abutments, y- xyz at x0–1 and x30–31 | 12 kN over the whole deck y7 (256 cells, so the deck is protected) | ≈21 MPa (0.18) |

- The rigid-mode rank is 6 for every stage, and each solid is a single connected piece.
- w2-03 uses two pins rather than pin + roller, so an arch can thrust against the abutments.
- T-202's Node smoke test (fem-wasm with the T-101 solver) solves all six stages. Results are
  converged and finite, nothing floats, and surface carves work. Cold solve times: 7 ms (W1),
  24 ms (w2-01/02), 11 ms (w2-03).
- T-202 also measured the uncarved judged max utilisation (fem 8d44d07, Jacobi, tol 1e-4; the
  solver is still in progress, so treat these as provisional). All are well under 1:

  | stage | utilisation |
  | --- | --- |
  | w1-01 | 0.108 |
  | w1-02 | 0.108 |
  | w1-03 | 0.144 |
  | w2-01 | 0.101 |
  | w2-02 | 0.110 |
  | w2-03 | 0.047 |

  w2-03 is far below the beam estimate because its two pins let it carry the load as an arch.

**Tests** (`bash scripts/build-stages.sh --test`, 31 tests, about 2 s):
- codec matches the contract example (`AQI=`);
- serde float golden values and pretty layout;
- every `validateStage` rule;
- rigid modes: clamp and pin + roller pass; only a roller or two rollers fail; a collinear node line leaves a rotation free;
- connectivity;
- exact box voxel counts at offset placements, h=0.007 and the W1/W2 sizes;
- domain union with a block;
- axis conversion from raw Blender boxes (stage (3,2,1) ↔ Blender (0.035, -0.015, 0.025));
- the exporter CLI rejects a roller-only source with exit 1 and no file;
- `--expect-id` mismatch is rejected;
- **hand-made .blend**: built with bpy.ops primitives (rotated and scaled cubes, a UV-sphere keep
  marker, int force typed by hand), saved, then exported in a subprocess. The result is
  byte-identical to the equivalent stagekit source;
- every starter source builds deterministically with the expected counts.

**Verify** (2026-10-12):
- `build-stages.sh --test`: OK (31 tests).
- `--check`: "✓ stages up to date (6 stages)".
- `pnpm --filter @stress-carve/protocol test`: 7 passed.
- `verify.sh fast`: all PASS.

**Follow-ups / open**
- T-203: fill the body of `calibrate_hook`. Calibration rescales forces and sets targets and
  benchmark, so run `--check` after that lands.
- CI: Blender is not on the CI runner, and `build-stages.sh --check/--test` is not part of
  `verify.sh`. Options: a CI job that downloads Linux Blender 5.2 LTS, or keep this as a local
  gate. Owner: T-001/T-309.
- The root `.gitignore` has no `__pycache__/`. Covered locally by `tools/blender/.gitignore`; a
  root entry is optional.
- No contract change needed.
- The loads are spread over strips, but stress at the support-strip edges and at the w2-03 tunnel
  corners will be higher than beam theory. T-203 calibrate step 3 checks the full block.
