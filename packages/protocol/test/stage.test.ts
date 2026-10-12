import { describe, expect, it } from 'vitest';
import {
  decodeBitmask,
  effectiveKeep,
  elementCoords,
  elementIndex,
  encodeBitmask,
  supportedCells,
  validateStage,
  type Stage,
} from '../src/index.ts';

function sample(): Stage {
  const n = 4 * 2 * 2;
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  return {
    version: 1,
    id: 't-01',
    title: 'test',
    world: 1,
    grid: [4, 2, 2],
    voxelSize: 0.01,
    material: { E: 70e9, nu: 0.33, allowable: 120e6 },
    solid: encodeBitmask(new Array<boolean>(n).fill(true)),
    keep: encodeBitmask(keep),
    supports: [{ face: 'x-', fix: 'xyz' }],
    loads: [{ cells: [[3, 0, 0], [3, 0, 1]], force: [0, -500, 0] }],
    targets: { star1: 0.7, star2: 0.55, star3: 0.45 },
  };
}

describe('bitmask', () => {
  it('uses LSB-first bit order (same bytes as the Rust codec)', () => {
    const bits = new Array<boolean>(11).fill(false);
    bits[0] = true;
    bits[9] = true;
    expect(encodeBitmask(bits)).toBe(btoa(String.fromCharCode(1, 2)));
    expect(Array.from(decodeBitmask(encodeBitmask(bits), 11))).toEqual(bits.map(Number));
  });

  it('rejects a length mismatch', () => {
    expect(() => decodeBitmask(encodeBitmask([true, false]), 17)).toThrow();
  });
});

describe('indexing', () => {
  it('element index and coords are inverse', () => {
    const grid: [number, number, number] = [5, 3, 4];
    for (let e = 0; e < 60; e++) {
      const [x, y, z] = elementCoords(grid, e);
      expect(elementIndex(grid, x, y, z)).toBe(e);
    }
  });
});

describe('stage', () => {
  it('validates a good stage', () => {
    expect(validateStage(sample())).toEqual([]);
  });

  it('marks load and support cells as keep', () => {
    const s = sample();
    const keep = effectiveKeep(s);
    expect(keep[0]).toBe(1);
    expect(keep[elementIndex(s.grid, 3, 0, 1)]).toBe(1);
    expect(keep[elementIndex(s.grid, 1, 1, 1)]).toBe(0);
  });

  it('treats every solid cell on a face-only support face as supported and protected', () => {
    const s = sample();
    const supported = supportedCells(s);
    const keep = effectiveKeep(s);
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 2; y++) {
        expect(supported[elementIndex(s.grid, 0, y, z)]).toBe(1);
        expect(keep[elementIndex(s.grid, 0, y, z)]).toBe(1);
        expect(supported[elementIndex(s.grid, 1, y, z)]).toBe(0);
      }
    }
    expect(supported.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('rejects loads outside the solid', () => {
    const s = sample();
    s.loads[0]!.cells.push([9, 0, 0]);
    expect(validateStage(s).join()).toMatch(/load cell/);
  });

  it('accepts the committed stage files', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../../../stages/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const stage = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Stage;
      expect(validateStage(stage), f).toEqual([]);
      expect(stage.id + '.json').toBe(f);
    }
  });
});
