// Campaign structure and progressive unlock (design doc ゲームモード: キャンペーン W1〜W5).
//
// Rules (pure, derived from the records every time — nothing about unlocks is stored):
// - Worlds are played in ascending order; stages inside a world in catalogue order (id).
// - The first stage of an unlocked world is open; every further stage opens when the one
//   before it is cleared (≥ 1 star).
// - World w+1 opens once `ceil(WORLD_UNLOCK_RATIO × stages)` stages of world w are cleared,
//   so one stubborn stage near the end of a world does not block the campaign.
// - World 0 (sandbox / daily / the built-in demo) is not part of the campaign: always open.
// Deep links (`#/stage/<id>`) open any stage; locks only gate the select screen.

import { isCleared, type StageRecord, type Stars } from './records.ts';

export const WORLD_UNLOCK_RATIO = 0.75;

/** Display names (design doc ステージ設計 table). */
export const WORLD_NAMES: Readonly<Record<number, string>> = {
  0: 'その他',
  1: '工房入門',
  2: '橋',
  3: '立体',
  4: '嵐',
  5: '合金',
};

export function worldName(world: number): string {
  return WORLD_NAMES[world] ?? `ワールド ${world}`;
}

/** What the campaign needs to know about a stage. */
export interface StageRef {
  id: string;
  world: number;
}

export interface StageStatus {
  id: string;
  world: number;
  /** 1-based position inside its world */
  number: number;
  unlocked: boolean;
  cleared: boolean;
  stars: Stars;
  record: StageRecord | null;
}

export interface WorldStatus {
  world: number;
  name: string;
  unlocked: boolean;
  stages: StageStatus[];
  cleared: number;
  /** cleared stages needed to open the next world */
  needed: number;
  /** sum of best stars / 3 × stage count */
  stars: number;
  maxStars: number;
}

export interface Campaign {
  worlds: WorldStatus[];
  /** stage id → status */
  byId: Map<string, StageStatus>;
}

/** Stages required in world `count`-sized world to open the next one. */
export function clearsToUnlockNext(count: number): number {
  return Math.ceil(count * WORLD_UNLOCK_RATIO);
}

/**
 * Unlock state of every stage. `stages` must be in play order (the catalogue sorts by world,
 * then id); `record` looks up the stored best of a stage.
 */
export function buildCampaign(
  stages: readonly StageRef[],
  record: (id: string) => StageRecord | null,
): Campaign {
  const byWorld = new Map<number, StageRef[]>();
  for (const s of stages) {
    const list = byWorld.get(s.world) ?? [];
    list.push(s);
    byWorld.set(s.world, list);
  }
  const worldIds = [...byWorld.keys()].sort((a, b) => a - b);

  const worlds: WorldStatus[] = [];
  const byId = new Map<string, StageStatus>();
  // The first campaign world is always open; world 0 is outside the chain.
  let previousOpensNext = true;
  for (const world of worldIds) {
    const refs = byWorld.get(world) ?? [];
    const worldUnlocked: boolean = world <= 0 || previousOpensNext;
    const statuses: StageStatus[] = [];
    let prevCleared = true;
    for (const [i, ref] of refs.entries()) {
      const rec = record(ref.id);
      const cleared = isCleared(rec);
      const status: StageStatus = {
        id: ref.id,
        world,
        number: i + 1,
        unlocked: world <= 0 || (worldUnlocked && prevCleared),
        cleared,
        stars: rec?.stars ?? 0,
        record: rec,
      };
      prevCleared = cleared;
      statuses.push(status);
      byId.set(ref.id, status);
    }
    const cleared = statuses.filter((s) => s.cleared).length;
    const needed = clearsToUnlockNext(statuses.length);
    worlds.push({
      world,
      name: worldName(world),
      unlocked: worldUnlocked,
      stages: statuses,
      cleared,
      needed,
      stars: statuses.reduce((sum, s) => sum + s.stars, 0),
      maxStars: 3 * statuses.length,
    });
    if (world > 0) previousOpensNext = worldUnlocked && cleared >= needed;
  }
  return { worlds, byId };
}

/** The stage after `id` in play order (crossing into the next world), or null at the end. */
export function nextStageId(stages: readonly StageRef[], id: string): string | null {
  const i = stages.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const next = stages[i + 1];
  return next && next.world > 0 ? next.id : null;
}

/** The stage after `id` if the campaign has it unlocked, else null (→ stage select). */
export function nextUnlockedStageId(campaign: Campaign, stages: readonly StageRef[], id: string): string | null {
  const next = nextStageId(stages, id);
  return next !== null && campaign.byId.get(next)?.unlocked ? next : null;
}

/**
 * Where つづきから should go: the first unlocked, uncleared campaign stage at or after the
 * last opened one, else the first unlocked uncleared stage anywhere, else the last opened
 * stage, else the first stage.
 */
export function continueStageId(campaign: Campaign, lastStage: string | null): string | null {
  const all = campaign.worlds.flatMap((w) => (w.world > 0 ? w.stages : []));
  const pending = (s: StageStatus): boolean => s.unlocked && !s.cleared;
  const lastIndex = lastStage === null ? -1 : all.findIndex((s) => s.id === lastStage);
  const after = lastIndex >= 0 ? all.slice(lastIndex).find(pending) : undefined;
  const target = after ?? all.find(pending) ?? (lastIndex >= 0 ? all[lastIndex] : all[0]);
  return target?.id ?? null;
}
