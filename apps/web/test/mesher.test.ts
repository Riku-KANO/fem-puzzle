import { describe, expect, it } from 'vitest';
import { cellIndex, FACE_DIRS, makeGrid } from '../src/game/grid.ts';
import { chunkLayout, chunksTouching, countSurfaceQuads, meshChunk } from '../src/render/mesher.ts';

const surface = (nx: number, ny: number, nz: number) => 2 * (nx * ny + ny * nz + nz * nx);

describe('voxel mesher', () => {
  it('full box: face count equals the surface area (chunk boundaries add nothing)', () => {
    const cases: [number, number, number][] = [
      [24, 8, 4],
      [9, 17, 3],
      [1, 1, 1],
      [40, 12, 12],
    ];
    for (const [nx, ny, nz] of cases) {
      const g = makeGrid([nx, ny, nz]);
      const solid = new Uint8Array(g.n).fill(1);
      expect(countSurfaceQuads(g, solid)).toBe(surface(nx, ny, nz));
      expect(countSurfaceQuads(g, solid, 4)).toBe(surface(nx, ny, nz));
    }
  });

  it('carving a corner keeps the count, a face cell adds 4, an interior cell adds 6', () => {
    const g = makeGrid([24, 8, 4]);
    const base = surface(24, 8, 4);
    const corner = new Uint8Array(g.n).fill(1);
    corner[cellIndex(g, 23, 7, 3)] = 0;
    expect(countSurfaceQuads(g, corner)).toBe(base);

    const face = new Uint8Array(g.n).fill(1);
    face[cellIndex(g, 10, 7, 2)] = 0; // top face, not on an edge
    expect(countSurfaceQuads(g, face)).toBe(base + 4);

    const interior = new Uint8Array(g.n).fill(1);
    interior[cellIndex(g, 8, 4, 2)] = 0; // on chunk boundary x = 8 on purpose
    expect(countSurfaceQuads(g, interior)).toBe(base + 6);

    const slot = new Uint8Array(g.n).fill(1);
    for (let z = 0; z < 4; z++) slot[cellIndex(g, 12, 7, z)] = 0; // groove across the top
    // removed: 4 top + 2 end faces; added: 4 bottoms + 2×4 walls
    expect(countSurfaceQuads(g, slot)).toBe(base - 6 + 12);
  });

  it('empty grid has no faces; a lone voxel has 6', () => {
    const g = makeGrid([5, 5, 5]);
    const flags = new Uint8Array(g.n);
    expect(countSurfaceQuads(g, flags)).toBe(0);
    flags[cellIndex(g, 2, 2, 2)] = 1;
    expect(countSurfaceQuads(g, flags)).toBe(6);
  });

  it('quads wind counter-clockwise seen from outside and carry element/node ids', () => {
    const g = makeGrid([1, 1, 1]);
    const m = meshChunk(g, chunkLayout(g), 0, new Uint8Array([1]));
    expect(m.quadCount).toBe(6);
    const v = (i: number) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
    for (let q = 0; q < 6; q++) {
      const [a, b, c] = [v(m.indices[q * 6]!), v(m.indices[q * 6 + 1]!), v(m.indices[q * 6 + 2]!)];
      const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      expect(n).toEqual([...FACE_DIRS[m.quadFace[q]!]!.normal]);
      expect(m.quadElement[q]).toBe(0);
    }
    // vertex nodes: node (i,j,k) = i + 2*(j + 2*k) for a 1×1×1 grid
    for (let i = 0; i < m.vertexNode.length; i++) {
      const [x, y, z] = v(i);
      expect(m.vertexNode[i]).toBe(x! + 2 * (y! + 2 * z!));
    }
  });

  it('chunksTouching includes neighbouring chunks across a boundary', () => {
    const g = makeGrid([24, 8, 4]);
    const l = chunkLayout(g);
    expect(l.count).toBe(3);
    expect([...chunksTouching(g, l, [cellIndex(g, 3, 3, 1)])]).toEqual([0]);
    expect([...chunksTouching(g, l, [cellIndex(g, 7, 3, 1)])].sort()).toEqual([0, 1]);
    expect([...chunksTouching(g, l, [cellIndex(g, 16, 3, 1)])].sort()).toEqual([1, 2]);
  });
});
