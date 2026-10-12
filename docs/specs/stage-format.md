# Stage format (contract)

> **Contract file.** Rust (`crates/stage`), TypeScript (`packages/protocol/src/stage.ts`),
> JSON Schema (`packages/protocol/stage.schema.json`) and the Blender exporter
> (`tools/blender/export_stage.py`) must all agree with this document.
> Changing it requires a task that updates all four plus their tests.

A stage is a single JSON file (`stages/<id>.json`). Source definitions live in
`stages/src/` (Blender `.blend` or procedural `.py`), built files are committed.

## Coordinates and indexing

- Units: metres, newtons, pascals. Y-up (glTF convention).
- Grid `[nx, ny, nz]` of cubic voxels of edge `voxelSize` (m). The domain spans
  `[0, nx*h] × [0, ny*h] × [0, nz*h]` with the origin at the min corner.
- **Element (voxel) index**: `e = x + nx * (y + ny * z)` for cell `(x, y, z)`.
- **Node index**: `n = i + (nx+1) * (j + (ny+1) * k)` for node `(i, j, k)`.
- **DOF index**: `3 * n + c`, `c ∈ {0: x, 1: y, 2: z}`.

## Bitmasks

`solid`, `keep`, `block` and `benchmark.solid` are bitmasks over elements:

- bit for element `e` lives in byte `e >> 3`, bit position `e & 7` (LSB first);
- byte length is `ceil(nx*ny*nz / 8)`; unused trailing bits are 0;
- encoded as standard base64 **with** padding (RFC 4648 §4).

## Fields

| field | type | meaning |
| --- | --- | --- |
| `version` | `1` | format version |
| `id` | string | e.g. `w1-03`; also the file name |
| `title` | string | display name (Japanese ok) |
| `world` | int | 1..5 (0 = sandbox / daily) |
| `grid` | `[nx, ny, nz]` | voxel counts |
| `voxelSize` | number | edge length in m |
| `material` | `{E, nu, allowable, density?}` | Pa, -, Pa, kg/m³ |
| `solid` | bitmask | initial design domain (material present) |
| `keep` | bitmask | protected voxels: cannot be carved, excluded from the stress judgement. `keep ⊆ solid` |
| `block` | bitmask? | obstacles: never material, rendered as obstacle geometry. `block ∩ solid = ∅` |
| `supports` | `Support[]` | see below |
| `loads` | `Load[]` | the (single) load case |
| `loadCases` | `{name, loads}[]?` | W4+: if present, judged on every case; `loads` is then ignored |
| `maxDisplacement` | number? | stiffness rule: max load-point displacement magnitude (m) |
| `targets` | `{star1, star2, star3}` | volume-fraction thresholds (fraction of the *initial* solid count), `star1 > star2 > star3` |
| `benchmark` | `{volume, solid, maxUtilization, method}?` | offline optimiser result (`crates/topopt`) |
| `hints` | string[]? | tutorial text |

### Support

```json
{ "face": "x-", "fix": "xyz" }
{ "face": "y-", "fix": "y", "cells": [[0, 0, 0], [0, 0, 1]] }
```

- `face` ∈ `x- x+ y- y+ z- z+`. `fix` is a non-empty subset of `xyz`.
- Without `cells`: every node on that boundary face of the **grid** that belongs to at
  least one initially-solid element is fixed.
- With `cells`: only the nodes on the given face *of each listed cell* are fixed.
- **Supported cells** of a support: the listed `cells`, or — without `cells` — every
  initially solid cell touching that grid face (`Stage::support_cells` / `supportCells`).
  Supported cells are implicitly protected (treated as `keep`), and connectivity to
  supports is measured from exactly these cells (an element that merely shares a fixed
  node with a supported cell is *not* supported).

### Load

```json
{ "cells": [[23, 0, 0], [23, 0, 3]], "force": [0, -500, 0] }
```

- `force` is the **total** force (N) of this load, split equally among `cells`;
  each cell's share is split equally among its 8 nodes (distributed load, avoids
  point singularities).
- Loaded cells are implicitly protected (treated as `keep`).

## Derived rules used by the game

- *Volume fraction* = remaining solid count / initial solid count.
- *Connectivity*: 6-neighbour (face) adjacency over solid voxels. Every load cell must
  be in a component that contains a supported cell (see Support). Solid components with no
  support are "floating": excluded from analysis and dropped as debris.
- *Strength*: max von Mises utilisation over solid, non-keep voxels ≤ 1.
- *Stiffness* (optional): max load-point displacement ≤ `maxDisplacement`.
