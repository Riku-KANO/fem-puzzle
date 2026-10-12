// Brush cell selection (design doc 操作: ブラシは1、3×3、5×5). The square lies in the plane
// of the hit face: same layer as the hit cell along the face normal, spanning the two
// tangent axes. Only *surface* cells are carved — solid cells whose neighbour across the hit
// face is empty — so the brush shaves the visible layer and never digs into hidden material.

import type { Face, Vec3 } from '@stress-carve/protocol';
import { cellIndex, faceDir, inBounds, type Grid } from './grid.ts';

export type BrushSize = 1 | 3 | 5;
export const BRUSH_SIZES: readonly BrushSize[] = [1, 3, 5];

/** All in-grid cells of the brush square around `cell` in the plane of `face`. */
export function brushFootprint(g: Grid, cell: Vec3, face: Face, size: BrushSize): number[] {
  const { axis } = faceDir(face);
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const r = (size - 1) >> 1;
  const out: number[] = [];
  const c: Vec3 = [cell[0], cell[1], cell[2]];
  for (let dv = -r; dv <= r; dv++) {
    for (let du = -r; du <= r; du++) {
      c[u] = cell[u]! + du;
      c[v] = cell[v]! + dv;
      if (inBounds(g, c[0], c[1], c[2])) out.push(cellIndex(g, c[0], c[1], c[2]));
    }
  }
  return out;
}

export interface BrushContext {
  solid: Uint8Array;
  /** protected cells (effective keep) */
  keep: Uint8Array;
  /** obstacle cells; they hide what is behind them */
  block?: Uint8Array | undefined;
  /**
   * Cells removed earlier in the same drag. A cell exposed only because one of these was
   * removed is not carved, so one drag shaves one layer instead of drilling through.
   */
  strokeRemoved?: ReadonlySet<number> | undefined;
}

export interface BrushSelection {
  /** surface cells that will be removed */
  carve: number[];
  /** surface cells the brush covered but which are protected */
  protected: number[];
}

export function brushSelect(
  g: Grid,
  cell: Vec3,
  face: Face,
  size: BrushSize,
  ctx: BrushContext,
): BrushSelection {
  const { axis, sign } = faceDir(face);
  const carve: number[] = [];
  const prot: number[] = [];
  const c: Vec3 = [0, 0, 0];
  for (const e of brushFootprint(g, cell, face, size)) {
    if (!ctx.solid[e]) continue;
    // neighbour across the hit face must be empty for the cell to be on the surface
    c[0] = e % g.nx;
    c[1] = ((e - c[0]) / g.nx) % g.ny;
    c[2] = Math.floor(e / (g.nx * g.ny));
    c[axis] += sign;
    if (inBounds(g, c[0], c[1], c[2])) {
      const nb = cellIndex(g, c[0], c[1], c[2]);
      if (ctx.solid[nb] || ctx.block?.[nb] || ctx.strokeRemoved?.has(nb)) continue;
    }
    (ctx.keep[e] ? prot : carve).push(e);
  }
  return { carve, protected: prot };
}
