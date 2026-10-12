import type { CaseResult } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { cellIndex, makeGrid, nodeIndexOf, type Grid } from '../../game/grid.ts';
import { chunkLayout, meshChunk } from '../mesher.ts';
import {
  autoScale,
  breakOrder,
  cellDisplacement,
  crackField,
  criticalCase,
  formatScale,
  maxActiveDisplacement,
  niceFloor,
  normalDeltas,
  vertexDisplacements,
} from './deform.ts';

/** Nodal field from a function of node coordinates (metres per component). */
function nodalField(g: Grid, f: (i: number, j: number, k: number) => [number, number, number]): Float32Array {
  const u = new Float32Array(3 * g.nodes);
  for (let k = 0; k <= g.nz; k++)
    for (let j = 0; j <= g.ny; j++)
      for (let i = 0; i <= g.nx; i++) {
        const n = nodeIndexOf(g, i, j, k);
        u.set(f(i, j, k), 3 * n);
      }
  return u;
}

function carvedGrid(): { g: Grid; solid: Uint8Array } {
  const g = makeGrid([11, 6, 5]);
  const solid = new Uint8Array(g.n).fill(1);
  // a notch, a through-hole and an inner cavity so inner/outer faces of every orientation exist
  for (let z = 0; z < 5; z++) solid[cellIndex(g, 5, 5, z)] = 0;
  for (let y = 0; y < 6; y++) solid[cellIndex(g, 8, y, 2)] = 0;
  solid[cellIndex(g, 2, 2, 2)] = 0;
  return { g, solid };
}

