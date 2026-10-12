// Deformation view maths (design doc 応力の可視化「変形表示」, 演出「載荷テスト」). Pure: no DOM or
// Three.js, so everything here is unit-tested in node.
//
// The voxel surface mesh is built from grid nodes (mesher.ts records `vertexNode` per vertex),
// so the trilinear interpolation of the nodal displacement field at a vertex degenerates to a
// direct lookup of that node's value. Displacements arrive in metres; the meshes live in grid
// units (1 voxel = 1), so lookups divide by the voxel size.

import type { CaseResult } from '@stress-carve/protocol';
import { nodeIndexOf, type Grid } from '../../game/grid.ts';

/** Target: the largest displayed displacement is this fraction of the smallest grid extent. */
export const TARGET_FRACTION = 0.1;

/**
 * Per-vertex displacement (xyz per vertex, grid units) by direct nodal lookup.
 * `nodal` is the solver field (3 per node, metres), `h` the voxel size in metres.
 */
export function vertexDisplacements(
  vertexNode: Uint32Array,
  nodal: Float32Array,
  h: number,
  out: Float32Array = new Float32Array(vertexNode.length * 3),
): Float32Array {
  const inv = 1 / h;
  for (let v = 0; v < vertexNode.length; v++) {
    const n = vertexNode[v]! * 3;
    out[v * 3] = (nodal[n] ?? 0) * inv;
    out[v * 3 + 1] = (nodal[n + 1] ?? 0) * inv;
    out[v * 3 + 2] = (nodal[n + 2] ?? 0) * inv;
  }
  return out;
}

/** Largest |u| (metres) over the 8 corner nodes of every flagged element. */
export function maxActiveDisplacement(g: Grid, flags: Uint8Array, nodal: Float32Array): number {
  const sy = g.nx + 1;
  const sz = (g.nx + 1) * (g.ny + 1);
  let max2 = 0;
  for (let e = 0; e < g.n; e++) {
    if (!flags[e]) continue;
    const x = e % g.nx;
    const y = Math.floor(e / g.nx) % g.ny;
    const z = Math.floor(e / (g.nx * g.ny));
    const base = nodeIndexOf(g, x, y, z);
    for (let c = 0; c < 8; c++) {
      const n = base + (c & 1) + (c & 2 ? sy : 0) + (c & 4 ? sz : 0);
      const ux = nodal[3 * n] ?? 0;
      const uy = nodal[3 * n + 1] ?? 0;
      const uz = nodal[3 * n + 2] ?? 0;
      const d2 = ux * ux + uy * uy + uz * uz;
      if (d2 > max2) max2 = d2;
    }
  }
  return Math.sqrt(max2);
}

/** Largest "nice" number (1, 2, 2.5, 5 × 10^k) not above `x`; 0 for x ≤ 0 or non-finite. */
export function niceFloor(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 0;
  const p = 10 ** Math.floor(Math.log10(x));
  // guard against log10 rounding just below a power of ten
  const m = x / p;
  for (const step of [10, 5, 2.5, 2, 1]) {
    if (m >= step * (1 - 1e-12)) return step * p;
  }
  return p / 2;
}

/**
 * Exaggeration factor so that `maxDisplacement` (m) is shown as ~`fraction` of the smallest
 * grid extent: the raw factor rounded down to a nice number (the shown maximum lands in
 * (fraction/2, fraction]). 0 when there is nothing to show.
 */
export function autoScale(maxDisplacement: number, g: Grid, h: number, fraction = TARGET_FRACTION): number {
  if (!(maxDisplacement > 0) || !Number.isFinite(maxDisplacement)) return 0;
  const minExtent = Math.min(g.nx, g.ny, g.nz) * h;
  return niceFloor((fraction * minExtent) / maxDisplacement);
}

/** HUD label for a factor, e.g. ×250, ×1,200; "—" when there is no deformation. */
export function formatScale(scale: number): string {
  if (!(scale > 0)) return '×—';
  if (scale >= 1) return `×${Math.round(scale).toLocaleString('en-US')}`;
  return `×${Number(scale.toPrecision(2))}`;
}

/**
 * Normal change per vertex at deformation scale `scale`: for every quad (4 consecutive
 * vertices) the deformed normal is the normalised cross product of its diagonals; the
 * output is `deformed − rest`, the same for the quad's 4 vertices. The shader blends
 * `normalize(rest + t·delta)` while the scale ramps 0 → `scale`.
 */
