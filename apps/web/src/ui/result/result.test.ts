import { encodeBitmask, type ResultMsg, type Stage } from '@stress-carve/protocol';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildDemoStage } from '../../game/demoStage.ts';
import { makeGrid } from '../../game/grid.ts';
import { judge, type BenchmarkComparison, type Judgement, type RuleVerdict, type StageClear } from '../../game/judge/index.ts';
import { BenchmarkOverlay, benchmarkSurface } from './benchmarkOverlay.ts';
import { ResultSession, type ResultGame } from './resultSession.svelte.ts';
import { benchmarkText, goalText, isNewBest, lengthText, ruleValueText, signedPoints } from './resultText.ts';

// --- text ------------------------------------------------------------------------

describe('result text', () => {
  it('signed percentage points', () => {
    expect(signedPoints(0.0667)).toBe('+6.7 pt');
    expect(signedPoints(-0.01)).toBe('−1.0 pt');
    expect(signedPoints(0)).toBe('±0.0 pt');
    expect(signedPoints(-0.0001)).toBe('±0.0 pt');
    expect(signedPoints(Number.NaN)).toBe('—');
  });

  it('lengths in mm, tiny ones in µm', () => {
    expect(lengthText(1.2e-3)).toBe('1.20 mm');
    expect(lengthText(0)).toBe('0.00 mm');
    expect(lengthText(3.4e-5)).toBe('34.0 µm');
    expect(lengthText(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('rule values', () => {
    const r = (x: Partial<RuleVerdict> & Pick<RuleVerdict, 'id'>): RuleVerdict => ({
      label: '',
      status: 'pass',
      message: '',
      ...x,
    });
    expect(ruleValueText(r({ id: 'strength', value: 0.874 }))).toBe('最大利用率 87%');
    expect(ruleValueText(r({ id: 'strength', value: 1.2, caseName: '風' }))).toBe('最大利用率 120%(風)');
    expect(ruleValueText(r({ id: 'strength' }))).toBeNull();
    expect(ruleValueText(r({ id: 'stiffness', value: 1.2e-3, limit: 2e-3 }))).toBe('変位 1.20 mm / 上限 2.00 mm');
    expect(ruleValueText(r({ id: 'stiffness', limit: 2e-3 }))).toBe('上限 2.00 mm');
    expect(ruleValueText(r({ id: 'stiffness', status: 'na' }))).toBeNull();
    expect(ruleValueText(r({ id: 'keep', value: 3 }))).toBe('3 個');
    expect(ruleValueText(r({ id: 'connectivity' }))).toBeNull();
  });

  it('benchmark line and the beat badge (only for a passed design)', () => {
    const b = (relation: BenchmarkComparison['relation'], delta: number): BenchmarkComparison => ({
      volumeFraction: 0.4,
      solidCount: 12,
      delta,
      relation,
    });
    expect(benchmarkText(b('behind', 0.05), true)).toEqual({ text: '最適化解との差 +5.0 pt', badge: null });
    expect(benchmarkText(b('beaten', -0.02), true)).toEqual({ text: '最適化解との差 −2.0 pt', badge: 'アルゴリズム超え!' });
    expect(benchmarkText(b('beaten', -0.02), false).badge).toBeNull();
    expect(benchmarkText(b('tied', 0), true).text).toContain('同じ体積');
  });

  it('new best: more stars, or the same stars and lighter; never for a failed design', () => {
    const j = (passed: boolean, stars: 0 | 1 | 2 | 3, volumeFraction: number) =>
      ({ passed, stars, volumeFraction }) as Judgement;
    expect(isNewBest(null, j(true, 1, 0.6))).toBe(true);
    expect(isNewBest(null, j(false, 0, 0.3))).toBe(false);
    expect(isNewBest({ stars: 1, volumeFraction: 0.6 }, j(true, 2, 0.55))).toBe(true);
    expect(isNewBest({ stars: 2, volumeFraction: 0.5 }, j(true, 2, 0.49))).toBe(true);
    expect(isNewBest({ stars: 2, volumeFraction: 0.5 }, j(true, 2, 0.5))).toBe(false);
    expect(isNewBest({ stars: 3, volumeFraction: 0.4 }, j(true, 2, 0.3))).toBe(false);
  });

  it('goal line for star-less and failed designs', () => {
    const t = { star1: 0.7 };
    expect(goalText({ outcome: 'noStars' } as Judgement, t)).toBe('★の目標は体積率 70% 以下です');
    expect(goalText({ outcome: 'fail', volumeStars: 2 } as Judgement, t)).toBe('条件を満たせば ★★ の体積です');
    expect(goalText({ outcome: 'fail', volumeStars: 0 } as Judgement, t)).toBeNull();
    expect(goalText({ outcome: 'clear', volumeStars: 3 } as Judgement, t)).toBeNull();
  });
});

// --- overlay + session (Three objects without a renderer) ----------------------------

const NX = 10;
const NY = 3;
const N = NX * NY;
const idx = (x: number, y: number) => x + NX * y;

/** top row + support column: 12 cells */
function benchFlags(): Uint8Array {
  const s = new Uint8Array(N);
  for (let x = 0; x < NX; x++) s[idx(x, 2)] = 1;
  s[idx(0, 0)] = 1;
  s[idx(0, 1)] = 1;
  return s;
}

function plate(withBenchmark: boolean): Stage {
  return {
    ...buildDemoStage(),
    id: 'plate',
    grid: [NX, NY, 1],
    solid: encodeBitmask(new Uint8Array(N).fill(1)),
    keep: encodeBitmask(new Uint8Array(N)),
    loads: [{ cells: [[9, 2, 0]], force: [0, -500, 0] }],
    targets: { star1: 0.8, star2: 0.6, star3: 0.5 },
    ...(withBenchmark ? { benchmark: { volume: 12 / 30, solid: encodeBitmask(benchFlags()), method: 'simp-oc' } } : {}),
  };
}

function resultMsg(u: number): ResultMsg {
  return {
    type: 'result',
    seq: 4,
    converged: true,
    iterations: 1,
    relResidual: 0,
    elapsedMs: 0,
    cases: [
      { name: 'default', utilization: new Float32Array(N), displacement: new Float32Array(0), maxUtilization: u, loadDisplacement: 0 },
    ],
    floating: new Uint32Array(0),
    loadsConnected: true,
  };
}

function fakeGame(stage: Stage, solid: Uint8Array, u: number) {
  const domain = new THREE.Group();
  const voxels = { group: new THREE.Group() };
  const canvas = new EventTarget() as unknown as HTMLElement;
  let hovered = 0;
  const game: ResultGame = {
    controller: {
      state: { stage, solid, toBitmask: () => encodeBitmask(solid) },
      latestResult: resultMsg(u),
      hover: () => void hovered++,
    },
    scene: {
      domain,
      voxels,
      canvas,
      controls: { autoRotate: false, autoRotateSpeed: 2, getAzimuthalAngle: () => 0 },
    },
  };
  return { game, domain, voxels, hovered: () => hovered };
}

const openGate = { resultCurrent: true, converged: true, solving: false, error: null };
const overlayIn = (domain: THREE.Object3D) => domain.getObjectByName('benchmark-overlay');

describe('benchmark overlay', () => {
  it('meshes only the exposed faces of the benchmark solid', () => {
    const g = makeGrid([3, 1, 1]);
    expect(benchmarkSurface(g, Uint8Array.from([1, 0, 0])).quadCount).toBe(6);
    expect(benchmarkSurface(g, Uint8Array.from([1, 1, 0])).quadCount).toBe(10);
    expect(benchmarkSurface(g, Uint8Array.from([1, 0, 1])).quadCount).toBe(12);
    expect(benchmarkSurface(g, new Uint8Array(3)).quadCount).toBe(0);
  });

  it('modes: off hides it, only hides the player voxels, dispose restores everything', () => {
    const host = { domain: new THREE.Group(), voxels: { group: new THREE.Group() } };
    const o = new BenchmarkOverlay(host, makeGrid([NX, NY, 1]), benchFlags());
    expect(overlayIn(host.domain)?.visible).toBe(false);
    o.setMode('overlay');
    expect(o.group.visible).toBe(true);
    expect(host.voxels.group.visible).toBe(true);
    const mat = (o.group.getObjectByName('benchmark-surface') as THREE.Mesh).material as THREE.Material;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    o.setMode('only');
    expect(host.voxels.group.visible).toBe(false);
    expect(((o.group.getObjectByName('benchmark-surface') as THREE.Mesh).material as THREE.Material).transparent).toBe(false);
    o.dispose();
    expect(host.voxels.group.visible).toBe(true);
    expect(overlayIn(host.domain)).toBeUndefined();
  });
});

describe('ResultSession', () => {
  it('a passed submission fires onClear once and shows the benchmark overlay', () => {
    const stage = plate(true);
    const { game, domain, voxels, hovered } = fakeGame(stage, benchFlags(), 0.9);
    const session = new ResultSession();
    const clears: StageClear[] = [];
    session.onClear = (c) => clears.push(c);
    const s = session.open(game, openGate);
    expect(s?.judgement.passed).toBe(true);
    expect(session.submission).toBe(s);
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({ stageId: 'plate', stars: 3, beatsBenchmark: false });
    expect(hovered()).toBe(1); // brush preview cleared
    // no requestAnimationFrame in node → no camera turn → comparison shown right away
    expect(session.spinning).toBe(false);
    expect(session.hasBenchmark).toBe(true);
    expect(session.overlay).toBe('overlay');
    expect(overlayIn(domain)?.visible).toBe(true);

    session.setOverlay('only');
    expect(voxels.group.visible).toBe(false);
    session.setOverlay('off');
    expect(voxels.group.visible).toBe(true);
    expect(overlayIn(domain)?.visible).toBe(false);

    session.close();
    expect(session.submission).toBeNull();
    expect(session.overlay).toBe('off');
    expect(overlayIn(domain)).toBeUndefined();
    expect(clears).toHaveLength(1);
  });

  it('a failed submission opens the screen without a clear record or an automatic overlay', () => {
    const { game, domain } = fakeGame(plate(true), benchFlags(), 1.4);
    const session = new ResultSession();
    let clears = 0;
    session.onClear = () => clears++;
    const s = session.open(game, openGate);
    expect(s?.judgement.passed).toBe(false);
    expect(clears).toBe(0);
    expect(session.overlay).toBe('off');
    expect(session.hasBenchmark).toBe(true);
    session.setOverlay('overlay');
    expect(overlayIn(domain)?.visible).toBe(true);
    session.dispose();
    expect(overlayIn(domain)).toBeUndefined();
  });

  it('without a benchmark the overlay cannot be turned on', () => {
    const { game, domain } = fakeGame(plate(false), benchFlags(), 0.9);
    const session = new ResultSession();
    session.open(game, openGate);
    expect(session.hasBenchmark).toBe(false);
    expect(session.submission?.judgement.benchmark).toBeNull();
    session.setOverlay('overlay');
    expect(session.overlay).toBe('off');
    expect(overlayIn(domain)).toBeUndefined();
  });

  it('does nothing while the submit gate is closed', () => {
    const { game, domain } = fakeGame(plate(true), benchFlags(), 0.9);
    const session = new ResultSession();
    let clears = 0;
    session.onClear = () => clears++;
    expect(session.open(game, { ...openGate, converged: false })).toBeNull();
    expect(session.open(game, { ...openGate, resultCurrent: false })).toBeNull();
    expect(session.submission).toBeNull();
    expect(clears).toBe(0);
    expect(overlayIn(domain)).toBeUndefined();
  });

  it('reopening replaces the previous overlay instead of stacking them', () => {
    const { game, domain } = fakeGame(plate(true), benchFlags(), 0.9);
    const session = new ResultSession();
    session.open(game, openGate);
    session.open(game, openGate);
    expect(domain.children.filter((c) => c.name === 'benchmark-overlay')).toHaveLength(1);
  });
});

// the judge used by the session is the real one
it('session judgement equals judge() on the same inputs', () => {
  const stage = plate(true);
  const { game } = fakeGame(stage, benchFlags(), 0.9);
  const s = new ResultSession().open(game, openGate);
  expect(s?.judgement).toEqual(judge(stage, benchFlags(), resultMsg(0.9)));
});
