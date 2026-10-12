// Submission (design doc 1ステージの流れ step 5): the submit gate, judging the current design
// and the "clear" record handed to the progress store (T-304, `StageClear` agreed with it).

import type { Bitmask, ResultMsg, Stage } from '@stress-carve/protocol';
import { judge, JUDGE_MESSAGES, type Judgement, type Stars } from './judge.ts';

/** HUD fields the gate looks at (a subset of the controller's `HudModel`). */
export interface SubmitGateInput {
  /** the latest result has the newest seq and no diff is pending */
  resultCurrent: boolean;
  converged: boolean;
  solving: boolean;
  error: string | null;
}

export interface SubmitGate {
  enabled: boolean;
  /** why it is disabled (tooltip / hint), or what submitting does */
  reason: string;
  /** short text of a blocking problem, shown next to the button (null when just waiting) */
  problem: string | null;
}

export const SUBMIT_MESSAGES = {
  ready: '提出して判定する',
  solving: '解析中です。完了すると提出できます',
  waiting: '解析結果を待っています',
  error: '解析エラーのため提出できません',
  unstable: `${JUDGE_MESSAGES.unstable}。提出できません`,
} as const;

/** Submit is enabled only for a converged result describing exactly the current solid set. */
export function submitGate(h: SubmitGateInput): SubmitGate {
  if (h.error) return { enabled: false, reason: SUBMIT_MESSAGES.error, problem: '解析エラー' };
  if (h.solving) return { enabled: false, reason: SUBMIT_MESSAGES.solving, problem: null };
  if (!h.resultCurrent) return { enabled: false, reason: SUBMIT_MESSAGES.waiting, problem: null };
  if (!h.converged) return { enabled: false, reason: SUBMIT_MESSAGES.unstable, problem: JUDGE_MESSAGES.unstable };
  return { enabled: true, reason: SUBMIT_MESSAGES.ready, problem: null };
}

/** Record of a passed submission (T-304 stores best stars / volume / design per stage). */
export interface StageClear {
  stageId: string;
  /** 0 = judge passed but volume > targets.star1 */
  stars: Stars;
  /** solid count / initial solid count at submit */
  volumeFraction: number;
  /** false when the stage has no benchmark */
  beatsBenchmark: boolean;
  /** submitted design (stage bitmask format) */
  solid: Bitmask;
}

export interface Submission {
  judgement: Judgement;
  /** set only when the judgement passed — fire it to the progress store exactly once */
  clear: StageClear | null;
  /** the submitted design as a bitmask */
  solid: Bitmask;
  /** seq of the judged result */
  seq: number;
}

/** What `submit` needs from the game (structurally the `GameController`). */
export interface SubmitSource {
  readonly state: {
    readonly stage: Stage;
    readonly solid: Uint8Array;
    toBitmask(): Bitmask;
  };
  readonly latestResult: ResultMsg | null;
}

/** Judge the current design if the gate is open; null otherwise. */
export function submit(src: SubmitSource, gate: SubmitGateInput): Submission | null {
  const result = src.latestResult;
  if (!result || !submitGate(gate).enabled) return null;
  const stage = src.state.stage;
  const judgement = judge(stage, src.state.solid, result);
  const solid = src.state.toBitmask();
  const clear: StageClear | null = judgement.passed
    ? {
        stageId: stage.id,
        stars: judgement.stars,
        volumeFraction: judgement.volumeFraction,
        beatsBenchmark: judgement.beatsBenchmark,
        solid,
      }
    : null;
  return { judgement, clear, solid, seq: result.seq };
}
