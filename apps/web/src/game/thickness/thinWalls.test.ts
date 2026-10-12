import { describe, expect, it } from 'vitest';
import { buildDemoStage } from '../demoStage.ts';
import { CarveState } from '../carveState.ts';
import { cellIndex, makeGrid, type Grid } from '../grid.ts';
import { thinCells, ThinWallMap } from './thinWalls.ts';

/** Independent reference: try every window that could contain each cell. */
function bruteForce(g: Grid, solid: Uint8Array, keep: Uint8Array): Uint8Array {
  const w = [g.nx > 1 ? 2 : 1, g.ny > 1 ? 2 : 1, g.nz > 1 ? 2 : 1] as const;
  const dims = [g.nx, g.ny, g.nz] as const;
  const out = new Uint8Array(g.n);
  for (let z = 0; z < g.nz; z++) {
    for (let y = 0; y < g.ny; y++) {
      for (let x = 0; x < g.nx; x++) {
        const e = cellIndex(g, x, y, z);
        if (!solid[e] || keep[e]) continue;
        let covered = false;
        for (let dz = 0; dz < w[2] && !covered; dz++) {
          for (let dy = 0; dy < w[1] && !covered; dy++) {
            for (let dx = 0; dx < w[0] && !covered; dx++) {
              const min = [x - dx, y - dy, z - dz];
              if (min.some((m, a) => m < 0 || m + w[a]! > dims[a]!)) continue;
              let all = true;
              for (let k = 0; k < w[2]; k++)
                for (let j = 0; j < w[1]; j++)
                  for (let i = 0; i < w[0]; i++)
                    if (!solid[cellIndex(g, min[0]! + i, min[1]! + j, min[2]! + k)]) all = false;
              covered = all;
            }
          }
        }
        out[e] = covered ? 0 : 1;
      }
    }
  }
  return out;
}

/** Grid with solid cells where `fill(x, y, z)` is true. */
function pattern(dims: [number, number, number], fill: (x: number, y: number, z: number) => boolean) {
  const g = makeGrid(dims);
  const solid = new Uint8Array(g.n);
  for (let z = 0; z < g.nz; z++)
    for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) solid[cellIndex(g, x, y, z)] = fill(x, y, z) ? 1 : 0;
  return { g, solid, keep: new Uint8Array(g.n) };
}

const sum = (a: Uint8Array) => a.reduce((s, v) => s + v, 0);

/** Thin flags, checked against the brute-force reference. */
function thinOf(g: Grid, solid: Uint8Array, keep: Uint8Array): Uint8Array {
  const thin = thinCells(g, solid, keep);
  expect(Array.from(thin)).toEqual(Array.from(bruteForce(g, solid, keep)));
  return thin;
}

