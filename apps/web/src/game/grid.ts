// Voxel grid indexing (docs/specs/stage-format.md): element e = x + nx*(y + ny*z),
// node n = i + (nx+1)*(j + (ny+1)*k). Hot loops use these instead of the protocol helpers
// to avoid allocating Vec3 tuples.

import { FACES, type Face, type Vec3 } from '@stress-carve/protocol';

export interface Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** element count */
  readonly n: number;
  /** node count */
  readonly nodes: number;
}

export function makeGrid(dims: Vec3): Grid {
  const [nx, ny, nz] = dims;
  return { nx, ny, nz, n: nx * ny * nz, nodes: (nx + 1) * (ny + 1) * (nz + 1) };
}

export function cellIndex(g: Grid, x: number, y: number, z: number): number {
  return x + g.nx * (y + g.ny * z);
}

export function cellCoords(g: Grid, e: number): Vec3 {
  const x = e % g.nx;
  const yz = (e - x) / g.nx;
  const y = yz % g.ny;
  return [x, y, (yz - y) / g.ny];
}

export function inBounds(g: Grid, x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz;
}

export function nodeIndexOf(g: Grid, i: number, j: number, k: number): number {
  return i + (g.nx + 1) * (j + (g.ny + 1) * k);
}

export type Axis = 0 | 1 | 2;

export interface FaceDir {
  face: Face;
  axis: Axis;
  sign: 1 | -1;
  normal: Vec3;
}

/** Face directions in protocol order: x- x+ y- y+ z- z+ (index = direction id 0..5). */
export const FACE_DIRS: readonly FaceDir[] = FACES.map((face, i) => {
  const axis = (i >> 1) as Axis;
  const sign = i & 1 ? 1 : -1;
  const normal: Vec3 = [0, 0, 0];
  normal[axis] = sign;
  return { face, axis, sign, normal };
});

export function faceDir(face: Face): FaceDir {
  const d = FACE_DIRS[FACES.indexOf(face)];
  if (!d) throw new Error(`unknown face ${face}`);
  return d;
}

/** Face-adjacent neighbour of `e` in direction `dir` (0..5), or -1 outside the grid. */
export function neighbour(g: Grid, e: number, dir: number): number {
  const x = e % g.nx;
  const yz = (e - x) / g.nx;
  const y = yz % g.ny;
  const z = (yz - y) / g.ny;
  switch (dir) {
    case 0:
      return x > 0 ? e - 1 : -1;
    case 1:
      return x < g.nx - 1 ? e + 1 : -1;
    case 2:
      return y > 0 ? e - g.nx : -1;
    case 3:
      return y < g.ny - 1 ? e + g.nx : -1;
    case 4:
      return z > 0 ? e - g.nx * g.ny : -1;
    case 5:
      return z < g.nz - 1 ? e + g.nx * g.ny : -1;
    default:
      return -1;
  }
}

/** Count of set flags. */
export function countSet(flags: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < flags.length; i++) c += flags[i]!;
  return c;
}
