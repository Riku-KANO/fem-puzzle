import {
  decodeBitmask,
  effectiveKeep,
  elementCount,
  encodeBitmask,
  type ResultMsg,
  type Stage,
} from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { buildDemoStage } from '../demoStage.ts';
import { listStages } from '../stages.ts';
import { judge, JUDGE_MESSAGES, starsFor, type Judgement, type RuleId } from './judge.ts';

// --- fixtures ----------------------------------------------------------------

const NX = 10;
const NY = 3;
const N = NX * NY;
const idx = (x: number, y: number) => x + NX * y;

/**
 * 10×3×1 plate: clamped on x− (cells x = 0 are supported), loaded at the top of the free end
 * (cell [9,2,0]); cell [5,2,0] is an extra authored keep cell. Initial solid = 30 cells.
 */
function plate(over: Partial<Stage> = {}): Stage {
  const keep = new Uint8Array(N);
  keep[idx(5, 2)] = 1;
  return {
    ...buildDemoStage(),
    id: 'plate',
    grid: [NX, NY, 1],
    solid: encodeBitmask(new Uint8Array(N).fill(1)),
    keep: encodeBitmask(keep),
    loads: [{ cells: [[9, 2, 0]], force: [0, -500, 0] }],
    targets: { star1: 0.8, star2: 0.6, star3: 0.5 },
    ...over,
  };
}

const full = () => new Uint8Array(N).fill(1);

/** Plate with rows y = 0 and y = 1 carved between x = from..to (top row y = 2 stays). */
function carved(from = 1, to = 8): Uint8Array {
  const s = full();
  for (let x = from; x <= to; x++) {
    s[idx(x, 0)] = 0;
    s[idx(x, 1)] = 0;
  }
  return s;
}

interface CaseSpec {
  name?: string;
  u: number;
  d?: number;
}

function result(cases: CaseSpec[], over: Partial<ResultMsg> = {}): ResultMsg {
  return {
    type: 'result',
    seq: 3,
    converged: true,
    iterations: 12,
    relResidual: 5e-5,
    elapsedMs: 1,
    cases: cases.map((c, i) => ({
      name: c.name ?? (i === 0 ? 'default' : `case${i}`),
      utilization: new Float32Array(N),
      displacement: new Float32Array(3 * (NX + 1) * (NY + 1) * 2),
      maxUtilization: c.u,
      loadDisplacement: c.d ?? 1e-4,
    })),
    floating: new Uint32Array(0),
    loadsConnected: true,
    ...over,
  };
}

const ok = (u = 0.5) => result([{ u }]);
const statusOf = (j: Judgement, id: RuleId) => j.rules.find((r) => r.id === id)?.status;
const ruleOf = (j: Judgement, id: RuleId) => {
  const r = j.rules.find((x) => x.id === id);
  if (!r) throw new Error(`rule ${id} missing`);
  return r;
};

// --- stars ---------------------------------------------------------------------

describe('starsFor', () => {
  const t = { star1: 0.7, star2: 0.55, star3: 0.45 };
  it('lower volume earns more stars, thresholds inclusive', () => {
    expect(starsFor(t, 1)).toBe(0);
    expect(starsFor(t, 0.7000001)).toBe(0);
    expect(starsFor(t, 0.7)).toBe(1);
    expect(starsFor(t, 0.56)).toBe(1);
    expect(starsFor(t, 0.55)).toBe(2);
    expect(starsFor(t, 0.45)).toBe(3);
    expect(starsFor(t, 0.1)).toBe(3);
  });
  it('fractions computed from counts hit the threshold despite rounding', () => {
    // 0.45 is not exact in binary; 45/100 must still count as 3 stars
    expect(starsFor(t, 45 / 100)).toBe(3);
    expect(starsFor({ star1: 0.7, star2: 0.55, star3: 0.3 }, 3 / 10)).toBe(3);
  });
  it('NaN volume earns nothing', () => {
    expect(starsFor(t, Number.NaN)).toBe(0);
  });
});

// --- rules ---------------------------------------------------------------------

