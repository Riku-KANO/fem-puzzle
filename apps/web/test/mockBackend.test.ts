import { encodeBitmask, type Stage } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { connectivity, debrisCells } from '../src/game/connectivity.ts';
import { buildDemoStage } from '../src/game/demoStage.ts';
import { cellIndex, makeGrid, nodeIndexOf } from '../src/game/grid.ts';
import { supportModel } from '../src/game/supports.ts';
import type { SolveHooks } from '../src/solver/backend.ts';
import { MockBackend } from '../src/solver/mockBackend.ts';

const quietHooks = (over: Partial<SolveHooks> = {}): SolveHooks => ({
  cancelled: () => false,
  progressDue: () => false,
  progress: () => {},
  yield: () => Promise.resolve(),
  ...over,
});

function boxStage(nx: number, ny: number, nz: number): Stage {
  const n = nx * ny * nz;
  return {
    ...buildDemoStage(),
    id: 'box',
    grid: [nx, ny, nz],
    solid: encodeBitmask(new Uint8Array(n).fill(1)),
    keep: encodeBitmask(new Uint8Array(n)),
    loads: [
      {
        cells: Array.from({ length: nz }, (_, z) => [nx - 1, ny - 1, z] as [number, number, number]),
        force: [0, -20000, 0],
      },
    ],
  };
}

