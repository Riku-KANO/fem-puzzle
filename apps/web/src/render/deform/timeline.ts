// Load-test choreography (design doc 演出): the load jig slowly descends, the deflection ramps
// up to the exaggerated scale; when anything is over-stressed cracks appear and flash, then the
// over-stressed elements break off in order of utilisation and the debris settles; finally
// the part springs back and the jig lifts off. Pure function of elapsed time, so frame drops
// never desynchronise the show and the phases are unit-tested.
//
// prefers-reduced-motion: no movement at all — a single static frame (contact, full
// deformation, cracks, broken elements removed) held until the player ends the test.

export type LoadTestPhase = 'descend' | 'load' | 'hold' | 'crack' | 'break' | 'settle' | 'release' | 'done' | 'static';

export interface TimelinePlan {
  /** number of elements that will break off */
  breaks: number;
  reducedMotion: boolean;
}

export interface TimelineFrame {
  phase: LoadTestPhase;
  /** load jig travel: 0 = lifted clear, 1 = touching the part */
  jig: number;
  /** fraction of the target deformation scale */
  deform: number;
  /** crack decal growth 0..1 */
  crack: number;
  /** extra over-stress flash 0..1 */
  flash: number;
  /** elements broken off so far (0..plan.breaks) */
  broken: number;
  /** debris opacity (fades out while releasing) */
  debris: number;
  /** the show is over: restore the normal view */
  done: boolean;
}

/** Phase lengths in seconds. */
export const DURATION = {
  descend: 0.8,
  load: 1.6,
  hold: 1.0,
  crack: 1.0,
  settle: 1.8,
  release: 1.0,
} as const;

/** Breaking takes longer with more elements, capped so big failures stay snappy. */
export function breakDuration(breaks: number): number {
  return breaks > 0 ? Math.min(2.2, 0.5 + 0.025 * breaks) : 0;
}

/** Total length of the animated show (Infinity for the held reduced-motion frame). */
export function timelineDuration(plan: TimelinePlan): number {
  if (plan.reducedMotion) return Infinity;
  const d = DURATION;
  if (plan.breaks === 0) return d.descend + d.load + d.hold + d.release;
  return d.descend + d.load + d.crack + breakDuration(plan.breaks) + d.settle + d.release;
}

export const easeInOut = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

/** Flash envelope during the crack phase: 3 pulses, fading in and out. */
function flashAt(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return Math.sin(x * Math.PI) * (0.5 - 0.5 * Math.cos(x * 6 * Math.PI));
}

export function timelineAt(plan: TimelinePlan, t: number): TimelineFrame {
  const n = Math.max(0, Math.floor(plan.breaks));
  if (plan.reducedMotion) {
    return { phase: 'static', jig: 1, deform: 1, crack: n > 0 ? 1 : 0, flash: 0, broken: n, debris: 0, done: false };
  }
  const d = DURATION;
  const f: TimelineFrame = { phase: 'descend', jig: 0, deform: 0, crack: 0, flash: 0, broken: 0, debris: 1, done: false };
  let s = Math.max(0, t);

  f.jig = easeInOut(s / d.descend);
  if (s < d.descend) return f;
  s -= d.descend;

  f.phase = 'load';
  f.deform = easeInOut(s / d.load);
  if (s < d.load) return f;
  s -= d.load;

  if (n === 0) {
    f.phase = 'hold';
    if (s < d.hold) return f;
    s -= d.hold;
  } else {
    f.phase = 'crack';
    f.crack = easeInOut(s / d.crack);
    f.flash = flashAt(s / d.crack);
    if (s < d.crack) return f;
    s -= d.crack;
    f.flash = 0;

    const tb = breakDuration(n);
    f.phase = 'break';
    // first element breaks immediately, the last one at the end of the phase
    f.broken = Math.min(n, 1 + Math.floor((s / tb) * n));
    if (s < tb) return f;
    s -= tb;
    f.broken = n;

    f.phase = 'settle';
    if (s < d.settle) return f;
    s -= d.settle;
  }

  f.phase = 'release';
  const r = easeInOut(s / d.release);
  f.deform = 1 - r;
  f.jig = 1 - r;
  f.debris = 1 - r;
  if (s < d.release) return f;

  return { ...f, phase: 'done', jig: 0, deform: 0, debris: 0, done: true };
}