describe('judge: passing designs and stars', () => {
  it('the untouched block passes every rule but earns no stars', () => {
    const j = judge(plate(), full(), ok());
    expect(j.passed).toBe(true);
    expect(j.outcome).toBe('noStars');
    expect(j.stars).toBe(0);
    expect(j.volumeFraction).toBe(1);
    expect(j.solidCount).toBe(30);
    expect(j.initialCount).toBe(30);
    expect(j.headline).toBe(JUDGE_MESSAGES.noStars);
    expect(j.rules.map((r) => [r.id, r.status])).toEqual([
      ['connectivity', 'pass'],
      ['keep', 'pass'],
      ['stability', 'pass'],
      ['strength', 'pass'],
      ['stiffness', 'na'],
    ]);
  });

  it('a carved, passing design earns stars from the volume fraction', () => {
    const solid = carved(); // 30 − 16 = 14 cells → 0.4667
    const j = judge(plate(), solid, ok(0.9));
    expect(j.solidCount).toBe(14);
    expect(j.volumeFraction).toBeCloseTo(14 / 30, 12);
    expect(j.passed).toBe(true);
    expect(j.outcome).toBe('clear');
    expect(j.stars).toBe(3);
    expect(j.volumeStars).toBe(3);
    expect(j.headline).toBe(JUDGE_MESSAGES.clear);
    const two = judge(plate(), carved(1, 5), ok()); // 30 − 10 = 20 → 0.667
    expect(two.stars).toBe(1);
    const three = judge(plate(), carved(1, 7), ok()); // 30 − 14 = 16 → 0.533
    expect(three.stars).toBe(2);
  });

  it('accepts any 0/1-like solid flags (number arrays)', () => {
    const j = judge(plate(), Array.from(carved()), ok());
    expect(j.solidCount).toBe(14);
  });

  it('rejects a solid array of the wrong length', () => {
    expect(() => judge(plate(), new Uint8Array(N - 1), ok())).toThrow(/elements/);
  });
});

describe('judge: strength', () => {
  it('utilisation exactly 1 passes, anything above fails', () => {
    expect(statusOf(judge(plate(), carved(), ok(1)), 'strength')).toBe('pass');
    const j = judge(plate(), carved(), ok(1.02));
    expect(j.passed).toBe(false);
    expect(j.outcome).toBe('fail');
    expect(j.stars).toBe(0);
    expect(j.volumeStars).toBe(3); // the goal is still shown
    const r = ruleOf(j, 'strength');
    expect(r.status).toBe('fail');
    expect(r.value).toBeCloseTo(1.02);
    expect(r.limit).toBe(1);
    expect(r.caseName).toBeUndefined(); // single case: no case name
    expect(j.headline).toBe(JUDGE_MESSAGES.strengthOver);
  });

  it('a NaN utilisation never passes', () => {
    const j = judge(plate(), carved(), ok(Number.NaN));
    expect(statusOf(j, 'strength')).toBe('fail');
    expect(j.passed).toBe(false);
  });

  it('a converged result without any case cannot pass', () => {
    const j = judge(plate(), carved(), result([]));
    expect(statusOf(j, 'strength')).toBe('unknown');
    expect(j.passed).toBe(false);
    expect(j.headline).toBe(JUDGE_MESSAGES.noCases);
  });
});