describe('mock backend', () => {
  it('is deterministic: identical inputs give bit-identical outputs', async () => {
    const stage = buildDemoStage();
    const a = new MockBackend(stage);
    const b = new MockBackend(stage);
    const g = makeGrid(stage.grid);
    const cut = Uint32Array.of(cellIndex(g, 5, 4, 1), cellIndex(g, 6, 4, 1), cellIndex(g, 12, 3, 2));
    a.setSolid(cut, false);
    b.setSolid(cut, false);
    const ra = (await a.solve(quietHooks()))!;
    const rb = (await b.solve(quietHooks()))!;
    expect(ra.cases[0]!.utilization).toEqual(rb.cases[0]!.utilization);
    expect(ra.cases[0]!.displacement).toEqual(rb.cases[0]!.displacement);
    expect(ra.cases[0]!.maxUtilization).toBe(rb.cases[0]!.maxUtilization);
    expect(ra.converged).toBe(true);
  });

  it('is plausible: stress peaks at the clamp in the outer fibres, tip deflects along the load', () => {
    const stage = buildDemoStage();
    const g = makeGrid(stage.grid);
    const r = new MockBackend(stage).computeNow();
    const c = r.cases[0]!;
    const u = (x: number, y: number) => c.utilization[cellIndex(g, x, y, 1)]!;
    expect(u(0, 7)).toBeGreaterThan(u(12, 7));
    expect(u(12, 7)).toBeGreaterThan(u(20, 7));
    expect(u(0, 7)).toBeGreaterThan(u(0, 4)); // outer fibre vs near neutral axis
    expect(u(0, 0)).toBeCloseTo(u(0, 7), 5); // symmetric section
    expect(c.maxUtilization).toBeGreaterThan(0.2);
    expect(c.maxUtilization).toBeLessThan(0.6);
    expect(r.loadsConnected).toBe(true);
    expect(r.floating).toHaveLength(0);
    // displacement: clamp face fixed, tip moves down (force is −y)
    const tip = nodeIndexOf(g, 24, 8, 2);
    const root = nodeIndexOf(g, 0, 8, 2);
    expect(c.displacement[3 * tip + 1]).toBeLessThan(0);
    expect(c.displacement[3 * root + 1]).toBe(0);
    expect(c.loadDisplacement).toBeCloseTo(Math.abs(c.displacement[3 * tip + 1]!), 9);
  });

  it('removing material near the neutral axis costs less than removing a flange', () => {
    const stage = buildDemoStage();
    const g = makeGrid(stage.grid);
    const web = new MockBackend(stage);
    const flange = new MockBackend(stage);
    const webCells: number[] = [];
    const flangeCells: number[] = [];
    for (let x = 2; x < 20; x++) {
      for (let z = 0; z < 4; z++) {
        webCells.push(cellIndex(g, x, 3, z), cellIndex(g, x, 4, z));
        flangeCells.push(cellIndex(g, x, 7, z), cellIndex(g, x, 6, z));
      }
    }
    web.setSolid(Uint32Array.from(webCells), false);
    flange.setSolid(Uint32Array.from(flangeCells), false);
    const mWeb = web.computeNow().cases[0]!.maxUtilization;
    const mFlange = flange.computeNow().cases[0]!.maxUtilization;
    expect(mFlange).toBeGreaterThan(mWeb * 1.3);
  });

  it('detects floating material with a real 6-neighbour BFS', () => {
    const stage = buildDemoStage();
    const g = makeGrid(stage.grid);
    const be = new MockBackend(stage);
    // cut a full slice at x = 10: everything right of it floats, incl. the load cells
    const slice: number[] = [];
    for (let y = 0; y < 8; y++) for (let z = 0; z < 4; z++) slice.push(cellIndex(g, 10, y, z));
    be.setSolid(Uint32Array.from(slice), false);
    const r = be.computeNow();
    expect(r.floating).toHaveLength(13 * 8 * 4);
    expect(r.floating[0]).toBe(cellIndex(g, 11, 0, 0));
    expect(r.loadsConnected).toBe(false);
    // floating elements carry no stress
    expect(r.cases[0]!.utilization[cellIndex(g, 15, 3, 1)]).toBe(0);

    // a diagonal (edge-only) contact does not connect
    const s2 = new Uint8Array(g.n);
    s2[cellIndex(g, 0, 0, 0)] = 1;
    s2[cellIndex(g, 1, 1, 0)] = 1;
    const { floating } = connectivity(g, s2, supportModel(stage).supported);
    expect([...floating]).toEqual([cellIndex(g, 1, 1, 0)]);
  });

  it('debris excludes floating components that hold protected cells', () => {
    const g = makeGrid([6, 1, 1]);
    const keep = new Uint8Array(g.n);
    keep[5] = 1;
    // components {1,2} and {4,5}; the second holds a keep cell
    expect(debrisCells(g, [1, 2, 4, 5], keep)).toEqual([1, 2]);
  });

  it('is fast: < 20 ms per solve on 40×12×12', () => {
    const be = new MockBackend(boxStage(40, 12, 12));
    be.computeNow(); // warm up the JIT
    const t0 = performance.now();
    const runs = 5;
    for (let i = 0; i < runs; i++) be.computeNow();
    const per = (performance.now() - t0) / runs;
    expect(per).toBeLessThan(20);
  });

  it('posts progress when due and stops when cancelled', async () => {
    const be = new MockBackend(buildDemoStage(), { steps: 4 });
    const seen: number[] = [];
    const out = await be.solve(quietHooks({ progressDue: () => true, progress: (it) => seen.push(it) }));
    expect(out).not.toBeNull();
    expect(seen).toEqual([8, 16, 24]);
    let calls = 0;
    const cancelled = await be.solve(quietHooks({ cancelled: () => ++calls > 2 }));
    expect(cancelled).toBeNull();
  });

  it('handles a simply supported beam (supports at both ends, load in the middle)', () => {
    const base = boxStage(32, 8, 4);
    const stage: Stage = {
      ...base,
      supports: [
        { face: 'y-', fix: 'xyz', cells: [[0, 0, 0], [0, 0, 1], [0, 0, 2], [0, 0, 3]] },
        { face: 'y-', fix: 'y', cells: [[31, 0, 0], [31, 0, 1], [31, 0, 2], [31, 0, 3]] },
      ],
      loads: [{ cells: [[15, 7, 1], [16, 7, 1], [15, 7, 2], [16, 7, 2]], force: [0, -20000, 0] }],
    };
    const g = makeGrid(stage.grid);
    const c = new MockBackend(stage).computeNow().cases[0]!;
    const u = (x: number) => c.utilization[cellIndex(g, x, 0, 1)]!;
    expect(u(15)).toBeGreaterThan(u(8));
    expect(u(8)).toBeGreaterThan(u(2));
    const mid = nodeIndexOf(g, 16, 8, 2);
    expect(c.displacement[3 * mid + 1]).toBeLessThan(0);
  });
});
