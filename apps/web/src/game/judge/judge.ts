// Judgement of a submitted design (design doc 判定条件 / スコア, stage-format.md "Derived
// rules", solver.md "stall ⇒ not converged ⇒ failed design"). Pure: a stage, the player's
// solid flags and the solver result for exactly that solid set in, a verdict out.
//
// Rules, in the order they are shown and reported:
//   connectivity — every load cell is connected (6-neighbour) to a supported cell
//                  (solver `loadsConnected`, cross-checked against the solid flags);
//   keep         — every protected cell (keep ∪ supported ∪ load cells) is still solid and
//                  still attached to a support (a floating protected part would fall off);
//   stability    — the solve converged; a mechanism / stalled CG is a failed design;
//   strength     — judged max utilisation ≤ 1 for every load case;
//   stiffness    — max load-point displacement ≤ `maxDisplacement` for every case (optional).
// Strength and stiffness are only evaluated on a connected, converged result — otherwise
// their numbers are meaningless (no load path, or no equilibrium) and they are `unknown`.

import {
  decodeBitmask,
  effectiveKeep,
  elementCount,
  elementIndex,
  stageCases,
  supportedCells,
  type ResultMsg,
  type Stage,
  type Targets,
} from '@stress-carve/protocol';
import { connectivity } from '../connectivity.ts';
import { countSet, makeGrid } from '../grid.ts';

export type RuleId = 'connectivity' | 'keep' | 'stability' | 'strength' | 'stiffness';

/** `na` = rule not used by this stage; `unknown` = could not be evaluated (counts as not passed). */
export type RuleStatus = 'pass' | 'fail' | 'unknown' | 'na';

export type Stars = 0 | 1 | 2 | 3;

export interface RuleVerdict {
  id: RuleId;
  /** rule name (Japanese UI text) */
  label: string;
  status: RuleStatus;
  /** one-line explanation (Japanese UI text) */
  message: string;
  /** measured value: utilisation (strength), displacement in m (stiffness), cell count (keep) */
  value?: number;
  /** the limit `value` is compared with */
  limit?: number;
  /** load case that decided `value` (only on multi-case stages) */
  caseName?: string;
}

export interface CaseVerdict {
  name: string;
  maxUtilization: number;
  /** m */
  loadDisplacement: number;
  strength: boolean;
  /** null when the stage has no stiffness rule */
  stiffness: boolean | null;
}

export type BenchmarkRelation = 'beaten' | 'tied' | 'behind';

export interface BenchmarkComparison {
  /** benchmark volume fraction (same denominator as the player's) */
  volumeFraction: number;
  /** benchmark solid count, null when its bitmask cannot be decoded */
  solidCount: number | null;
  /** player − benchmark volume fraction (negative = lighter than the optimiser) */
  delta: number;
  /** compared by solid count when the bitmask is available (exact), else by volume */
  relation: BenchmarkRelation;
  maxUtilization?: number;
  method?: string;
}

export type Outcome = 'clear' | 'noStars' | 'fail';

export interface Judgement {
  /** every rule is `pass` or `na` */
  passed: boolean;
  /** 'clear' = passed with ≥ 1 star; 'noStars' = passed but heavier than `targets.star1` */
  outcome: Outcome;
  /** stars earned (0 unless passed) */
  stars: Stars;
  /** stars the volume alone would earn (shown as the goal on a failed design) */
  volumeStars: Stars;
  volumeFraction: number;
  solidCount: number;
  initialCount: number;
  rules: RuleVerdict[];
  cases: CaseVerdict[];
  /** null when the stage has no benchmark */
  benchmark: BenchmarkComparison | null;
  /** passed and strictly lighter than the benchmark */
  beatsBenchmark: boolean;
  /** headline for the result screen: first failed rule's message, or the clear text */
  headline: string;
}

export const RULE_LABELS: Readonly<Record<RuleId, string>> = {
  connectivity: '連結',
  keep: '保護領域',
  stability: '安定',
  strength: '強度',
  stiffness: '剛性',
};

export const JUDGE_MESSAGES = {
  connected: 'すべての荷重点が支点につながっています',
  disconnected: '荷重点が支点につながっていません',
  keepIntact: '保護領域はすべて残っています',
  keepMissing: '保護領域が削られています',
  keepFloating: '保護領域が支点から切り離されています',
  stable: '解析が収束しました',
  unstable: '構造が安定していません',
  unstableDetail: '構造が安定していません(解析が収束しませんでした)',
  strengthOk: '全要素が許容応力以下です',
  strengthOver: '許容応力を超えている要素があります',
  stiffnessOk: '荷重点の変位が上限以下です',
  stiffnessOver: '荷重点の変位が上限を超えています',
  noStiffnessRule: 'このステージに剛性の条件はありません',
  noLoadPath: '荷重が支点に伝わっていないため判定できません',
  notSolved: '解析が収束していないため判定できません',
  noCases: '解析結果に荷重ケースがありません',
  clear: 'クリア!',
  noStars: '条件は満たしていますが、星の目標体積率に届いていません',
} as const;