describe('thin-wall detection (2-voxel minimum thickness)', () => {
  it('1-thick plate: every cell is thin, also on the grid boundary', () => {
    const mid = pattern([8, 8, 8], (_x, y) => y === 3);
    expect(sum(thinOf(mid.g, mid.solid, mid.keep))).toBe(64);
    const floor = pattern([8, 8, 8], (_x, y) => y === 0);
    expect(sum(thinOf(floor.g, floor.solid, floor.keep))).toBe(64);
    const wall = pattern([8, 8, 8], (x) => x === 7);
    expect(sum(thinOf(wall.g, wall.solid, wall.keep))).toBe(64);
  });

  it('2-thick plate: no cell is thin, edges and corners included', () => {
    const mid = pattern([8, 8, 8], (_x, y) => y === 3 || y === 4);
    expect(sum(thinOf(mid.g, mid.solid, mid.keep))).toBe(0);
    const floor = pattern([8, 8, 8], (_x, y) => y <= 1);
    expect(sum(thinOf(floor.g, floor.solid, floor.keep))).toBe(0);
    const inset = pattern([8, 8, 8], (x, y, z) => (y === 3 || y === 4) && x >= 2 && x <= 5 && z >= 1 && z <= 6);
    expect(sum(thinOf(inset.g, inset.solid, inset.keep))).toBe(0);
  });

  it('2×2 beam is fine, 1×2 and 1×1 struts are thin', () => {
    const beam = pattern([10, 6, 6], (_x, y, z) => (y === 2 || y === 3) && (z === 2 || z === 3));
    expect(sum(thinOf(beam.g, beam.solid, beam.keep))).toBe(0);
    const flat = pattern([10, 6, 6], (_x, y, z) => (y === 2 || y === 3) && z === 2);
    expect(sum(thinOf(flat.g, flat.solid, flat.keep))).toBe(20);
    const rod = pattern([10, 6, 6], (_x, y, z) => y === 2 && z === 2);
    expect(sum(thinOf(rod.g, rod.solid, rod.keep))).toBe(10);
  });

  it('diagonal staircase strut: 1 and 2 cells wide are thin, 3 wide is not', () => {
    // strut along (1,1,0), extruded 4 deep in z; row y holds x in [y, y + width)
    const strut = (width: number) => pattern([16, 10, 4], (x, y) => x >= y && x < y + width);
    for (const width of [1, 2]) {
      const { g, solid, keep } = strut(width);
      expect(sum(thinOf(g, solid, keep))).toBe(sum(solid));
    }
    for (const width of [3, 4]) {
      // only the two acute end tips (where the strut is cut by the grid boundary) are slivers
      const { g, solid, keep } = strut(width);
      const thin = thinOf(g, solid, keep);
      const tips: number[] = [];
      for (let z = 0; z < 4; z++) tips.push(cellIndex(g, 0, 0, z), cellIndex(g, 9 + width - 1, 9, z));
      const flagged = Array.from(thin.keys()).filter((e) => thin[e]);
      expect(flagged.sort((a, b) => a - b)).toEqual(tips.sort((a, b) => a - b));
    }
  });

  it('L-corner: the corner of a 1-thick L is thin, a 2-thick L is clean', () => {
    // legs along +x (y = 0..t-1) and +y (x = 0..t-1), 4 deep
    const ell = (t: number) => pattern([10, 10, 4], (x, y) => x < t || y < t);
    const one = ell(1);
    const thin1 = thinOf(one.g, one.solid, one.keep);
    expect(sum(thin1)).toBe(sum(one.solid));
    expect(thin1[cellIndex(one.g, 0, 0, 1)]).toBe(1); // the corner itself
    const two = ell(2);
    expect(sum(thinOf(two.g, two.solid, two.keep))).toBe(0);
  });

  it('a one-voxel spike on a thick block is thin, the block is not', () => {
    const { g, solid, keep } = pattern([6, 6, 6], (_x, y) => y <= 2);
    const spike = cellIndex(g, 3, 3, 3);
    solid[spike] = 1;
    const thin = thinOf(g, solid, keep);
    expect(sum(thin)).toBe(1);
    expect(thin[spike]).toBe(1);
  });

  it('protected cells count as material but are never flagged', () => {
    // 1-thick plate on a 1-thick keep layer = 2 thick together
    const stacked = pattern([8, 8, 8], (_x, y) => y === 3 || y === 4);
    for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) stacked.keep[cellIndex(stacked.g, x, 4, z)] = 1;
    expect(sum(thinOf(stacked.g, stacked.solid, stacked.keep))).toBe(0);
    // a 1-thick plate half of which is protected: only the free half warns
    const half = pattern([8, 8, 8], (_x, y) => y === 3);
    for (let z = 0; z < 8; z++) for (let x = 0; x < 4; x++) half.keep[cellIndex(half.g, x, 3, z)] = 1;
    expect(sum(thinOf(half.g, half.solid, half.keep))).toBe(32);
  });

  it('degenerate axis (extent 1) uses a 1-cell window along it', () => {
    const slab = pattern([8, 8, 1], (_x, y) => y === 2 || y === 3);
    expect(sum(thinOf(slab.g, slab.solid, slab.keep))).toBe(0);
    const strip = pattern([8, 8, 1], (_x, y) => y === 2);
    expect(sum(thinOf(strip.g, strip.solid, strip.keep))).toBe(8);
    const single = pattern([1, 1, 1], () => true);
    expect(sum(thinOf(single.g, single.solid, single.keep))).toBe(0);
  });

  it('incremental updates match a full recompute and report exactly the flipped cells', () => {
    const g = makeGrid([13, 7, 6]);
    const solid = new Uint8Array(g.n).fill(1);
    const keep = new Uint8Array(g.n);
    for (let e = 0; e < g.n; e += 17) keep[e] = 1;
    const map = new ThinWallMap(g, solid, keep);
    const counts: number[] = [];
    map.subscribe((c) => counts.push(c));
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let step = 0; step < 200; step++) {
      const before = map.thin.slice();
      const changed: number[] = [];
      const k = 1 + Math.floor(rand() * 6);
      for (let i = 0; i < k; i++) {
        const e = Math.floor(rand() * g.n);
        if (keep[e]) continue;
        solid[e] = step % 5 === 4 ? 1 : solid[e] ? 0 : 1;
        changed.push(e);
      }
      const flipped = map.update(changed).sort((a, b) => a - b);
      const expected = bruteForce(g, solid, keep);
      expect(Array.from(map.thin)).toEqual(Array.from(expected));
      expect(map.count).toBe(sum(expected));
      const diff: number[] = [];
      for (let e = 0; e < g.n; e++) if (before[e] !== map.thin[e]) diff.push(e);
      expect(flipped).toEqual(diff);
    }
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.at(-1)).toBe(map.count);
    expect(map.update([])).toEqual([]);
  });

  it('works on CarveState: the demo stage starts clean, carving a groove to 1 voxel warns', () => {
    const state = new CarveState(buildDemoStage());
    const map = new ThinWallMap(state.grid, state.solid, state.keep);
    expect(map.count).toBe(0);
    const g = state.grid;
    // carve everything above y = 0 in one x column (except protected cells): leaves a 1-thick web
    const x = Math.floor(g.nx / 2);
    const cells: number[] = [];
    for (let z = 0; z < g.nz; z++) for (let y = 1; y < g.ny; y++) cells.push(cellIndex(g, x, y, z));
    const removed = state.carve(cells);
    expect(removed.length).toBeGreaterThan(0);
    map.update(removed);
    expect(Array.from(map.thin)).toEqual(Array.from(bruteForce(g, state.solid, state.keep)));
    expect(map.count).toBeGreaterThan(0);
    const undo = state.undo();
    map.update(undo?.restored ?? []);
    expect(map.count).toBe(0);
  });

  it('full recompute of a 40×12×12 grid stays well under 2 ms', () => {
    const g = makeGrid([40, 12, 12]);
    const solid = new Uint8Array(g.n).fill(1);
    // a perforated, partly thin structure so neither early exit dominates
    for (let e = 0; e < g.n; e++) if ((e * 2654435761) % 7 === 0) solid[e] = 0;
    const map = new ThinWallMap(g, solid, new Uint8Array(g.n));
    const times: number[] = [];
    for (let r = 0; r < 30; r++) {
      const t0 = performance.now();
      map.recomputeAll();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1]!;
    // a 5×5 brush stroke step: incremental update of 25 cells
    const brush: number[] = [];
    for (let z = 3; z < 8; z++) for (let x = 10; x < 15; x++) brush.push(cellIndex(g, x, 11, z));
    const t0 = performance.now();
    for (let r = 0; r < 100; r++) map.update(brush);
    const perUpdate = (performance.now() - t0) / 100;
    console.log(`thin walls 40×12×12: full ${median.toFixed(3)} ms (median), 5×5 update ${perUpdate.toFixed(4)} ms`);
    expect(median).toBeLessThan(2);
  });
});
