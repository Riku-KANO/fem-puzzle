// W1 tutorial (design doc リスク: 応力表示の難しさ → W1をチュートリアル化): a short
// step-by-step guide for the first stage. Pure state machine — the overlay component feeds
// it HUD snapshots and renders the current step.

import type { Targets } from '@stress-carve/protocol';

/** Stage that runs the step-by-step tutorial. */
export const TUTORIAL_STAGE_ID = 'w1-01';

/** What the tutorial watches (one snapshot per HUD change). */
export interface TutorialSignals {
  solidCount: number;
  volumeFraction: number;
  /** judged max utilisation of the latest result (null before the first one) */
  maxUtilization: number | null;
  /** the latest result describes the current solid set and nothing is being solved */
  settled: boolean;
  /** load-test animations started so far (T-302); undefined while not wired */
  loadTestRuns?: number;
  /** the result screen is open (T-301); undefined while not wired */
  resultOpen?: boolean;
}

export type StepId = 'intro' | 'colors' | 'carve' | 'watch' | 'loadTest' | 'goal' | 'submit';

/** Values a step text may show. */
export interface StepContext {
  targets: Targets;
  /** max utilisation when the tutorial started (first result), null if unknown */
  startUtilization: number | null;
  signals: TutorialSignals;
}

export interface TutorialStep {
  id: StepId;
  title: string;
  /** paragraphs */
  body: (ctx: StepContext) => string[];
  /** glow low-stress cells in the 3D view while this step is shown */
  highlight: boolean;
  /**
   * Auto-advance: `entry` is the snapshot taken when the step was entered.
   * Steps without it advance only with the 「次へ」 button.
   */
  done?: (now: TutorialSignals, entry: TutorialSignals, targets: Targets) => boolean;
}

/** Volume fraction the "watch the colours change" step asks for. */
export const WATCH_VOLUME = 0.85;

const pct = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);

export const STEPS: readonly TutorialStep[] = [
  {
    id: 'intro',
    title: 'ようこそ、工房へ',
    body: () => [
      '左の壁に固定されたはりの先に、下向きの荷重(矢印)がかかっています。',
      '壊れないぎりぎりまで削って、できるだけ軽い形を彫り出そう。',
    ],
    highlight: false,
  },
  {
    id: 'colors',
    title: '色は応力の大きさ',
    body: (c) => [
      '色は「利用率」= 応力 ÷ 許容応力。青は 0% でほとんど働いていない場所、赤は 100% で限界の場所。限界を超えるとマゼンタで点滅します。',
      `右の「最大利用率」は、いちばん赤い場所の値です(いまは ${pct(c.signals.maxUtilization)})。`,
    ],
    highlight: false,
  },
  {
    id: 'carve',
    title: '青いところを削ろう',
    body: () => [
      '白く光っているのは利用率が低く、削っても安全な場所。',
      '左クリックかドラッグで削ってみよう。1〜3 キーでブラシの大きさを変えられます。',
    ],
    highlight: true,
    done: (now, entry) => now.solidCount < entry.solidCount,
  },
  {
    id: 'watch',
    title: '色の変化を見よう',
    body: (c) => [
      '削るたびに解析が走り、力の流れが組み変わって色が変わります。',
      `最大利用率: はじめ ${pct(c.startUtilization)} → いま ${pct(c.signals.maxUtilization)}`,
      `体積率 ${pct(WATCH_VOLUME)} まで削ってみよう。まちがえたら右クリックか Ctrl+Z で戻せます。`,
    ],
    highlight: true,
    done: (now) => now.settled && now.volumeFraction <= WATCH_VOLUME + 1e-9,
  },
  {
    id: 'loadTest',
    title: '載荷テスト',
    body: () => [
      'スペースキー(または「載荷テスト」ボタン)で荷重をかけ、たわみを大げさにして見てみよう。',
      '利用率が 100% を超えた場所があると、そこから崩れます。どこが弱いかの手がかりです。',
    ],
    highlight: false,
    done: (now, entry) =>
      now.loadTestRuns !== undefined && entry.loadTestRuns !== undefined && now.loadTestRuns > entry.loadTestRuns,
  },
  {
    id: 'goal',
    title: '星をめざそう',
    body: (c) => [
      `左上のメーターの印が星の目標。体積率 ${pct(c.targets.star1)} 以下で ★、${pct(c.targets.star2)} 以下で ★★、${pct(c.targets.star3)} 以下で ★★★。`,
      '最大利用率が 100% を超えないように、青いところから削り進めよう。',
    ],
    highlight: true,
    done: (now, _entry, targets) =>
      now.settled &&
      now.volumeFraction <= targets.star1 + 1e-9 &&
      now.maxUtilization !== null &&
      now.maxUtilization <= 1,
  },
  {
    id: 'submit',
    title: '提出しよう',
    body: () => [
      '条件を満たしたら「提出」。最適化アルゴリズムの答えと比べられます。',
      'アルゴリズムより軽く作れたら特別な印がつきます。',
    ],
    highlight: false,
    done: (now) => now.resultOpen === true,
  },
];

/** Where the tutorial is: a step index, or finished (closed). */
export interface TutorialState {
  /** index into STEPS; STEPS.length = finished */
  step: number;
  /** signals when the current step was entered */
  entry: TutorialSignals;
  /** max utilisation of the first result seen */
  startUtilization: number | null;
}

export function startTutorial(signals: TutorialSignals): TutorialState {
  return { step: 0, entry: { ...signals }, startUtilization: signals.maxUtilization };
}

export function isFinished(s: TutorialState): boolean {
  return s.step >= STEPS.length;
}

export function currentStep(s: TutorialState): TutorialStep | null {
  return STEPS[s.step] ?? null;
}

/** Move to the next step (「次へ」, or a completed step). */
export function advance(s: TutorialState, signals: TutorialSignals): TutorialState {
  return {
    step: Math.min(STEPS.length, s.step + 1),
    entry: { ...signals },
    startUtilization: s.startUtilization ?? signals.maxUtilization,
  };
}

/**
 * Feed a new snapshot: records the first utilisation and advances past every step whose
 * goal is met (one step per call, so each step is visible at least once).
 * Returns the same object when nothing changed.
 */
export function observe(s: TutorialState, signals: TutorialSignals, targets: Targets): TutorialState {
  let next = s;
  if (next.startUtilization === null && signals.maxUtilization !== null) {
    next = { ...next, startUtilization: signals.maxUtilization };
  }
  const step = currentStep(next);
  if (step?.done?.(signals, next.entry, targets)) return advance(next, signals);
  // The load-test counter is per game session (T-302): it appears late when not wired at
  // step entry, and drops to 0 when the stage is restarted. Either way it becomes the new
  // baseline instead of counting as progress.
  const runs = signals.loadTestRuns;
  const base = next.entry.loadTestRuns;
  if (step && runs !== undefined && (base === undefined || runs < base)) {
    next = { ...next, entry: { ...next.entry, loadTestRuns: runs } };
  }
  return next;
}