/** Tolerance for comparing volume fractions with targets (same as the HUD meter). */
const VOLUME_EPS = 1e-9;

/** Stars a volume fraction earns against the stage targets (lower volume = more stars). */
export function starsFor(targets: Targets, volumeFraction: number): Stars {
  if (!Number.isFinite(volumeFraction)) return 0;
  if (volumeFraction <= targets.star3 + VOLUME_EPS) return 3;
  if (volumeFraction <= targets.star2 + VOLUME_EPS) return 2;
  if (volumeFraction <= targets.star1 + VOLUME_EPS) return 1;
  return 0;
}

/**
 * Judge `solid` (current per-element 0/1 flags) given `result`, the solver result for exactly
 * that solid set (the caller guarantees it is the newest one — see `submitGate`).
 */
export function judge(stage: Stage, solid: ArrayLike<number>, result: ResultMsg): Judgement {
  const n = elementCount(stage.grid);
  if (solid.length !== n) throw new Error(`solid has ${solid.length} flags, stage has ${n} elements`);
  const flags = Uint8Array.from(solid, (v) => (v ? 1 : 0));
  const initialCount = countSet(decodeBitmask(stage.solid, n));
  const solidCount = countSet(flags);
  const volumeFraction = initialCount > 0 ? solidCount / initialCount : Number.NaN;

  const topo = topology(stage, flags);
  const cases = caseVerdicts(stage, result);
  const multi = cases.length > 1;

  const connected = result.loadsConnected && topo.loadsConnected;
  const rules: RuleVerdict[] = [];
  rules.push(
    connected
      ? rule('connectivity', 'pass', JUDGE_MESSAGES.connected)
      : rule('connectivity', 'fail', JUDGE_MESSAGES.disconnected),
  );

  if (topo.keepMissing > 0) {
    rules.push({ ...rule('keep', 'fail', JUDGE_MESSAGES.keepMissing), value: topo.keepMissing });
  } else if (topo.keepFloating > 0) {
    rules.push({ ...rule('keep', 'fail', JUDGE_MESSAGES.keepFloating), value: topo.keepFloating });
  } else {
    rules.push(rule('keep', 'pass', JUDGE_MESSAGES.keepIntact));
  }

  // Stability is meaningless without a load path (a disconnected load gives a trivial solve).
  const stable = result.converged;
  if (!connected) rules.push(rule('stability', 'unknown', JUDGE_MESSAGES.noLoadPath));
  else rules.push(rule('stability', stable ? 'pass' : 'fail', stable ? JUDGE_MESSAGES.stable : JUDGE_MESSAGES.unstableDetail));

  const evaluable = connected && stable;
  const blocked = !connected ? JUDGE_MESSAGES.noLoadPath : JUDGE_MESSAGES.notSolved;

  // strength
  if (!evaluable) {
    rules.push(rule('strength', 'unknown', blocked));
  } else if (cases.length === 0) {
    rules.push(rule('strength', 'unknown', JUDGE_MESSAGES.noCases));
  } else {
    const worst = worstBy(cases, (c) => c.maxUtilization);
    const ok = cases.every((c) => c.strength);
    rules.push({
      ...rule('strength', ok ? 'pass' : 'fail', ok ? JUDGE_MESSAGES.strengthOk : JUDGE_MESSAGES.strengthOver),
      value: worst.maxUtilization,
      limit: 1,
      ...(multi ? { caseName: worst.name } : {}),
    });
  }

  // stiffness (optional)
  const limit = stage.maxDisplacement;
  if (limit === undefined) {
    rules.push(rule('stiffness', 'na', JUDGE_MESSAGES.noStiffnessRule));
  } else if (!evaluable) {
    rules.push({ ...rule('stiffness', 'unknown', blocked), limit });
  } else if (cases.length === 0) {
    rules.push({ ...rule('stiffness', 'unknown', JUDGE_MESSAGES.noCases), limit });
  } else {
    const worst = worstBy(cases, (c) => c.loadDisplacement);
    const ok = cases.every((c) => c.stiffness === true);
    rules.push({
      ...rule('stiffness', ok ? 'pass' : 'fail', ok ? JUDGE_MESSAGES.stiffnessOk : JUDGE_MESSAGES.stiffnessOver),
      value: worst.loadDisplacement,
      limit,
      ...(multi ? { caseName: worst.name } : {}),
    });
  }

  const passed = rules.every((r) => r.status === 'pass' || r.status === 'na');
  const volumeStars = starsFor(stage.targets, volumeFraction);
  const stars: Stars = passed ? volumeStars : 0;
  const outcome: Outcome = !passed ? 'fail' : stars > 0 ? 'clear' : 'noStars';
  const benchmark = compareBenchmark(stage, n, solidCount, initialCount, volumeFraction);
  const beatsBenchmark = passed && benchmark?.relation === 'beaten';
  const firstFailure = rules.find((r) => r.status === 'fail') ?? rules.find((r) => r.status === 'unknown');
  const headline =
    outcome === 'clear'
      ? JUDGE_MESSAGES.clear
      : outcome === 'noStars'
        ? JUDGE_MESSAGES.noStars
        : headlineFor(firstFailure);

  return {
    passed,
    outcome,
    stars,
    volumeStars,
    volumeFraction,
    solidCount,
    initialCount,
    rules,
    cases,
    benchmark,
    beatsBenchmark,
    headline,
  };
}

