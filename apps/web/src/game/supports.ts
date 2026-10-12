// Support semantics (docs/specs/stage-format.md "Support", docs/specs/solver.md `supported`):
// which nodes are fixed, and which elements count as supported (≥ 1 fixed node).

import { decodeBitmask, elementCount, type Stage, type Support, type Vec3 } from '@stress-carve/protocol';
import { cellIndex, faceDir, makeGrid, nodeIndexOf, type Grid } from './grid.ts';

/** Cells whose `face` carries the support: listed cells, or every initially-solid boundary cell. */
export function supportCells(stage: Stage, s: Support, initialSolid?: Uint8Array): Vec3[] {
  if (s.cells) return s.cells;
  const g = makeGrid(stage.grid);
  const solid = initialSolid ?? decodeBitmask(stage.solid, elementCount(stage.grid));
  const { axis, sign } = faceDir(s.face);
  const dims = [g.nx, g.ny, g.nz];
  const layer = sign > 0 ? dims[axis]! - 1 : 0;
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const out: Vec3[] = [];
  const c: Vec3 = [0, 0, 0];
  c[axis] = layer;
  for (let j = 0; j < dims[v]!; j++) {
    for (let i = 0; i < dims[u]!; i++) {
      c[u] = i;
      c[v] = j;
      if (solid[cellIndex(g, c[0], c[1], c[2])]) out.push([c[0], c[1], c[2]]);
    }
  }
  return out;
}

/** The 4 node indices on `face` of `cell`. */
export function faceNodes(g: Grid, cell: Vec3, face: Support['face']): number[] {
  const { axis, sign } = faceDir(face);
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const p: Vec3 = [cell[0], cell[1], cell[2]];
  p[axis] = cell[axis]! + (sign > 0 ? 1 : 0);
  const out: number[] = [];
  for (let dv = 0; dv <= 1; dv++) {
    for (let du = 0; du <= 1; du++) {
      const q: Vec3 = [p[0], p[1], p[2]];
      q[u] = p[u]! + du;
      q[v] = p[v]! + dv;
      out.push(nodeIndexOf(g, q[0], q[1], q[2]));
    }
  }
  return out;
}

export interface SupportModel {
  /** per node: bit 0 = x fixed, bit 1 = y, bit 2 = z */
  fixedNode: Uint8Array;
  /** per element: initially solid with at least one fixed node */
  supported: Uint8Array;
}

export function supportModel(stage: Stage): SupportModel {
  const g = makeGrid(stage.grid);
  const solid = decodeBitmask(stage.solid, g.n);
  const fixedNode = new Uint8Array(g.nodes);
  for (const s of stage.supports) {
    const bits = (s.fix.includes('x') ? 1 : 0) | (s.fix.includes('y') ? 2 : 0) | (s.fix.includes('z') ? 4 : 0);
    for (const cell of supportCells(stage, s, solid)) {
      for (const node of faceNodes(g, cell, s.face)) fixedNode[node]! |= bits;
    }
  }
  const supported = new Uint8Array(g.n);
  for (let z = 0; z < g.nz; z++) {
    for (let y = 0; y < g.ny; y++) {
      for (let x = 0; x < g.nx; x++) {
        const e = cellIndex(g, x, y, z);
        if (!solid[e]) continue;
        let any = 0;
        for (let k = 0; k <= 1 && !any; k++)
          for (let j = 0; j <= 1 && !any; j++)
            for (let i = 0; i <= 1 && !any; i++) any = fixedNode[nodeIndexOf(g, x + i, y + j, z + k)]!;
        supported[e] = any ? 1 : 0;
      }
    }
  }
  return { fixedNode, supported };
}
