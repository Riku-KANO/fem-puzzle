// Support semantics (docs/specs/stage-format.md "Support"): fixed nodes per support, and the
// supported cells connectivity is measured from (protocol `supportCells`/`supportedCells`).

import {
  decodeBitmask,
  elementCount,
  supportCells,
  supportedCells,
  type Stage,
  type Support,
  type Vec3,
} from '@stress-carve/protocol';
import { cellCoords, faceDir, makeGrid, nodeIndexOf, type Grid } from './grid.ts';

/** Supported cells of one support as coordinates (jig placement). */
export function supportCellCoords(stage: Stage, s: Support, initialSolid?: Uint8Array): Vec3[] {
  const g = makeGrid(stage.grid);
  const solid = initialSolid ?? decodeBitmask(stage.solid, elementCount(stage.grid));
  return supportCells(stage, s, solid).map((e) => cellCoords(g, e));
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
  /** per element: supported cell (connectivity seeds; always protected) */
  supported: Uint8Array;
}

export function supportModel(stage: Stage): SupportModel {
  const g = makeGrid(stage.grid);
  const solid = decodeBitmask(stage.solid, g.n);
  const fixedNode = new Uint8Array(g.nodes);
  for (const s of stage.supports) {
    const bits = (s.fix.includes('x') ? 1 : 0) | (s.fix.includes('y') ? 2 : 0) | (s.fix.includes('z') ? 4 : 0);
    for (const cell of supportCellCoords(stage, s, solid)) {
      for (const node of faceNodes(g, cell, s.face)) fixedNode[node]! |= bits;
    }
  }
  return { fixedNode, supported: supportedCells(stage) };
}
