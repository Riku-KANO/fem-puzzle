import { describe, expect, it } from 'vitest';
import { cellIndex, makeGrid } from '../src/game/grid.ts';
import { raycastGrid } from '../src/render/picking.ts';

const g = makeGrid([8, 4, 6]);
const full = new Uint8Array(g.n).fill(1);
const solidAt = (flags: Uint8Array) => (e: number) => flags[e] === 1;

describe('voxel picking (grid DDA)', () => {
  it('hits the first solid cell and reports the entry face for each axis direction', () => {
    const cases = [
      { o: [-5, 1.5, 2.5], d: [1, 0, 0], cell: [0, 1, 2], face: 'x-' },
      { o: [20, 1.5, 2.5], d: [-1, 0, 0], cell: [7, 1, 2], face: 'x+' },
      { o: [3.5, -3, 2.5], d: [0, 1, 0], cell: [3, 0, 2], face: 'y-' },
      { o: [3.5, 9, 2.5], d: [0, -1, 0], cell: [3, 3, 2], face: 'y+' },
      { o: [3.5, 1.5, -1], d: [0, 0, 1], cell: [3, 1, 0], face: 'z-' },
      { o: [3.5, 1.5, 10], d: [0, 0, -1], cell: [3, 1, 5], face: 'z+' },
    ] as const;
    for (const c of cases) {
      const hit = raycastGrid(g, [...c.o], [...c.d], solidAt(full));
      expect(hit?.cell).toEqual(c.cell);
      expect(hit?.face).toBe(c.face);
      expect(hit?.element).toBe(cellIndex(g, c.cell[0], c.cell[1], c.cell[2]));
    }
  });

  it('passes through empty cells and returns the entry point', () => {
    const flags = new Uint8Array(g.n).fill(1);
    flags[cellIndex(g, 3, 3, 2)] = 0;
    flags[cellIndex(g, 3, 2, 2)] = 0;
    const hit = raycastGrid(g, [3.5, 10, 2.5], [0, -1, 0], solidAt(flags))!;
    expect(hit.cell).toEqual([3, 1, 2]);
    expect(hit.face).toBe('y+');
    expect(hit.point[1]).toBeCloseTo(2, 9);
    expect(hit.t).toBeCloseTo(8, 9);
  });

  it('diagonal rays enter through the face they actually cross', () => {
    // from above-left, steep: first crosses the top plane y = 4 inside the grid
    const hit = raycastGrid(g, [2.2, 6, 2.5], [0.3, -1, 0], solidAt(full))!;
    expect(hit.face).toBe('y+');
    expect(hit.cell).toEqual([2, 3, 2]);
    // shallow ray grazing the x- side
    const side = raycastGrid(g, [-2, 3.8, 2.5], [1, -0.05, 0], solidAt(full))!;
    expect(side.face).toBe('x-');
    expect(side.cell).toEqual([0, 3, 2]);
  });

  it('misses: ray outside the grid, pointing away, or nothing solid on the path', () => {
    expect(raycastGrid(g, [-1, 10, 0.5], [1, 0, 0], solidAt(full))).toBeNull();
    expect(raycastGrid(g, [-1, 1.5, 1.5], [-1, 0, 0], solidAt(full))).toBeNull();
    expect(raycastGrid(g, [-1, 1.5, 1.5], [1, 0, 0], () => false)).toBeNull();
  });

  it('the hit predicate filters cells (e.g. X-ray / section views skip them)', () => {
    const skip = cellIndex(g, 0, 1, 2);
    const hit = raycastGrid(g, [-5, 1.5, 2.5], [1, 0, 0], (e) => e !== skip)!;
    expect(hit.cell).toEqual([1, 1, 2]);
    expect(hit.face).toBe('x-');
  });
});