function rule(id: RuleId, status: RuleStatus, message: string): RuleVerdict {
  return { id, label: RULE_LABELS[id], status, message };
}

/** The short headline of a failed design: the stability failure gets the canonical wording. */
function headlineFor(r: RuleVerdict | undefined): string {
  if (!r) return JUDGE_MESSAGES.unstable;
  if (r.id === 'stability') return JUDGE_MESSAGES.unstable;
  return r.message;
}

function caseVerdicts(stage: Stage, result: ResultMsg): CaseVerdict[] {
  const limit = stage.maxDisplacement;
  const names = stageCases(stage).map((c) => c.name);
  return result.cases.map((c, i) => ({
    name: c.name || names[i] || `ケース${i + 1}`,
    maxUtilization: c.maxUtilization,
    loadDisplacement: c.loadDisplacement,
    // NaN compares false: a NaN result never passes
    strength: c.maxUtilization <= 1,
    stiffness: limit === undefined ? null : c.loadDisplacement <= limit,
  }));
}

/** The case with the largest `key`; NaN counts as the worst. */
function worstBy(cases: CaseVerdict[], key: (c: CaseVerdict) => number): CaseVerdict {
  let worst = cases[0]!;
  for (const c of cases) {
    const v = key(c);
    if (Number.isNaN(v)) return c;
    if (v > key(worst)) worst = c;
  }
  return worst;
}

interface Topology {
  /** every load cell (all cases) is solid and connected to a supported cell */
  loadsConnected: boolean;
  /** protected cells that are no longer solid */
  keepMissing: number;
  /** protected cells that are solid but not connected to a supported cell */
  keepFloating: number;
}

function topology(stage: Stage, solid: Uint8Array): Topology {
  const grid = makeGrid(stage.grid);
  const { active } = connectivity(grid, solid, supportedCells(stage));
  const keep = effectiveKeep(stage);
  let keepMissing = 0;
  let keepFloating = 0;
  for (let e = 0; e < keep.length; e++) {
    if (!keep[e]) continue;
    if (!solid[e]) keepMissing++;
    else if (!active[e]) keepFloating++;
  }
  let loadsConnected = true;
  for (const lc of stageCases(stage)) {
    for (const l of lc.loads) {
      for (const c of l.cells) if (!active[elementIndex(stage.grid, c[0], c[1], c[2])]) loadsConnected = false;
    }
  }
  return { loadsConnected, keepMissing, keepFloating };
}

function compareBenchmark(
  stage: Stage,
  n: number,
  solidCount: number,
  initialCount: number,
  volumeFraction: number,
): BenchmarkComparison | null {
  const b = stage.benchmark;
  if (!b) return null;
  let benchCount: number | null = null;
  try {
    benchCount = countSet(decodeBitmask(b.solid, n));
  } catch {
    benchCount = null;
  }
  const benchVolume = benchCount !== null && initialCount > 0 ? benchCount / initialCount : b.volume;
  let relation: BenchmarkRelation;
  if (benchCount !== null) {
    relation = solidCount < benchCount ? 'beaten' : solidCount === benchCount ? 'tied' : 'behind';
  } else {
    const d = volumeFraction - b.volume;
    relation = d < -VOLUME_EPS ? 'beaten' : d <= VOLUME_EPS ? 'tied' : 'behind';
  }
  return {
    volumeFraction: benchVolume,
    solidCount: benchCount,
    delta: volumeFraction - benchVolume,
    relation,
    ...(b.maxUtilization !== undefined ? { maxUtilization: b.maxUtilization } : {}),
    ...(b.method !== undefined ? { method: b.method } : {}),
  };
}
