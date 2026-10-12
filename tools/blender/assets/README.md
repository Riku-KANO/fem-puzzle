# Environment assets (T-307)

Procedural Blender 5.2 scripts (text only, no `.blend`) that build the workshop, the jigs,
debris, the crack decal and the toolbar icons into `apps/web/public/assets/`.

```bash
bash tools/blender/assets/build.sh                # everything + review renders in previews/
bash tools/blender/assets/build.sh --no-previews  # skip the review renders
bash tools/blender/assets/build.sh --check        # rebuild in a temp dir, byte-compare, size budget
BLENDER=/path/to/blender bash tools/blender/assets/build.sh   # other Blender binary
```

Runs headless (`-b --factory-startup`) in ~15 s. Exports are deterministic: fixed seeds,
CPU light baking, plain `.glb` (no Draco/meshopt — the whole folder is < 1.5 MB, so the
web app needs no decoder), our own PNG writer for the decal, Cycles-CPU + stripped PNG
metadata for the icons. `--check` compares every `.glb`, `crack_decal.png` and
`manifest.json` byte for byte (exact on the same Blender 5.2.x build/platform), checks that
the icons exist at 128×128 and that the folder stays under 1.5 MB. `python3 glbstat.py
<files>` prints vertex/size stats.

| file | what |
| --- | --- |
| `workbench.glb` | bench + steel test bed (0.72 × 0.42 m, top at y = 0), vise, mug, notebook; baked, unlit |
| `workshop.glb` | room around it (4 × 3.15 × 2.73 m): window, pegboard, shelf, cabinet, lamp; baked, unlit |
| `jig_clamp.glb` | fixed support: bolted fixture plate + hatched block |
| `jig_pin.glb`, `jig_roller.glb` | pin / roller supports |
| `jig_riser.glb` | stand from the bench up to a support |
| `jig_cylinder.glb` | hydraulic pusher (load), yellow with arrow fins |
| `jig_weight.glb` | hanging slotted weights (load, downward only) |
| `jig_spreader.glb` | load-spreader plate (unit size, scale to the patch) under a cylinder |
| `debris.glb` | `chip_0..3` (convex, 6–11 mm) + `swarf_0` curl |
| `crack_decal.png` | 512² dark cracks, straight alpha, centred, radius ≤ 0.47 |
| `crack_tile.png` | 256² seamlessly tileable crack mask (alpha), ~1 tile per voxel face |
| `icons/*.png` | 128 px: `brush-1/3/5`, `undo`, `redo`, `load-test`, `submit` |
| `manifest.json` | sizes, bounds, node names and the metadata below |

Sources: `build_assets.py` (entry), `assetkit/` (mesh builder, light baker, export/render
helpers, PNG I/O), `assetdefs/` (one module per family, `palette.py` for colours).

## Conventions

Metres, Y-up glTF. Every asset root node carries its metadata as glTF `extras`
(three.js: `object.userData`), duplicated in `manifest.json`. Named parts are child nodes;
a part with several materials loads in three.js as a `Group` of that name (move/scale the group).

**Bench / room.** Shared frame: origin = centre of the test-bed top surface, camera side
= +Z, wood top y = −0.03, floor y = −0.93, back wall z = −0.55. Place both at
`(domainCentreX, domainMinY − 0.16, domainCentreZ)` in the stage frame: the part floats
16 cm above the bed (room for hanging weights, risers and falling chips). Lighting is
baked into `COLOR_0` (linear) with `KHR_materials_unlit` → `MeshBasicMaterial`; set
`toneMapped = false` to match the previews. The baked key light is a warm lamp above the
bench at (0, 0.95, −0.12) plus sun from the window on the −X wall: put the realtime
directional light roughly at (−1, 1.3, 0.35) so jigs/part agree with it. Walls are
single-sided (camera outside the room sees through them). Debris colliders (boxes,
`center`/`halfExtents`) are in the workbench root's `extras.colliders`.

**Jigs.** Origin = centre of the contact patch on the domain surface.

- *Supports* (`jig_clamp`, `jig_pin`, `jig_roller`): local **+Y = outward normal** of the
  supported face, the jig lives in y ≥ 0; local X = the patch's long axis (pin axis).
  Choose: `fix = "xyz"` on a whole face → clamp (scale local X/Z by
  `(patchSize + 0.02) / 0.10`, box geometry scales cleanly); `fix = "xyz"` with `cells` →
  pin; `fix` ⊊ xyz → roller (pin/roller: scale X by `patchLength / 0.08`). Depth along +Y:
  clamp 0.054, pin/roller 0.06.
- *Riser*: origin on the bench top (y = 0 in the workbench frame); `riser_column` spans
  y ∈ [0, 1] — set `riser_column.scale.y` to the gap up to the jig's underside.
- *Loads*: local **−Y = force direction F̂** (unit force). `jig_cylinder` pushes: put it on
  the face whose outward normal ≈ −F̂ (the exposed face "behind" the load); body in
  y ∈ [0, 0.245]. `jig_weight` pulls and is only for F̂ ≈ −Y: put it on the underside
  (outward normal ≈ +F̂); it hangs in y ∈ [−0.125, 0]. If the load cells' face opposite to
  F̂ is covered by material, use the weight (downward) or the cylinder on the far side.
  When the patch is wider than the Ø 0.032 pad (all current W1/W2 loads: 2 × 4 or 2 × 8
  cells, w2-03 the whole top), put `jig_spreader` at the contact point, scaled X/Z to the
  patch size in metres (unit plate, 0.008 thick), and the cylinder on top of it at
  `contact − 0.008 · F̂`.
- *Animation* (load test): `cylinder_rod` can retract up to `rodTravel` = 0.04 along +Y
  (rest pose = pad touching); `weight_stack` / the whole root move along −Y. During the
  deformation, translate the load jig root with the (scaled) displacement of its patch.

Rotation for a jig: build the basis `X = tangent, Y = n (support) or −F̂ (load),
Z = X × Y`, then apply the per-axis scale. `previews.py::scenes` does exactly this for a
w1-01 (clamp + riser, spreader + cylinder) and w2-01 (pin, roller, risers, spreader + cylinder).

**Materials.** Jigs: `jig_paint` (metal 0, rough 0.55), `jig_steel` (metal 0.6, rough
0.35), `jig_rubber`; albedo × mild AO in `COLOR_0`. Metals need an environment map
(e.g. three.js `RoomEnvironment` + PMREM) or they render dark. Debris: one `debris`
material, neutral grey albedo so per-instance colours (e.g. the voxel's stress colour)
multiply cleanly; `extras.pieces` gives volume, mass (aluminium 2700 kg/m³) and half
extents; chips are convex → Rapier `convexHull` from the vertex positions.

**Cracks.** Straight alpha (not premultiplied), sRGB, RGB = dark crack colour, alpha =
mask. `crack_decal.png`: project centred on an over-stressed face (`DecalGeometry`, or a
quad with `polygonOffset`, `depthWrite = false`), 1.5–3 voxels wide, random rotation about
the normal. `crack_tile.png`: sample with `RepeatWrapping` at one tile per voxel face
(e.g. face-local UV = fract(rest-space position / voxelSize)) and mix by alpha.

## Adding or changing an asset

Edit the module in `assetdefs/`, run `build.sh`, look at `previews/*.png`, commit the
scripts, `apps/web/public/assets/**` and the previews together (`--check` must pass).
Keep shapes low-poly: the whole folder must stay < 1.5 MB.
