import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeGrid } from '../../game/grid.ts';
import { HintGlow } from './glow.ts';
import { hintThreshold, lowStressCells } from './lowStress.ts';
import { markTutorialSeen, TUTORIAL_SEEN_KEY, tutorialSeen, type KeyValueStore } from './seen.ts';
import {
  advance,
  currentStep,
  isFinished,
  observe,
  startTutorial,
  STEPS,
  WATCH_VOLUME,
  type TutorialSignals,
  type TutorialState,
} from './steps.ts';

const targets = { star1: 0.6, star2: 0.45, star3: 0.35 };

const base: TutorialSignals = {
  solidCount: 768,
  volumeFraction: 1,
  maxUtilization: null,
  settled: false,
  loadTestRuns: 0,
  resultOpen: false,
};

function at(id: string, signals: TutorialSignals = base): TutorialState {
  let s = startTutorial(signals);
  while (currentStep(s)?.id !== id) {
    if (isFinished(s)) throw new Error(`no step ${id}`);
    s = advance(s, signals);
  }
  return s;
}

describe('tutorial steps', () => {
  it('starts at the intro and walks every step with 次へ', () => {
    let s = startTutorial(base);
    expect(currentStep(s)?.id).toBe('intro');
    const seen: string[] = [];
    while (!isFinished(s)) {
      seen.push(currentStep(s)!.id);
      s = advance(s, base);
    }
    expect(seen).toEqual(STEPS.map((x) => x.id));
    expect(currentStep(s)).toBeNull();
    expect(advance(s, base).step).toBe(STEPS.length);
  });

  it('every step has a title and text; manual steps wait for 次へ', () => {
    for (const step of STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      const body = step.body({ targets, startUtilization: 0.44, signals: { ...base, maxUtilization: 0.5 } });
      expect(body.length).toBeGreaterThan(0);
      expect(body.join('')).not.toContain('undefined');
    }
    const s = at('intro');
    expect(observe(s, { ...base, solidCount: 10, settled: true }, targets)).toBe(s);
  });

  it('records the first utilisation and shows it in the watch step', () => {
    let s = startTutorial(base);
    expect(s.startUtilization).toBeNull();
    s = observe(s, { ...base, maxUtilization: 0.44 }, targets);
    expect(s.startUtilization).toBe(0.44);
    s = observe(s, { ...base, maxUtilization: 0.6 }, targets);
    expect(s.startUtilization).toBe(0.44);
    const watch = STEPS.find((x) => x.id === 'watch')!;
    const text = watch
      .body({ targets, startUtilization: 0.44, signals: { ...base, maxUtilization: 0.61 } })
      .join(' ');
    expect(text).toContain('44%');
    expect(text).toContain('61%');
  });

  it('carve completes once a voxel is removed', () => {
    const s = at('carve');
    expect(observe(s, { ...base, settled: true }, targets)).toBe(s);
    const next = observe(s, { ...base, solidCount: 767 }, targets);
    expect(currentStep(next)?.id).toBe('watch');
    expect(next.entry.solidCount).toBe(767);
  });

  it('watch completes at the volume goal with a settled result', () => {
    const s = at('watch');
    const v = WATCH_VOLUME - 0.01;
    expect(currentStep(observe(s, { ...base, volumeFraction: v, settled: false }, targets))?.id).toBe('watch');
    expect(currentStep(observe(s, { ...base, volumeFraction: 0.9, settled: true }, targets))?.id).toBe('watch');
    expect(currentStep(observe(s, { ...base, volumeFraction: v, settled: true }, targets))?.id).toBe('loadTest');
  });

  it('load test completes when the run counter increases, not on a late-wired counter', () => {
    const s = at('loadTest', { ...base, loadTestRuns: 2 });
    expect(observe(s, { ...base, loadTestRuns: 2 }, targets)).toBe(s);
    expect(currentStep(observe(s, { ...base, loadTestRuns: 3 }, targets))?.id).toBe('goal');

    const unwired = at('loadTest', { ...base, loadTestRuns: undefined });
    const wired = observe(unwired, { ...base, loadTestRuns: 5 }, targets);
    expect(currentStep(wired)?.id).toBe('loadTest');
    expect(wired.entry.loadTestRuns).toBe(5);
    expect(currentStep(observe(wired, { ...base, loadTestRuns: 6 }, targets))?.id).toBe('goal');

    // restart: the per-session counter drops to 0 and becomes the new baseline
    const restarted = observe(s, { ...base, loadTestRuns: 0 }, targets);
    expect(currentStep(restarted)?.id).toBe('loadTest');
    expect(restarted.entry.loadTestRuns).toBe(0);
    expect(currentStep(observe(restarted, { ...base, loadTestRuns: 1 }, targets))?.id).toBe('goal');
  });

  it('goal needs ★1 volume, utilisation ≤ 100 % and a settled result', () => {
    const s = at('goal');
    const ok = { ...base, volumeFraction: 0.59, maxUtilization: 0.95, settled: true };
    expect(currentStep(observe(s, ok, targets))?.id).toBe('submit');
    expect(currentStep(observe(s, { ...ok, maxUtilization: 1.02 }, targets))?.id).toBe('goal');
    expect(currentStep(observe(s, { ...ok, volumeFraction: 0.61 }, targets))?.id).toBe('goal');
    expect(currentStep(observe(s, { ...ok, settled: false }, targets))?.id).toBe('goal');
  });

  it('submit finishes the tutorial when the result screen opens', () => {
    const s = at('submit');
    expect(observe(s, { ...base, resultOpen: false }, targets)).toBe(s);
    expect(isFinished(observe(s, { ...base, resultOpen: true }, targets))).toBe(true);
  });
});

