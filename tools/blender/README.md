# tools/blender — stage pipeline

Stages are authored as Blender scenes and exported headlessly to `stages/<id>.json`
(contract: `docs/specs/stage-format.md`). Sources are text: `stages/src/<id>.py` builds the
scene with `stagekit`. A hand-made `stages/src/<id>.blend` that uses the same naming works
too, but prefer `.py` (diffable).

| file | role |
| --- | --- |
| `stagekit.py` | authoring helpers used by sources (`stage_props`, `domain_box`, `support`, `load`, `keep`, `block`) |
| `voxelize.py` | scene → stage dict: voxelises `domain*` meshes, collects role objects |
| `stagecore.py` | no `bpy`: bitmask codec, canonical JSON, `validateStage` mirror, rigid-mode/connectivity checks |
| `export_stage.py` | CLI: build → check → write `<out>/<id>.json` (exit 1 on any error) |
| `tests/` | run inside Blender: `bash scripts/build-stages.sh --test` |

## Add a stage

1. Copy a source, e.g. `cp stages/src/w1-01.py stages/src/w1-04.py`. The file name is the id.
2. Edit it. Boxes are in **stage cell coordinates** (Y-up). `lo`/`hi` are cell boundaries,
   so `(0,0,0)..(24,8,4)` is 24×8×4 cells. Keep the domain's min corner at `(0,0,0)`.
   ```python
   import stagekit as sk
   sk.stage_props(id="w1-04", title="日本語タイトル", world=1, hints=["…"])  # aluminium, h = 0.01 m
   sk.domain_box((0, 0, 0), (24, 8, 4))            # several domain boxes are united
   sk.support("wall", (0, 0, 0), (1, 8, 4), face="x-", fix="xyz", whole_face=True)
   sk.load("tip", (22, 7, 0), (24, 8, 4), force=(0, -3000, 0))  # total N, stage axes
   sk.keep("pillar", (11, 0, 0), (13, 8, 4))       # protected cells
   sk.block("tunnel", (8, 0, 0), (16, 3, 4))       # obstacle, removed from the domain
   ```
3. Run `bash scripts/build-stages.sh`. It prints grid/solid/keep/block counts per stage.
   Commit the source and `stages/<id>.json` together. CI-style drift check: `--check`.
4. Inspect in the UI: `"$BLENDER" --factory-startup -P tools/blender/export_stage.py -- --source stages/src/w1-04.py`.
   This is a dry run, and the built scene stays open.

Rules of thumb:
- Spread loads over a strip, e.g. 2×1×nz on the top. Single cells cause stress singularities.
- Spread supports across the depth (z). A pin is `fix="xyz"` and a roller is `fix="y"`, both on `face="y-"`.
- Loads and targets are provisional. `topopt calibrate` (T-203) rescales `force` and sets
  `targets`/`benchmark` in the build step.

## Naming convention (also for hand-made .blend)

- `domain*`: closed meshes. Their union is the design domain. The grid origin is the min corner
  of their bounds, and `n = extent / voxel_size`.
- `support_*`: custom props `face` (`x-`…`z+`), `fix` (subset of `xyz`), and optionally `whole_face`.
  - `whole_face=True` exports `{face, fix}` without `cells`. The whole grid face is fixed and
    the marker must lie in that boundary layer.
  - Otherwise the cells are listed, and `face` must be on the solid's boundary.
- `load_*`: custom prop `force` = `[fx, fy, fz]`, total newtons in **stage** axes.
- `keep_*` and `block_*`: no props. They select the cells whose **centres** lie inside them.
  The test is ray parity against closed meshes, so any shape, rotation, scale or modifier works.
- Scene custom props:
  - required: `stage_id`, `title`, `world`, `voxel_size`, `material_E`, `material_nu`, `material_allowable`
  - optional: `material_density`, `targets` `[s1,s2,s3]` (default 0.7/0.55/0.45), `hints` (string list), `max_displacement`

Export a .blend with:
`"$BLENDER" -b --factory-startup file.blend -P tools/blender/export_stage.py -- --out stages/`.

## Axes and checks

Blender is Z-up and stages are Y-up (glTF). Stage `(x, y, z)` = Blender `(x, z, -y)`. Only the
exporter converts axes (`stagecore.blender_to_stage`). Element index is `x + nx*(y + ny*z)`.

Before writing, the exporter enforces:
- the contract rules (same as `validateStage`);
- supports remove all 6 rigid-body modes (rank of the rigid-mode matrix at the fixed DOFs = 6);
- the solid is a single 6-connected piece;
- support faces lie on the boundary;
- forces are non-zero;
- the id matches the source file name.

Output is canonical, so `--check` can byte-compare:
- sorted keys, 2-space indent, trailing newline;
- floats as serde_json prints them (`70000000000.0`, `-500.0`, `1e-7`).

This equals Rust's `serde_json::to_string_pretty(&Value) + "\n"`, so Rust tools can rewrite
stages without drift.