export function normalDeltas(
  positions: Float32Array,
  normals: Float32Array,
  disp: Float32Array,
  scale: number,
  out: Float32Array = new Float32Array(positions.length),
): Float32Array {
  const quads = positions.length / 12;
  const p = (v: number, c: number) => positions[v * 3 + c]! + scale * disp[v * 3 + c]!;
  for (let q = 0; q < quads; q++) {
    const v0 = q * 4;
    const ax = p(v0 + 2, 0) - p(v0, 0);
    const ay = p(v0 + 2, 1) - p(v0, 1);
    const az = p(v0 + 2, 2) - p(v0, 2);
    const bx = p(v0 + 3, 0) - p(v0 + 1, 0);
    const by = p(v0 + 3, 1) - p(v0 + 1, 1);
    const bz = p(v0 + 3, 2) - p(v0 + 1, 2);
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz);
    const r0 = normals[v0 * 3]!;
    const r1 = normals[v0 * 3 + 1]!;
    const r2 = normals[v0 * 3 + 2]!;
    if (len > 1e-12) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = r0;
      ny = r1;
      nz = r2;
    }
    for (let c = 0; c < 4; c++) {
      const o = (v0 + c) * 3;
      out[o] = nx - r0;
      out[o + 1] = ny - r1;
      out[o + 2] = nz - r2;
    }
  }
  return out;
}

/** Mean displacement (m) of the 8 corner nodes of `element`. */
export function cellDisplacement(g: Grid, element: number, nodal: Float32Array): [number, number, number] {
  const x = element % g.nx;
  const y = Math.floor(element / g.nx) % g.ny;
  const z = Math.floor(element / (g.nx * g.ny));
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 8; c++) {
    const n = nodeIndexOf(g, x + (c & 1), y + ((c >> 1) & 1), z + ((c >> 2) & 1));
    out[0] += (nodal[3 * n] ?? 0) / 8;
    out[1] += (nodal[3 * n + 1] ?? 0) / 8;
    out[2] += (nodal[3 * n + 2] ?? 0) / 8;
  }
  return out;
}

/** Utilisation treated as failing: above 1, or NaN (never hide a broken result). */
export function overstressed(u: number): boolean {
  return !(u <= 1);
}

/**
 * Elements that break off in the load test: flagged, not protected (protected cells are
 * not judged), utilisation > 1 — highest utilisation first (NaN first), ties by index.
 */
export function breakOrder(utilization: Float32Array, flags: Uint8Array, keep: Uint8Array): number[] {
  const out: number[] = [];
  for (let e = 0; e < flags.length; e++) {
    if (flags[e] && !keep[e] && overstressed(utilization[e] ?? 0)) out.push(e);
  }
  const key = (e: number) => {
    const u = utilization[e]!;
    return Number.isNaN(u) ? Infinity : u;
  };
  return out.sort((a, b) => key(b) - key(a) || a - b);
}

/**
 * Crack intensity per element (0..1): 0 at or below the allowable stress, growing from 0.35
 * just above it to 1 at 150 % utilisation. Protected and empty cells never crack.
 */
export function crackField(utilization: Float32Array, flags: Uint8Array, keep: Uint8Array): Float32Array {
  const out = new Float32Array(flags.length);
  for (let e = 0; e < flags.length; e++) {
    if (!flags[e] || keep[e]) continue;
    const u = utilization[e] ?? 0;
    if (!overstressed(u)) continue;
    out[e] = Number.isNaN(u) ? 1 : Math.min(1, 0.35 + (0.65 * (u - 1)) / 0.5);
  }
  return out;
}

/**
 * The load case the test animates: the one with the highest judged utilisation (the
 * critical one), then the largest load-point displacement; first case on ties.
 */
export function criticalCase(cases: readonly CaseResult[]): number {
  let best = 0;
  for (let i = 1; i < cases.length; i++) {
    const a = cases[i]!;
    const b = cases[best]!;
    if (
      a.maxUtilization > b.maxUtilization ||
      (a.maxUtilization === b.maxUtilization && a.loadDisplacement > b.loadDisplacement)
    ) {
      best = i;
    }
  }
  return best;
}