describe('judge: multi-case stages (loadCases)', () => {
  const multi = (over: Partial<Stage> = {}) =>
    plate({
      loads: [],
      loadCases: [
        { name: '重力', loads: [{ cells: [[9, 2, 0]], force: [0, -500, 0] }] },
        { name: '風', loads: [{ cells: [[9, 1, 0]], force: [300, 0, 0] }] },
      ],
      ...over,
    });

  it('passes only when every case is within the allowable stress', () => {
    const s = carved(); // keeps the end column x = 9, so the wind load cell [9,1,0] stays connected
    const pass = judge(multi(), s, result([{ name: '重力', u: 0.8 }, { name: '風', u: 0.95 }]));
    expect(pass.passed).toBe(true);
    expect(pass.cases.map((c) => c.name)).toEqual(['重力', '風']);
    expect(ruleOf(pass, 'strength')).toMatchObject({ status: 'pass', caseName: '風' });
    expect(ruleOf(pass, 'strength').value).toBeCloseTo(0.95);

    const fail = judge(multi(), s, result([{ name: '重力', u: 1.3 }, { name: '風', u: 0.4 }]));
    expect(fail.passed).toBe(false);
    expect(ruleOf(fail, 'strength')).toMatchObject({ status: 'fail', caseName: '重力' });
    expect(fail.cases.map((c) => c.strength)).toEqual([false, true]);
  });

  it('load cells of every case are protected and must stay connected', () => {
    // wind load cell [9,1,0] carved away: protected cell missing → keep fails, and its load
    // path is gone → connectivity fails
    const j = judge(multi(), carved(1, 9), result([{ u: 0.5 }, { u: 0.5 }]));
    expect(statusOf(j, 'keep')).toBe('fail');
    expect(statusOf(j, 'connectivity')).toBe('fail');
    expect(j.passed).toBe(false);
  });

  it('stiffness is checked on every case and reports the worst one', () => {
    const s = carved();
    const j = judge(
      multi({ maxDisplacement: 2e-3 }),
      s,
      result([
        { name: '重力', u: 0.5, d: 1e-3 },
        { name: '風', u: 0.5, d: 3e-3 },
      ]),
    );
    expect(ruleOf(j, 'stiffness')).toMatchObject({ status: 'fail', caseName: '風', limit: 2e-3 });
    expect(ruleOf(j, 'stiffness').value).toBeCloseTo(3e-3);
    expect(j.cases.map((c) => c.stiffness)).toEqual([true, false]);
    expect(j.passed).toBe(false);
  });

  it('falls back to the stage case names when the result has none', () => {
    const s = carved();
    const j = judge(multi(), s, result([{ name: '', u: 0.5 }, { name: '', u: 0.5 }]));
    expect(j.cases.map((c) => c.name)).toEqual(['重力', '風']);
  });
});

describe('judge: stiffness', () => {
  it('is not applicable without maxDisplacement', () => {
    const j = judge(plate(), carved(), result([{ u: 0.5, d: 10 }]));
    expect(ruleOf(j, 'stiffness')).toMatchObject({ status: 'na', message: JUDGE_MESSAGES.noStiffnessRule });
    expect(j.passed).toBe(true);
    expect(j.cases[0]?.stiffness).toBeNull();
  });

  it('passes at the limit and fails above it', () => {
    const stage = plate({ maxDisplacement: 1e-3 });
    expect(statusOf(judge(stage, carved(), result([{ u: 0.5, d: 1e-3 }])), 'stiffness')).toBe('pass');
    const j = judge(stage, carved(), result([{ u: 0.5, d: 1.5e-3 }]));
    expect(ruleOf(j, 'stiffness')).toMatchObject({ status: 'fail', value: 1.5e-3, limit: 1e-3 });
    expect(j.passed).toBe(false);
    expect(j.headline).toBe(JUDGE_MESSAGES.stiffnessOver);
  });

  it('a NaN displacement fails', () => {
    const j = judge(plate({ maxDisplacement: 1e-3 }), carved(), result([{ u: 0.5, d: Number.NaN }]));
    expect(statusOf(j, 'stiffness')).toBe('fail');
  });
});

describe('judge: not converged (mechanism / stalled CG)', () => {
  it('fails with 構造が安定していません even when the numbers look fine', () => {
    const j = judge(plate({ maxDisplacement: 1 }), carved(), result([{ u: 0.1, d: 0 }], { converged: false }));
    expect(j.passed).toBe(false);
    expect(j.outcome).toBe('fail');
    expect(j.stars).toBe(0);
    expect(j.headline).toBe('構造が安定していません');
    expect(statusOf(j, 'stability')).toBe('fail');
    expect(ruleOf(j, 'stability').message).toContain('構造が安定していません');
    // utilisation / displacement of an unconverged solve are not trusted
    expect(statusOf(j, 'strength')).toBe('unknown');
    expect(statusOf(j, 'stiffness')).toBe('unknown');
    expect(ruleOf(j, 'strength').message).toBe(JUDGE_MESSAGES.notSolved);
  });

  it('never passes, whatever else the result says', () => {
    for (const u of [0, 0.5, 1]) {
      const j = judge(plate(), full(), result([{ u }], { converged: false }));
      expect(j.passed).toBe(false);
    }
  });
});

