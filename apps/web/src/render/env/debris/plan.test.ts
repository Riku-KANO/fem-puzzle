import { describe, expect, it } from 'vitest';
import { cellIndex, makeGrid } from '../../../game/grid.ts';
import {
  CHIP_KINEMATICS,
  chipCounts,
  chipSpawn,
  components,
  greedyBoxes,
  outwardDir,
  randomQuat,
  resolveFx,
  rng,
  settleVerdict,
  type SettleRule,
} from './plan.ts';

describe('resolveFx', () => {
  it('physics by default, fade with reduced motion, off in the e2e build', () => {
    expect(resolveFx({ search: '', mode: 'development', reducedMotion: false })).toEqual({ env: true, debris: 'physics' });
    expect(resolveFx({ search: '', mode: 'production', reducedMotion: true }).debris).toBe('fade');
    expect(resolveFx({ search: '', mode: 'e2e', reducedMotion: false }).debris).toBe('off');
  });

  it('URL overrides', () => {
    expect(resolveFx({ search: '?debris=physics', mode: 'e2e', reducedMotion: true }).debris).toBe('physics');
    expect(resolveFx({ search: '?debris=off', mode: 'production', reducedMotion: false }).debris).toBe('off');
    expect(resolveFx({ search: '?debris=bogus', mode: 'production', reducedMotion: false }).debris).toBe('physics');
    expect(resolveFx({ search: '?env=0&stage=w1-01', mode: 'production', reducedMotion: false }).env).toBe(false);
  });
});

