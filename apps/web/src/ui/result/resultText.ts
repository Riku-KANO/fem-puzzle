// Text for the result screen (Japanese UI). Pure, unit-tested.

import type { BenchmarkComparison, Judgement, Outcome, RuleStatus, RuleVerdict } from '../../game/judge/index.ts';
import { percent } from '../format.ts';

export const OUTCOME_TITLES: Readonly<Record<Outcome, string>> = {
  clear: 'クリア',
  noStars: '合格(星なし)',
  fail: '不合格',
};

export const STATUS_ICONS: Readonly<Record<RuleStatus, string>> = {
  pass: '✓',
  fail: '✗',
  unknown: '?',
  na: '–',
};

export const STATUS_LABELS: Readonly<Record<RuleStatus, string>> = {
  pass: '合格',
  fail: '不合格',
  unknown: '判定できません',
  na: '対象外',
};

/** Volume-fraction difference in percentage points: "+6.7 pt", "−1.0 pt", "±0.0 pt". */
export function signedPoints(delta: number, digits = 1): string {
  if (!Number.isFinite(delta)) return '—';
  const v = Math.abs(delta * 100).toFixed(digits);
  if (Number(v) === 0) return `±${v} pt`;
  return `${delta > 0 ? '+' : '−'}${v} pt`;
}

/** A length in m shown in mm (or µm when tiny). */
export function lengthText(m: number): string {
  if (!Number.isFinite(m)) return '—';
  const mm = m * 1000;
  if (Math.abs(mm) >= 0.1 || mm === 0) return `${mm.toFixed(2)} mm`;
  return `${(mm * 1000).toFixed(1)} µm`;
}

/** The measured value of a rule, e.g. "最大利用率 87%" or "変位 1.20 mm / 上限 2.00 mm". */
export function ruleValueText(r: RuleVerdict): string | null {
  const where = r.caseName ? `(${r.caseName})` : '';
  switch (r.id) {
    case 'strength':
      return r.value === undefined ? null : `最大利用率 ${percent(r.value)}${where}`;
    case 'stiffness':
      if (r.limit === undefined) return null;
      return r.value === undefined
        ? `上限 ${lengthText(r.limit)}`
        : `変位 ${lengthText(r.value)} / 上限 ${lengthText(r.limit)}${where}`;
    case 'keep':
      return r.value === undefined ? null : `${r.value} 個`;
    default:
      return null;
  }
}

/** "最適化解との差" line and its tone. */
export function benchmarkText(b: BenchmarkComparison, passed: boolean): { text: string; badge: string | null } {
  const diff = `最適化解との差 ${signedPoints(b.delta)}`;
  if (b.relation === 'beaten') return { text: diff, badge: passed ? 'アルゴリズム超え!' : null };
  if (b.relation === 'tied') return { text: `${diff}(最適化解と同じ体積)`, badge: null };
  return { text: diff, badge: null };
}

export interface PreviousBest {
  stars: number;
  volumeFraction: number;
}

/** A passed submission that improves on the stored best (more stars, or same stars and lighter). */
export function isNewBest(prev: PreviousBest | null | undefined, j: Judgement): boolean {
  if (!j.passed) return false;
  if (!prev) return true;
  if (j.stars !== prev.stars) return j.stars > prev.stars;
  return j.volumeFraction < prev.volumeFraction - 1e-9;
}

/** Goal line for a failed / star-less design: which star the current volume would earn. */
export function goalText(j: Judgement, targets: { star1: number }): string | null {
  if (j.outcome === 'noStars') return `★の目標は体積率 ${percent(targets.star1)} 以下です`;
  if (j.outcome === 'fail' && j.volumeStars > 0) {
    return `条件を満たせば ${'★'.repeat(j.volumeStars)} の体積です`;
  }
  return null;
}
