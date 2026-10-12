// Hint cells for the tutorial (design doc リスク: 低応力域を光らせるヒント): carvable
// voxels on the surface whose utilisation is low. Pure.

import type { Grid } from '../../game/grid.ts';

/** Utilisation below which a cell glows: 15 %, or 35 % of the current maximum if lower. */
export function hintThreshold(maxUtilization: number): number {
  if (!(maxUtilization > 0)) return 0;
  return Math.min(0.15, 0.35 * maxUtilization);
}

export interface LowStressInput {
  grid: Grid;
  /** 1 = material present */
  solid: Uint8Array;
  /** 1 = protected (keep ∪ supported ∪ load cells) */
  keep: Uint8Array;
  /** per-element utilisation (envelope over load cases) */
  utilization: ArrayLike<number>;
  threshold: number;
}

/**
 * Solid, unprotected cells with at least one exposed face (grid boundary or empty
 * neighbour — only those can be carved) and utilisation below `threshold`.
 */
export function lowStressCells(input: LowStressInput): number[] {
  const { grid: g, solid, keep, utilization, threshold } = input;
  const out: number[] = [];
  const sx = 1;
  const sy = g.nx;
  const sz = g.nx * g.ny;
  for (let z = 0; z < g.nz; z++) {
    for (let y = 0; y < g.ny; y++) {
      for (let x = 0; x < g.nx; x++) {
        const e = x + g.nx * (y + g.ny * z);
        if (!solid[e] || keep[e]) continue;
        const u = utilization[e];
        if (u === undefined || !(u < threshold)) continue;
        const exposed =
          x === 0 ||
          y === 0 ||
          z === 0 ||
          x === g.nx - 1 ||
          y === g.ny - 1 ||
          z === g.nz - 1 ||
          !solid[e - sx] ||
          !solid[e + sx] ||
          !solid[e - sy] ||
          !solid[e + sy] ||
          !solid[e - sz] ||
          !solid[e + sz];
        if (exposed) out.push(e);
      }
    }
  }
  return out;
}
