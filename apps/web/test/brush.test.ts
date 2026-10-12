import type { Face, Vec3 } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { brushFootprint, brushSelect } from '../src/game/brush.ts';
import { cellCoords, cellIndex, makeGrid } from '../src/game/grid.ts';

const g = makeGrid([9, 9, 9]);
const full = () => new Uint8Array(g.n).fill(1);
const none = () => new Uint8Array(g.n);
const coordsOf = (cells: number[]) => cells.map((e) => cellCoords(g, e));

/** surface cell in the middle of each face of the 9³ cube */
const faceCentre: Record<Face, Vec3> = {
  'x-': [0, 4, 4],
  'x+': [8, 4, 4],
  'y-': [4, 0, 4],
  'y+': [4, 8, 4],
  'z-': [4, 4, 0],
  'z+': [4, 4, 8],
};

describe('brush selection', () => {
  for (const face of Object.keys(faceCentre) as Face[]) {
    it(`face ${face}: 1, 3×3 and 5×5 lie in the plane of the hit face`, () => {
      const cell = faceCentre[face];
      const axis = 'xyz'.indexOf(face[0]!);
      for (const [size, count] of [
        [1, 1],
        [3, 9],
        [5, 25],
      ] as const) {
        const sel = brushSelect(g, cell, face, size, { solid: full(), keep: none() });
        expect(sel.carve).toHaveLength(count);
        expect(sel.protected).toHaveLength(0);
        for (const c of coordsOf(sel.carve)) {
          expect(c[axis]).toBe(cell[axis]); // same layer
          for (let k = 0; k < 3; k++) {
            if (k !== axis) expect(Math.abs(c[k]! - cell[k]!)).toBeLessThanOrEqual((size - 1) / 2);
          }
        }
      }
    });
  }

  it('is clipped at the grid border', () => {
    expect(brushFootprint(g, [0, 0, 8], 'z+', 3)).toHaveLength(4);
    expect(brushFootprint(g, [0, 4, 8], 'z+', 5)).toHaveLength(15);
  });

  it('separates protected cells and skips non-solid ones', () => {
    const solid = full();
    const keep = none();
    keep[cellIndex(g, 4, 8, 4)] = 1;
    solid[cellIndex(g, 5, 8, 4)] = 0;
    const sel = brushSelect(g, [4, 8, 4], 'y+', 3, { solid, keep });
    expect(sel.protected).toEqual([cellIndex(g, 4, 8, 4)]);
    expect(sel.carve).toHaveLength(7);
    expect(sel.carve).not.toContain(cellIndex(g, 5, 8, 4));
  });

  it('only carves surface cells: buried cells and cells under obstacles are skipped', () => {
    const solid = full();
    // pit in the top layer at (4, 8, 4): the hit is on the pit floor (4, 7, 4), face y+
    solid[cellIndex(g, 4, 8, 4)] = 0;
    const sel = brushSelect(g, [4, 7, 4], 'y+', 3, { solid, keep: none() });
    expect(sel.carve).toEqual([cellIndex(g, 4, 7, 4)]); // neighbours are still covered

    const block = none();
    const s2 = none();
    s2[cellIndex(g, 4, 0, 4)] = 1;
    s2[cellIndex(g, 5, 0, 4)] = 1;
    block[cellIndex(g, 5, 1, 4)] = 1;
    const sel2 = brushSelect(g, [4, 0, 4], 'y+', 3, { solid: s2, keep: none(), block });
    expect(sel2.carve).toEqual([cellIndex(g, 4, 0, 4)]);
  });

  it('does not drill through material exposed by the same stroke', () => {
    const solid = full();
    const top = cellIndex(g, 4, 8, 4);
    solid[top] = 0;
    const strokeRemoved = new Set([top]);
    const sel = brushSelect(g, [4, 7, 4], 'y+', 1, { solid, keep: none(), strokeRemoved });
    expect(sel.carve).toEqual([]);
  });
});