describe('rng', () => {
  it('is deterministic per seed and in [0, 1)', () => {
    const a = rng(42);
    const b = rng(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(rng(43)()).not.toBe(rng(42)());
  });

  it('random quaternions are unit length', () => {
    const r = rng(1);
    for (let i = 0; i < 100; i++) expect(Math.hypot(...randomQuat(r))).toBeCloseTo(1, 12);
  });
});

describe('chipCounts', () => {
  it('perCell each while within budget', () => {
    expect([...chipCounts(5, { perCell: 2, max: 40 })]).toEqual([2, 2, 2, 2, 2]);
  });

  it('spreads the budget evenly over many cells and never exceeds it', () => {
    const c = chipCounts(100, { perCell: 2, max: 30 });
    expect(c.reduce((s, x) => s + x, 0)).toBe(30);
    expect(Math.max(...c)).toBeLessThanOrEqual(2);
    // evenly: every block of 10 cells gets 3 chips
    for (let i = 0; i < 100; i += 10) expect(c.slice(i, i + 10).reduce((s, x) => s + x, 0)).toBe(3);
  });

  it('zero budget or no cells → nothing', () => {
    expect([...chipCounts(4, { perCell: 2, max: 0 })]).toEqual([0, 0, 0, 0]);
    expect(chipCounts(0, { perCell: 2, max: 10 }).length).toBe(0);
  });
});

describe('outwardDir', () => {
  const g = makeGrid([4, 4, 4]);
  const full = () => new Uint8Array(g.n).fill(1);

  it('points out of the face the cell was carved from', () => {
    const solid = full();
    const top = cellIndex(g, 1, 3, 1);
    solid[top] = 0;
    expect(outwardDir(g, solid, [1, 3, 1])).toEqual([0, 1, 0]);
  });

  it('a corner cell points diagonally out', () => {
    const solid = full();
    solid[cellIndex(g, 0, 3, 0)] = 0;
    const d = outwardDir(g, solid, [0, 3, 0]);
    const s = 1 / Math.sqrt(3);
    expect(d[0]).toBeCloseTo(-s, 12);
    expect(d[1]).toBeCloseTo(s, 12);
    expect(d[2]).toBeCloseTo(-s, 12);
  });

  it('an enclosed cell pops straight up', () => {
    const solid = full();
    solid[cellIndex(g, 1, 1, 1)] = 0;
    expect(outwardDir(g, solid, [1, 1, 1])).toEqual([0, 1, 0]);
  });

  it('a neighbour carved in the same stroke counts as open', () => {
    const solid = full();
    solid[cellIndex(g, 1, 3, 1)] = 0;
    solid[cellIndex(g, 2, 3, 1)] = 0;
    const d = outwardDir(g, solid, [1, 3, 1]);
    expect(d[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(d[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe('chipSpawn', () => {
  it('starts inside the cell, flies outward and up, deterministic per seed', () => {
    const k = { ...CHIP_KINEMATICS, h: 0.01, variants: 4 };
    const a = rng(7);
    const b = rng(7);
    for (let i = 0; i < 200; i++) {
      const s = chipSpawn(a, [0.05, 0.075, 0.02], [1, 0, 0], k);
      expect(chipSpawn(b, [0.05, 0.075, 0.02], [1, 0, 0], k)).toEqual(s);
      expect(Math.abs(s.position[0] - 0.05)).toBeLessThanOrEqual(0.003 + 1e-12);
      expect(Math.abs(s.position[1] - 0.075)).toBeLessThanOrEqual(0.003 + 1e-12);
      expect(s.linvel[0]).toBeGreaterThan(k.speed[0] - k.jitter);
      expect(s.linvel[1]).toBeGreaterThanOrEqual(k.pop[0]);
      expect(s.variant).toBeGreaterThanOrEqual(0);
      expect(s.variant).toBeLessThan(4);
      expect(Math.hypot(...s.rotation)).toBeCloseTo(1, 12);
    }
  });
});

describe('components', () => {
  it('splits a cell set into 6-connected pieces (diagonals do not connect)', () => {
    const g = makeGrid([5, 5, 2]);
    const a = [cellIndex(g, 0, 0, 0), cellIndex(g, 1, 0, 0), cellIndex(g, 1, 1, 0)];
    const b = [cellIndex(g, 2, 2, 0)]; // diagonal to a
    const c = [cellIndex(g, 4, 4, 1), cellIndex(g, 4, 4, 0)];
    const comps = components(g, [...c, ...b, ...a]);
    expect(comps.map((x) => x.length).sort()).toEqual([1, 2, 3]);
    expect(comps.find((x) => x.length === 3)).toEqual([...a].sort((p, q) => p - q));
  });
});

describe('greedyBoxes', () => {
  it('covers the set exactly with disjoint boxes', () => {
    const g = makeGrid([6, 5, 4]);
    const r = rng(3);
    for (let trial = 0; trial < 20; trial++) {
      const cells: number[] = [];
      for (let e = 0; e < g.n; e++) if (r() < 0.55) cells.push(e);
      const boxes = greedyBoxes(g, cells);
      const cover = new Uint8Array(g.n);
      for (const b of boxes) {
        for (let z = b.min[2]; z < b.max[2]; z++)
          for (let y = b.min[1]; y < b.max[1]; y++)
            for (let x = b.min[0]; x < b.max[0]; x++) cover[cellIndex(g, x, y, z)]!++;
      }
      const want = new Uint8Array(g.n);
      for (const e of cells) want[e] = 1;
      expect([...cover]).toEqual([...want]);
    }
  });

  it('a solid box is one box', () => {
    const g = makeGrid([4, 3, 2]);
    const all = Array.from({ length: g.n }, (_, i) => i);
    expect(greedyBoxes(g, all)).toEqual([{ min: [0, 0, 0], max: [4, 3, 2] }]);
  });
});

describe('settleVerdict', () => {
  const rule: SettleRule = {
    linear: 0.02,
    angular: 1,
    restTime: 0.3,
    pileMaxY: -0.13,
    killY: -1.5,
    maxAge: 8,
  };

  it('moving until it rests long enough', () => {
    expect(settleVerdict(rule, -0.15, 0.5, 3, 0, 0.2, false)).toBe('moving');
    expect(settleVerdict(rule, -0.15, 0.01, 0.1, 0.1, 1, false)).toBe('moving');
    expect(settleVerdict(rule, -0.15, 0.01, 0.1, 0.4, 1, false)).toBe('pile');
  });

  it('resting on the bench joins the pile; resting on the part or a jig fades', () => {
    expect(settleVerdict(rule, -0.157, 0, 0, 1, 2, true)).toBe('pile');
    expect(settleVerdict(rule, 0.05, 0, 0, 1, 2, true)).toBe('fade');
  });

  it('too old → settled anyway; fell off the world → kill', () => {
    expect(settleVerdict(rule, -0.9, 0.3, 2, 0, 9, false)).toBe('pile');
    expect(settleVerdict(rule, 0.02, 0.3, 2, 0, 9, false)).toBe('fade');
    expect(settleVerdict(rule, -2, 0.3, 2, 0, 1, false)).toBe('kill');
  });
});
