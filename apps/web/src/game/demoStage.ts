// Built-in demo stage, used when no `stages/*.json` exist (and as a test fixture):
// a 24×8×4 aluminium cantilever, x- face clamped, downward load along the top edge of the
// x+ end. Numbers are hand-tuned so the full block sits at ~35 % utilisation in the mock.

import { encodeBitmask, type Stage } from '@stress-carve/protocol';

export const DEMO_STAGE_ID = 'demo-cantilever';

export function buildDemoStage(): Stage {
  const [nx, ny, nz] = [24, 8, 4];
  const n = nx * ny * nz;
  const solid = new Uint8Array(n).fill(1);
  return {
    version: 1,
    id: DEMO_STAGE_ID,
    title: 'デモ: 片持ち梁',
    world: 0,
    grid: [nx, ny, nz],
    voxelSize: 0.01,
    material: { E: 70e9, nu: 0.33, allowable: 120e6, density: 2700 },
    solid: encodeBitmask(solid),
    keep: encodeBitmask(new Uint8Array(n)),
    supports: [{ face: 'x-', fix: 'xyz' }],
    loads: [
      {
        cells: [
          [nx - 1, ny - 1, 0],
          [nx - 1, ny - 1, 1],
          [nx - 1, ny - 1, 2],
          [nx - 1, ny - 1, 3],
        ],
        force: [0, -9000, 0],
      },
    ],
    targets: { star1: 0.7, star2: 0.55, star3: 0.45 },
    hints: ['左端は壁に固定、右端の上面に下向きの荷重。', '応力の低い青い部分から削ろう。'],
  };
}