describe('low-stress hint cells', () => {
  const g = makeGrid([3, 3, 3]);
  const centre = 1 + 3 * (1 + 3 * 1);

  it('threshold is 15 % or 35 % of the current maximum', () => {
    expect(hintThreshold(0.44)).toBe(0.15);
    expect(hintThreshold(0.2)).toBeCloseTo(0.07);
    expect(hintThreshold(0)).toBe(0);
    expect(hintThreshold(Number.NaN)).toBe(0);
  });

  it('only exposed, unprotected solid cells below the threshold', () => {
    const solid = new Uint8Array(g.n).fill(1);
    const keep = new Uint8Array(g.n);
    const u = new Float32Array(g.n).fill(0.05);
    keep[0] = 1;
    u[2] = 0.5;
    const cells = lowStressCells({ grid: g, solid, keep, utilization: u, threshold: 0.1 });
    expect(cells).not.toContain(centre); // buried
    expect(cells).not.toContain(0); // protected
    expect(cells).not.toContain(2); // busy
    expect(cells.length).toBe(27 - 3);

    solid[centre + 1] = 0; // carving a neighbour exposes the centre
    solid[5] = 0; // empty cells never glow
    const after = lowStressCells({ grid: g, solid, keep, utilization: u, threshold: 0.1 });
    expect(after).toContain(centre);
    expect(after).not.toContain(5);
  });
});

describe('tutorial seen flag', () => {
  it('round-trips through a store and survives a broken one', () => {
    const data = new Map<string, string>();
    const store: KeyValueStore = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
    };
    expect(tutorialSeen(store)).toBe(false);
    markTutorialSeen(store);
    expect(data.get(TUTORIAL_SEEN_KEY)).toBe('1');
    expect(tutorialSeen(store)).toBe(true);

    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(tutorialSeen(broken)).toBe(false);
    expect(() => markTutorialSeen(broken)).not.toThrow();
    expect(tutorialSeen(null)).toBe(false);
  });
});

describe('hint glow', () => {
  it('places one instance per cell centre and cleans up', () => {
    const g = makeGrid([4, 2, 2]);
    const parent = new THREE.Group();
    const glow = new HintGlow(parent, g, true);
    expect(parent.children).toContain(glow.mesh);
    glow.set([0, 4 + 1 + 4 * 2]); // (0,0,0) and (1,1,1)
    expect(glow.mesh.count).toBe(2);
    expect(glow.mesh.visible).toBe(true);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    glow.mesh.getMatrixAt(1, m);
    p.setFromMatrixPosition(m);
    expect(p.toArray()).toEqual([1.5, 1.5, 1.5]);
    glow.set([]);
    expect(glow.mesh.visible).toBe(false);
    glow.dispose();
    expect(parent.children).not.toContain(glow.mesh);
    glow.set([0]); // no-op after dispose
  });
});