describe('vertex displacement lookup', () => {
  it('every mesh vertex reads the nodal value of the grid node it sits on', () => {
    const { g, solid } = carvedGrid();
    const h = 0.01;
    // unique per node and component: node n, component c → (3n + c + 1) µm
    const nodal = new Float32Array(3 * g.nodes);
    for (let i = 0; i < nodal.length; i++) nodal[i] = (i + 1) * 1e-6;
    const layout = chunkLayout(g, 4); // several chunks, including partial ones
    let checked = 0;
    for (let c = 0; c < layout.count; c++) {
      const m = meshChunk(g, layout, c, solid);
      const disp = vertexDisplacements(m.vertexNode, nodal, h);
      expect(disp.length).toBe(m.positions.length);
      for (let v = 0; v < m.vertexNode.length; v++) {
        // node from the vertex position, independently of the mesher's own bookkeeping
        const node = nodeIndexOf(g, m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!);
        expect(m.vertexNode[v]).toBe(node);
        for (let k = 0; k < 3; k++) {
          const want = nodal[3 * node + k]! / h;
          expect(Math.abs(disp[v * 3 + k]! - want)).toBeLessThanOrEqual(1e-6 * Math.abs(want));
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('reproduces a linear field exactly (trilinear interpolation at nodes)', () => {
    const { g, solid } = carvedGrid();
    const h = 0.02;
    const A = [
      [1e-4, 2e-5, -3e-5],
      [-2e-5, 5e-5, 1e-5],
      [3e-6, -4e-6, 2e-5],
    ];
    const b = [1e-5, -2e-5, 3e-6];
    const lin = (p: readonly number[]) =>
      [0, 1, 2].map((r) => b[r]! + A[r]![0]! * p[0]! * h + A[r]![1]! * p[1]! * h + A[r]![2]! * p[2]! * h) as [
        number,
        number,
        number,
      ];
    const nodal = nodalField(g, (i, j, k) => lin([i, j, k]));
    const layout = chunkLayout(g);
    for (let c = 0; c < layout.count; c++) {
      const m = meshChunk(g, layout, c, solid);
      const disp = vertexDisplacements(m.vertexNode, nodal, h);
      for (let v = 0; v < m.vertexNode.length; v++) {
        const want = lin([m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!]);
        for (let k = 0; k < 3; k++) expect(disp[v * 3 + k]! * h).toBeCloseTo(want[k]!, 8);
      }
    }
  });

  it('cellDisplacement averages the 8 corners (= centre value of a linear field)', () => {
    const g = makeGrid([4, 3, 2]);
    const nodal = nodalField(g, (i, j, k) => [i * 1e-3, j * 2e-3 + k * 1e-3, 5e-4]);
    const [ux, uy, uz] = cellDisplacement(g, cellIndex(g, 2, 1, 0), nodal);
    expect(ux).toBeCloseTo(2.5e-3, 9);
    expect(uy).toBeCloseTo(1.5 * 2e-3 + 0.5e-3, 9);
    expect(uz).toBeCloseTo(5e-4, 9);
  });
});

describe('auto scale', () => {
  it('max displacement only counts nodes of flagged elements', () => {
    const g = makeGrid([3, 1, 1]);
    const nodal = new Float32Array(3 * g.nodes);
    // a huge value on the far x+ end (nodes of element 2 only)
    nodal[3 * nodeIndexOf(g, 3, 1, 1) + 1] = -5;
    nodal[3 * nodeIndexOf(g, 1, 0, 0)] = 3e-4;
    nodal[3 * nodeIndexOf(g, 1, 0, 0) + 2] = 4e-4;
    const flags = new Uint8Array([1, 1, 0]);
    expect(maxActiveDisplacement(g, flags, nodal)).toBeCloseTo(5e-4, 9);
    flags[2] = 1;
    expect(maxActiveDisplacement(g, flags, nodal)).toBeCloseTo(5, 6);
  });

  it('niceFloor picks 1/2/2.5/5 × 10^k not above x', () => {
    expect(niceFloor(1)).toBe(1);
    expect(niceFloor(1000)).toBe(1000);
    expect(niceFloor(3.9)).toBe(2.5);
    expect(niceFloor(273)).toBe(250);
    expect(niceFloor(199)).toBe(100);
    expect(niceFloor(0.07)).toBeCloseTo(0.05, 12);
    expect(niceFloor(9999)).toBe(5000);
    expect(niceFloor(0)).toBe(0);
    expect(niceFloor(Number.NaN)).toBe(0);
    expect(niceFloor(Infinity)).toBe(0);
  });

  it('shows the largest displacement at 5–10 % of the smallest extent', () => {
    const g = makeGrid([32, 8, 8]);
    const h = 0.01;
    for (const maxU of [3.1e-6, 1e-5, 4.7e-5, 2e-4, 0.013]) {
      const s = autoScale(maxU, g, h);
      const shown = (maxU * s) / (8 * h);
      expect(shown).toBeLessThanOrEqual(0.1 + 1e-12);
      expect(shown).toBeGreaterThan(0.05);
    }
    expect(autoScale(0, g, h)).toBe(0);
    expect(autoScale(Number.NaN, g, h)).toBe(0);
  });

  it('formats the factor for the HUD', () => {
    expect(formatScale(250)).toBe('×250');
    expect(formatScale(12000)).toBe('×12,000');
    expect(formatScale(0.5)).toBe('×0.5');
    expect(formatScale(0)).toBe('×—');
  });
});

describe('deformed normals', () => {
  const g = makeGrid([3, 2, 2]);
  const solid = new Uint8Array(g.n).fill(1);
  const m = meshChunk(g, chunkLayout(g), 0, solid);

  it('vanish for zero and rigid-translation displacement', () => {
    const zero = new Float32Array(m.positions.length);
    expect(Math.max(...normalDeltas(m.positions, m.normals, zero, 100).map(Math.abs))).toBe(0);
    const shift = new Float32Array(m.positions.length);
    for (let v = 0; v < shift.length / 3; v++) shift.set([0.3, -0.2, 0.1], v * 3);
    const d = normalDeltas(m.positions, m.normals, shift, 10);
    expect(Math.max(...d.map(Math.abs))).toBeLessThan(1e-6);
  });

  it('follow a small rigid rotation about z', () => {
    const a = 0.05;
    const disp = new Float32Array(m.positions.length);
    for (let v = 0; v < disp.length / 3; v++) {
      const x = m.positions[v * 3]!;
      const y = m.positions[v * 3 + 1]!;
      disp[v * 3] = x * Math.cos(a) - y * Math.sin(a) - x;
      disp[v * 3 + 1] = x * Math.sin(a) + y * Math.cos(a) - y;
    }
    const d = normalDeltas(m.positions, m.normals, disp, 1);
    for (let v = 0; v < disp.length / 3; v++) {
      const nx = m.normals[v * 3]!;
      const ny = m.normals[v * 3 + 1]!;
      expect(nx + d[v * 3]!).toBeCloseTo(nx * Math.cos(a) - ny * Math.sin(a), 5);
      expect(ny + d[v * 3 + 1]!).toBeCloseTo(nx * Math.sin(a) + ny * Math.cos(a), 5);
      expect(d[v * 3 + 2]!).toBeCloseTo(0, 6);
    }
  });
});

describe('over-stress', () => {
  it('break order: flagged, unprotected, > 1 (NaN first), highest first, ties by index', () => {
    const u = new Float32Array([0.5, 1.2, 1.0, 3.0, 1.2, Number.NaN, 2.0, 5.0]);
    const flags = new Uint8Array([1, 1, 1, 1, 1, 1, 0, 1]);
    const keep = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(breakOrder(u, flags, keep)).toEqual([5, 3, 1, 4]);
  });

  it('crack field ramps from 0.35 above the allowable to 1 at 150 %', () => {
    const u = new Float32Array([0.9, 1.0, 1.0001, 1.25, 1.5, 4, 2, Number.NaN]);
    const flags = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]);
    const keep = new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0]);
    const c = crackField(u, flags, keep);
    expect(c[0]).toBe(0);
    expect(c[1]).toBe(0);
    expect(c[2]).toBeCloseTo(0.35, 3);
    expect(c[3]).toBeCloseTo(0.675, 5);
    expect(c[4]).toBeCloseTo(1, 6);
    expect(c[5]).toBe(1);
    expect(c[6]).toBe(0);
    expect(c[7]).toBe(1);
  });

  it('critical case: highest judged utilisation, then load displacement', () => {
    const mk = (name: string, maxUtilization: number, loadDisplacement: number): CaseResult => ({
      name,
      maxUtilization,
      loadDisplacement,
      utilization: new Float32Array(0),
      displacement: new Float32Array(0),
    });
    expect(criticalCase([mk('a', 0.5, 1)])).toBe(0);
    expect(criticalCase([mk('a', 0.5, 1), mk('b', 0.9, 0.1), mk('c', 0.7, 3)])).toBe(1);
    expect(criticalCase([mk('a', 0.9, 1), mk('b', 0.9, 2)])).toBe(1);
  });
});