describe('judge: connectivity', () => {
  it('fails when the solver reports the loads disconnected', () => {
    const j = judge(plate(), carved(), ok());
    expect(statusOf(j, 'connectivity')).toBe('pass');
    const bad = judge(plate(), carved(), result([{ u: 0.01 }], { loadsConnected: false }));
    expect(bad.passed).toBe(false);
    expect(statusOf(bad, 'connectivity')).toBe('fail');
    expect(bad.headline).toBe(JUDGE_MESSAGES.disconnected);
    // without a load path, low utilisation means nothing
    expect(statusOf(bad, 'strength')).toBe('unknown');
    expect(statusOf(bad, 'stability')).toBe('unknown');
    expect(ruleOf(bad, 'strength').message).toBe(JUDGE_MESSAGES.noLoadPath);
  });

  it('cross-checks the solid flags: a cut beam fails even if a stale result says connected', () => {
    const s = full();
    for (let y = 0; y < NY; y++) s[idx(7, y)] = 0; // cut through at x = 7
    const j = judge(plate(), s, ok());
    expect(statusOf(j, 'connectivity')).toBe('fail');
    expect(j.passed).toBe(false);
  });

  it('a connection through edges or corners only does not count (6-neighbour)', () => {
    // keep only a diagonal staircase between the support column and the load
    const s = new Uint8Array(N);
    for (let y = 0; y < NY; y++) s[idx(0, y)] = 1;
    s[idx(1, 2)] = 1;
    s[idx(2, 1)] = 1; // touches [1,2] only at an edge
    s[idx(5, 2)] = 1;
    s[idx(9, 2)] = 1;
    const j = judge(plate(), s, ok());
    expect(statusOf(j, 'connectivity')).toBe('fail');
  });
});

describe('judge: keep intact', () => {
  it('fails when an authored keep cell was removed', () => {
    const s = carved();
    s[idx(5, 2)] = 0; // authored keep cell (also cuts the top row)
    const j = judge(plate(), s, ok());
    expect(ruleOf(j, 'keep')).toMatchObject({ status: 'fail', value: 1, message: JUDGE_MESSAGES.keepMissing });
    expect(j.passed).toBe(false);
  });

  it('supported cells and load cells are protected too', () => {
    const noSupportCell = full();
    noSupportCell[idx(0, 0)] = 0; // a cell of the clamped x− face
    expect(ruleOf(judge(plate(), noSupportCell, ok()), 'keep')).toMatchObject({ status: 'fail', value: 1 });
    const noLoadCell = full();
    noLoadCell[idx(9, 2)] = 0;
    const j = judge(plate(), noLoadCell, ok());
    expect(statusOf(j, 'keep')).toBe('fail');
    expect(statusOf(j, 'connectivity')).toBe('fail');
  });

  it('fails when a protected part is cut off from the supports', () => {
    // cut the column x = 4 and the lower rows right of it: the keep cell [5,2] and the load
    // end float together
    const s = full();
    for (let y = 0; y < NY; y++) s[idx(4, y)] = 0;
    const j = judge(plate(), s, ok());
    expect(ruleOf(j, 'keep')).toMatchObject({ status: 'fail', message: JUDGE_MESSAGES.keepFloating });
    // [5,2] and the load cell [9,2] float
    expect(ruleOf(j, 'keep').value).toBe(2);
  });

  it('uses the effective keep set of the stage (protocol effectiveKeep)', () => {
    const stage = plate();
    const keep = effectiveKeep(stage);
    // 3 supported cells (x = 0) + authored [5,2] + load [9,2]
    expect(keep.reduce((a, b) => a + b, 0)).toBe(5);
    const s = new Uint8Array(N);
    // the minimal design that keeps every protected cell connected: the top row + x = 0
    for (let x = 0; x < NX; x++) s[idx(x, 2)] = 1;
    s[idx(0, 0)] = 1;
    s[idx(0, 1)] = 1;
    const j = judge(stage, s, ok(0.99));
    expect(j.passed).toBe(true);
    expect(j.solidCount).toBe(12);
  });
});

