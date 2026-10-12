import { describe, expect, it } from 'vitest';
import { cellIndex, makeGrid } from '../../game/grid.ts';
import { detachedComponents, floatingMask } from './collapse.ts';
import { breakDuration, DURATION, timelineAt, timelineDuration, type TimelinePlan } from './timeline.ts';

const sample = (plan: TimelinePlan, dt = 1 / 60) => {
  const frames = [];
  const end = timelineDuration(plan);
  for (let t = 0; t <= end + 0.1; t += dt) frames.push(timelineAt(plan, t));
  return frames;
};

describe('load test timeline', () => {
  it('within limits: descend, load to full scale, hold, release, done', () => {
    const plan = { breaks: 0, reducedMotion: false };
    const end = timelineDuration(plan);
    const t0 = DURATION.lift + DURATION.descend;
    expect(end).toBeCloseTo(t0 + DURATION.load + DURATION.hold + DURATION.release, 9);
    // starts from the resting contact (no jump), backs off, comes down
    const f0 = timelineAt(plan, 0);
    expect(f0).toMatchObject({ phase: 'lift', jig: 1, deform: 0, broken: 0, done: false });
    expect(timelineAt(plan, DURATION.lift)).toMatchObject({ phase: 'descend', jig: 0 });
    const contact = timelineAt(plan, t0);
    expect(contact.jig).toBe(1);
    expect(contact.deform).toBe(0); // the load only ramps once the jig touches
    const full = timelineAt(plan, t0 + DURATION.load + 0.01);
    expect(full).toMatchObject({ phase: 'hold', deform: 1, crack: 0, broken: 0 });
    const done = timelineAt(plan, end + 0.001);
    // ends resting on the part (the jig's idle pose), so restoring the view never jumps
    expect(done).toMatchObject({ phase: 'done', deform: 0, jig: 1, done: true });
    // never cracks or flashes
    for (const f of sample(plan)) {
      expect(f.crack).toBe(0);
      expect(f.flash).toBe(0);
    }
  });

  it('over-stressed: cracks and flashes, then breaks every element in order, then releases', () => {
    const plan = { breaks: 40, reducedMotion: false };
    const end = timelineDuration(plan);
    expect(end).toBeCloseTo(
      DURATION.lift +
        DURATION.descend +
        DURATION.load +
        DURATION.crack +
        breakDuration(40) +
        DURATION.settle +
        DURATION.release,
      9,
    );
    const frames = sample(plan);
    const phases = [...new Set(frames.map((f) => f.phase))];
    expect(phases).toEqual(['lift', 'descend', 'load', 'crack', 'break', 'settle', 'release', 'done']);
    let lastBroken = 0;
    for (const f of frames) {
      expect(f.broken).toBeGreaterThanOrEqual(lastBroken); // monotone
      lastBroken = f.broken;
      expect(f.deform).toBeGreaterThanOrEqual(0);
      expect(f.deform).toBeLessThanOrEqual(1);
      if (['lift', 'descend', 'load', 'crack'].includes(f.phase)) expect(f.broken).toBe(0);
      if (f.phase !== 'crack') expect(f.flash).toBe(0);
    }
    expect(Math.max(...frames.map((f) => f.flash))).toBeGreaterThan(0.5);
    const settle = frames.find((f) => f.phase === 'settle')!;
    expect(settle).toMatchObject({ broken: 40, crack: 1, deform: 1 });
    expect(frames.at(-1)).toMatchObject({ phase: 'done', done: true, broken: 40 });
    // the first element breaks right at the start of the break phase
    const tBreak = DURATION.lift + DURATION.descend + DURATION.load + DURATION.crack;
    expect(timelineAt(plan, tBreak + 1e-6).broken).toBe(1);
    expect(timelineAt(plan, tBreak + breakDuration(40) - 1e-6).broken).toBe(40);
  });

  it('break phase length grows with the element count but stays capped', () => {
    expect(breakDuration(0)).toBe(0);
    expect(breakDuration(1)).toBeLessThan(breakDuration(30));
    expect(breakDuration(10_000)).toBe(2.2);
  });

  it('reduced motion: one static frame with everything applied, held until ended', () => {
    const plan = { breaks: 7, reducedMotion: true };
    expect(timelineDuration(plan)).toBe(Infinity);
    for (const t of [0, 0.5, 3, 100]) {
      expect(timelineAt(plan, t)).toEqual({
        phase: 'static',
        jig: 1,
        deform: 1,
        crack: 1,
        flash: 0,
        broken: 7,
        debris: 0,
        done: false,
      });
    }
    expect(timelineAt({ breaks: 0, reducedMotion: true }, 1).crack).toBe(0);
  });
});

describe('collapse', () => {
  // 7×1×1 bar: supported at x = 0; cell 0 supported
  const g = makeGrid([7, 1, 1]);
  const supported = new Uint8Array(g.n);
  supported[0] = 1;

  it('cutting the bar detaches everything beyond the cut as one piece', () => {
    const flags = new Uint8Array(g.n).fill(1);
    const before = floatingMask(g, flags, supported);
    expect([...before]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    flags[3] = 0;
    expect(detachedComponents(g, flags, supported, before)).toEqual([[4, 5, 6]]);
    flags[5] = 0;
    expect(detachedComponents(g, flags, supported, before)).toEqual([[4], [6]]);
  });

  it('pieces that floated before the test are not collapse', () => {
    const flags = new Uint8Array(g.n).fill(1);
    flags[2] = 0; // island 3..6 was already floating (e.g. a protected load island)
    const before = floatingMask(g, flags, supported);
    expect(detachedComponents(g, flags, supported, before)).toEqual([]);
    flags[1] = 0;
    // cell 1 broke: nothing new floats (0 is supported, 3..6 floated already)
    expect(detachedComponents(g, flags, supported, before)).toEqual([]);
  });

  it('works across all three axes', () => {
    const c = makeGrid([3, 3, 3]);
    const flags = new Uint8Array(c.n).fill(1);
    const sup = new Uint8Array(c.n);
    sup[cellIndex(c, 1, 0, 1)] = 1;
    const before = floatingMask(c, flags, sup);
    // remove the whole y = 1 layer: the y = 2 layer drops as one piece
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) flags[cellIndex(c, x, 1, z)] = 0;
    const comps = detachedComponents(c, flags, sup, before);
    expect(comps).toHaveLength(1);
    expect(comps[0]).toHaveLength(9);
    expect(comps[0]!.every((e) => Math.floor(e / 3) % 3 === 2)).toBe(true);
  });
});
