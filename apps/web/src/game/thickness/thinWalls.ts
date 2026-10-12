// Minimum-thickness warning (design doc リスク: ボクセルの粗さ → 最小肉厚2ボクセル、下回ると警告).
// A warning only — never part of the judgement. Pure (no DOM / Three), incremental.
//
// Definition ("thin"). Let the window be a 2×2×2 block of cells (1 along an axis whose grid
// extent is 1, so degenerate grids still work). A window is *full* when it lies inside the
// grid and every cell in it is solid. A cell is *covered* when some full window contains it.
// A cell is thin iff it is solid, not protected (keep ∪ support ∪ load) and not covered.
//
// This is the morphological opening of the solid set by the 2-voxel cube: the cells that
// remain after opening are exactly the parts at least 2 voxels thick in every direction.
//   - 1-thick plates, 1×1 struts, lone voxels and spikes → thin.
//   - 2-thick plates and 2×2 beams → not thin, including their edges and corners.
//   - the corner of a 1-thick L → thin (an axis-neighbour test would miss it).
//   - diagonal staircase struts: 1 or 2 cells wide (perpendicular thickness 0.7 / 1.4 voxels,
//     joints of one shared face) → thin; 3 wide (2.1 voxels) → not thin.
// Grid boundary = outside the part (windows never leave the grid), obstacles are empty.
// Protected cells count as material for their neighbours' windows but are never flagged
// themselves: the player cannot change them and they are excluded from the judgement.

import type { Grid } from '../grid.ts';

/** Change listener: called with the new thin-cell count after it changed. */
export type ThinCountListener = (count: number) => void;

export class ThinWallMap {
  /** 1 = thin (warning tint); live, updated in place by `update` / `recomputeAll` */
  readonly thin: Uint8Array;
  /** window size per axis (2, or 1 for a degenerate axis) */
  readonly window: readonly [number, number, number];

  /** 1 = the window whose min corner is this cell is full */
  private readonly full: Uint8Array;
  private thinCount = 0;
  private readonly listeners = new Set<ThinCountListener>();

  constructor(
    private readonly grid: Grid,
    /** live solid flags (mutated by the game state) */
    private readonly solid: Uint8Array,
    /** protected cells (never flagged) */
    private readonly keep: Uint8Array,
  ) {
    this.thin = new Uint8Array(grid.n);
    this.full = new Uint8Array(grid.n);
    this.window = [grid.nx > 1 ? 2 : 1, grid.ny > 1 ? 2 : 1, grid.nz > 1 ? 2 : 1];
    this.recomputeAll();
  }

  /** Number of thin cells. */
  get count(): number {
    return this.thinCount;
  }

  subscribe(listener: ThinCountListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Recompute every cell (stage load, or when the solid array was replaced wholesale). */
  recomputeAll(): number[] {
    const g = this.grid;
    return this.recomputeBox(0, g.nx - 1, 0, g.ny - 1, 0, g.nz - 1);
  }

  /**
   * The given cells flipped solid/empty: recompute the cells within one voxel of them.
   * Returns the cells whose thin flag flipped (their chunks need a repaint).
   */
  update(changed: Iterable<number>): number[] {
    const g = this.grid;
    let x0 = g.nx;
    let y0 = g.ny;
    let z0 = g.nz;
    let x1 = -1;
    let y1 = -1;
    let z1 = -1;
    for (const e of changed) {
      if (!(e >= 0 && e < g.n)) continue;
      const x = e % g.nx;
      const yz = (e - x) / g.nx;
      const y = yz % g.ny;
      const z = (yz - y) / g.ny;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    if (x1 < 0) return [];
    return this.recomputeBox(x0, x1, y0, y1, z0, z1);
  }

  /**
   * Cells in [x0..x1]×[y0..y1]×[z0..z1] changed solidity: refresh the windows touching the box
   * and the thin flags of every cell in those windows.
   */
  private recomputeBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[] {
    const g = this.grid;
    const [wx, wy, wz] = this.window;
    const sy = g.nx;
    const sz = g.nx * g.ny;
    const solid = this.solid;
    const full = this.full;

    // windows containing a changed cell: min corner in [c0 - (w-1), c1], inside the grid
    const wx0 = Math.max(0, x0 - wx + 1);
    const wy0 = Math.max(0, y0 - wy + 1);
    const wz0 = Math.max(0, z0 - wz + 1);
    const wx1 = Math.min(x1, g.nx - wx);
    const wy1 = Math.min(y1, g.ny - wy);
    const wz1 = Math.min(z1, g.nz - wz);
    for (let z = wz0; z <= wz1; z++) {
      for (let y = wy0; y <= wy1; y++) {
        for (let x = wx0; x <= wx1; x++) {
          const e = x + sy * y + sz * z;
          full[e] = windowFull(solid, e, wx, wy, wz, sy, sz);
        }
      }
    }

    // cells of those windows: [c0 - (w-1), c1 + (w-1)]
    const cx0 = Math.max(0, x0 - wx + 1);
    const cy0 = Math.max(0, y0 - wy + 1);
    const cz0 = Math.max(0, z0 - wz + 1);
    const cx1 = Math.min(g.nx - 1, x1 + wx - 1);
    const cy1 = Math.min(g.ny - 1, y1 + wy - 1);
    const cz1 = Math.min(g.nz - 1, z1 + wz - 1);
    const flipped: number[] = [];
    const thin = this.thin;
    const keep = this.keep;
    let count = this.thinCount;
    for (let z = cz0; z <= cz1; z++) {
      for (let y = cy0; y <= cy1; y++) {
        for (let x = cx0; x <= cx1; x++) {
          const e = x + sy * y + sz * z;
          const t = solid[e] && !keep[e] && !this.covered(x, y, z) ? 1 : 0;
          if (t !== thin[e]) {
            thin[e] = t;
            count += t ? 1 : -1;
            flipped.push(e);
          }
        }
      }
    }
    if (count !== this.thinCount) {
      this.thinCount = count;
      for (const l of this.listeners) l(count);
    }
    return flipped;
  }

  /** Some full window contains cell (x, y, z). */
  private covered(x: number, y: number, z: number): boolean {
    const g = this.grid;
    const [wx, wy, wz] = this.window;
    const sy = g.nx;
    const sz = g.nx * g.ny;
    const ax0 = Math.max(0, x - wx + 1);
    const ay0 = Math.max(0, y - wy + 1);
    const az0 = Math.max(0, z - wz + 1);
    const ax1 = Math.min(x, g.nx - wx);
    const ay1 = Math.min(y, g.ny - wy);
    const az1 = Math.min(z, g.nz - wz);
    for (let k = az0; k <= az1; k++) {
      for (let j = ay0; j <= ay1; j++) {
        for (let i = ax0; i <= ax1; i++) {
          if (this.full[i + sy * j + sz * k]) return true;
        }
      }
    }
    return false;
  }
}

function windowFull(
  solid: Uint8Array,
  e: number,
  wx: number,
  wy: number,
  wz: number,
  sy: number,
  sz: number,
): number {
  for (let k = 0; k < wz; k++) {
    for (let j = 0; j < wy; j++) {
      for (let i = 0; i < wx; i++) {
        if (!solid[e + i + sy * j + sz * k]) return 0;
      }
    }
  }
  return 1;
}

/** One-shot thin flags (tests, tools). */
export function thinCells(grid: Grid, solid: Uint8Array, keep: Uint8Array): Uint8Array {
  return new ThinWallMap(grid, solid, keep).thin;
}