describe('judge: benchmark comparison', () => {
  /** benchmark = the top row + support column (12 cells, volume 0.4) */
  function benchSolid(): Uint8Array {
    const s = new Uint8Array(N);
    for (let x = 0; x < NX; x++) s[idx(x, 2)] = 1;
    s[idx(0, 0)] = 1;
    s[idx(0, 1)] = 1;
    return s;
  }
  const withBench = (solid = benchSolid(), volume = 12 / 30) =>
    plate({ benchmark: { volume, solid: encodeBitmask(solid), maxUtilization: 0.9, method: 'simp-oc' } });

  it('no benchmark: comparison is null and never beaten', () => {
    const j = judge(plate(), carved(), ok());
    expect(j.benchmark).toBeNull();
    expect(j.beatsBenchmark).toBe(false);
  });

  it('heavier than the benchmark: behind, positive delta', () => {
    const j = judge(withBench(), carved(), ok()); // 14 vs 12 cells
    expect(j.benchmark).toMatchObject({ relation: 'behind', solidCount: 12, maxUtilization: 0.9, method: 'simp-oc' });
    expect(j.benchmark?.volumeFraction).toBeCloseTo(0.4, 12);
    expect(j.benchmark?.delta).toBeCloseTo(2 / 30, 12);
    expect(j.beatsBenchmark).toBe(false);
  });

  it('same cell count: tied, not beaten', () => {
    const j = judge(withBench(), benchSolid(), ok());
    expect(j.benchmark?.relation).toBe('tied');
    expect(j.benchmark?.delta).toBe(0);
    expect(j.beatsBenchmark).toBe(false);
  });

  it('lighter than the benchmark and passing: beaten (special badge)', () => {
    const heavy = benchSolid();
    heavy[idx(3, 1)] = 1;
    heavy[idx(4, 1)] = 1; // a 14-cell benchmark
    const j = judge(withBench(heavy, 14 / 30), benchSolid(), ok(0.99));
    expect(j.passed).toBe(true);
    expect(j.benchmark?.relation).toBe('beaten');
    expect(j.benchmark?.delta).toBeCloseTo(-2 / 30, 12);
    expect(j.beatsBenchmark).toBe(true);
  });

  it('a failed design never beats the benchmark, even when lighter', () => {
    const heavy = benchSolid();
    heavy[idx(3, 1)] = 1;
    heavy[idx(4, 1)] = 1;
    const j = judge(withBench(heavy, 14 / 30), benchSolid(), ok(1.2));
    expect(j.benchmark?.relation).toBe('beaten');
    expect(j.beatsBenchmark).toBe(false);
  });

  it('falls back to benchmark.volume when its bitmask cannot be decoded', () => {
    const stage = plate({ benchmark: { volume: 0.5, solid: 'AA==' } });
    const j = judge(stage, carved(), ok()); // 0.4667 < 0.5
    expect(j.benchmark).toMatchObject({ solidCount: null, volumeFraction: 0.5, relation: 'beaten' });
    expect(j.benchmark?.maxUtilization).toBeUndefined();
    expect(j.beatsBenchmark).toBe(true);
  });
});

// --- bundled stages (with or without T-203's benchmark) ----------------------------

describe('judge on the bundled stages', () => {
  const stages = listStages().stages.map((s) => s.stage);

  it.each(stages.map((s) => [s.id, s] as const))('%s: the full block is connected and keeps every protected cell', (_id, stage) => {
    const n = elementCount(stage.grid);
    const solid = decodeBitmask(stage.solid, n);
    const cases = (stage.loadCases?.length ?? 0) > 0 ? stage.loadCases!.length : 1;
    const j = judge(stage, solid, result(Array.from({ length: cases }, () => ({ u: 0.5 }))));
    expect(statusOf(j, 'connectivity')).toBe('pass');
    expect(statusOf(j, 'keep')).toBe('pass');
    expect(j.passed).toBe(true);
    expect(j.volumeFraction).toBe(1);
    expect(j.outcome).toBe('noStars');
  });

  it.each(stages.filter((s) => s.benchmark).map((s) => [s.id, s] as const))(
    '%s: the benchmark design satisfies the player rules and ties with itself',
    (_id, stage) => {
      const n = elementCount(stage.grid);
      const bench = decodeBitmask(stage.benchmark!.solid, n);
      const cases = (stage.loadCases?.length ?? 0) > 0 ? stage.loadCases!.length : 1;
      const u = stage.benchmark!.maxUtilization ?? 0.9;
      const j = judge(stage, bench, result(Array.from({ length: cases }, () => ({ u }))));
      expect(statusOf(j, 'connectivity')).toBe('pass');
      expect(statusOf(j, 'keep')).toBe('pass');
      expect(j.passed).toBe(true);
      expect(j.benchmark?.relation).toBe('tied');
      expect(j.benchmark?.volumeFraction).toBeCloseTo(stage.benchmark!.volume, 9);
      // the benchmark itself earns ★★★ (targets.star3 = bench + 0.05 in T-203's calibration)
      expect(j.stars).toBe(3);
    },
  );
});
