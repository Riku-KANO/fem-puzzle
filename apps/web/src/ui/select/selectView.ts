// Pure view helpers for the title / stage select screens (unit-tested; no DOM).

import type { Campaign, ProgressHealth, StageStatus, WorldStatus } from '../../game/progress/index.ts';
import { percent } from '../format.ts';

/** A message about persistence the player should see, or null. */
export function storageWarning(health: ProgressHealth): string | null {
  if (!health.persistent) return 'この環境では記録を保存できません。ページを閉じると進行状況は消えます。';
  if (health.status === 'corrupt') return '保存データが読み取れなかったため、記録をリセットしました。';
  if (health.status === 'newer') {
    return '新しいバージョンで保存された記録があります。このバージョンでは記録を上書きしません。';
  }
  return null;
}

/** World tab shown first: the requested one if it exists, else the newest unlocked world. */
export function initialWorld(campaign: Campaign, requested: number | null): number | null {
  const worlds = campaign.worlds;
  if (requested !== null && worlds.some((w) => w.world === requested)) return requested;
  const campaignWorlds = worlds.filter((w) => w.world > 0);
  const open = campaignWorlds.filter((w) => w.unlocked);
  return (open.at(-1) ?? campaignWorlds[0] ?? worlds[0])?.world ?? null;
}

/** "1-3" style stage number (world 0 has no prefix). */
export function stageLabel(s: Pick<StageStatus, 'world' | 'number'>): string {
  return s.world > 0 ? `${s.world}-${s.number}` : `${s.number}`;
}

export function starString(stars: number): string {
  return '★'.repeat(stars) + '☆'.repeat(Math.max(0, 3 - stars));
}

/** Short status line under a world's heading. */
export function worldSummary(w: WorldStatus, next: WorldStatus | undefined): string {
  if (!w.unlocked) return 'まだ解放されていません';
  const base = `クリア ${w.cleared} / ${w.stages.length}`;
  if (!next || next.world <= 0 || next.unlocked) return base;
  const left = Math.max(0, w.needed - w.cleared);
  return `${base} ・ あと ${left} ステージで ワールド${next.world} 解放`;
}

/** Why a locked world tab is locked. */
export function lockedWorldHint(prev: WorldStatus | undefined): string {
  if (!prev) return 'まだ解放されていません';
  return `ワールド${prev.world} を ${prev.needed} ステージクリアで解放`;
}

/** Accessible name for a stage card. */
export function cardAriaLabel(s: StageStatus, title: string, inProgress: number | null): string {
  const parts = [`${stageLabel(s)} ${title}`];
  if (!s.unlocked) parts.push('未解放');
  else if (s.record) parts.push(`星 ${s.stars}`, `最良 体積率 ${percent(s.record.volume, 1)}`);
  else parts.push('未クリア');
  if (s.record?.beatBenchmark) parts.push('最適化解超え');
  if (inProgress !== null && s.unlocked) parts.push(`途中 体積率 ${percent(inProgress, 1)}`);
  return parts.join('、');
}
