// Voxel picking by grid traversal (Amanatides & Woo DDA) in grid units — exact, independent
// of the rendered triangles, and filterable: `isHit` decides which cells stop the ray, so the
// section/X-ray views (T-303) can make clipped or faded cells transparent to picking.

import type { Face, Vec3 } from '@stress-carve/protocol';
import { FACE_DIRS, type Grid } from '../game/grid.ts';

export interface VoxelHit {
  element: number;
  cell: Vec3;
  /** the face of `cell` the ray entered through */
  face: Face;
  /** ray parameter at the entry point (same units as `dir`) */
  t: number;
  /** entry point, grid units */
  point: Vec3;
}

/**
 * First cell along `origin + t·dir` (grid units: voxel = 1, origin at the grid min corner)
 * for which `isHit(element)` is true, or null.
 */
export function raycastGrid(
  g: Grid,
  origin: Vec3,
  dir: Vec3,
  isHit: (element: number) => boolean,
  maxT = Infinity,
): VoxelHit | null {
  const dims = [g.nx, g.ny, g.nz];
  // clip the ray against the grid box [0, n]
  let tEnter = 0;
  let tExit = maxT;
  let enterAxis = -1;
  for (let a = 0; a < 3; a++) {
    const o = origin[a]!;
    const d = dir[a]!;
    const n = dims[a]!;
    if (Math.abs(d) < 1e-12) {
      if (o < 0 || o > n) return null;
      continue;
    }
    let t0 = (0 - o) / d;
    let t1 = (n - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tEnter) {
      tEnter = t0;
      enterAxis = a;
    }
    tExit = Math.min(tExit, t1);
  }
  if (tEnter > tExit) return null;

  const cell = [0, 0, 0];
  const step = [0, 0, 0];
  const tMax = [Infinity, Infinity, Infinity];
  const tDelta = [Infinity, Infinity, Infinity];
  for (let a = 0; a < 3; a++) {
    const d = dir[a]!;
    const p = origin[a]! + d * tEnter;
    const n = dims[a]!;
    let c = Math.floor(p);
    // on the entry face, the cell is the one inside the box
    if (a === enterAxis) c = d > 0 ? 0 : n - 1;
    cell[a] = Math.min(n - 1, Math.max(0, c));
    if (d > 0) {
      step[a] = 1;
      tDelta[a] = 1 / d;
      tMax[a] = (cell[a]! + 1 - origin[a]!) / d;
    } else if (d < 0) {
      step[a] = -1;
      tDelta[a] = -1 / d;
      tMax[a] = (cell[a]! - origin[a]!) / d;
    }
  }

  let t = tEnter;
  let axis = enterAxis;
  for (;;) {
    const e = cell[0]! + g.nx * (cell[1]! + g.ny * cell[2]!);
    if (isHit(e)) {
      // entry face: opposite to the step along the last crossed axis; if the ray started
      // inside this cell, fall back to the dominant direction
      const a = axis >= 0 ? axis : dominantAxis(dir);
      const dirIndex = a * 2 + (dir[a]! > 0 ? 0 : 1);
      return {
        element: e,
        cell: [cell[0]!, cell[1]!, cell[2]!],
        face: FACE_DIRS[dirIndex]!.face,
        t,
        point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
      };
    }
    // advance to the next cell
    let a: 0 | 1 | 2 = 0;
    if (tMax[1]! < tMax[a]!) a = 1;
    if (tMax[2]! < tMax[a]!) a = 2;
    t = tMax[a]!;
    if (t > tExit) return null;
    cell[a] = cell[a]! + step[a]!;
    if (cell[a]! < 0 || cell[a]! >= dims[a]!) return null;
    tMax[a] = tMax[a]! + tDelta[a]!;
    axis = a;
  }
}

function dominantAxis(dir: Vec3): number {
  const ax = Math.abs(dir[0]);
  const ay = Math.abs(dir[1]);
  const az = Math.abs(dir[2]);
  return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
}
