// What the title / select screens show, read from the progress store in one go. Pure, so the
// "leave a stage → the select screen sees its carve" ordering is unit-testable (T-315).

import {
  buildCampaign,
  continueStageId,
  type Campaign,
  type ProgressHealth,
  type ProgressStore,
} from '../../game/progress/index.ts';
import type { StageCatalogue } from '../../game/stages.ts';

export interface StageInfo {
  title: string;
  grid: readonly [number, number, number];
  /** volume fraction of the saved in-progress carve, null = none */
  inProgress: number | null;
}

export interface MenuSnapshot {
  campaign: Campaign;
  info: ReadonlyMap<string, StageInfo>;
  /** stage つづきから / はじめる opens */
  continueId: string | null;
  /** nothing played yet */
  fresh: boolean;
  health: ProgressHealth;
}

export function menuSnapshot(catalogue: StageCatalogue, progress: ProgressStore): MenuSnapshot {
  const refs = catalogue.stages.map((e) => ({ id: e.stage.id, world: e.stage.world }));
  const campaign = buildCampaign(refs, (id) => progress.record(id));
  const info = new Map<string, StageInfo>(
    catalogue.stages.map((e) => [
      e.stage.id,
      { title: e.stage.title, grid: e.stage.grid, inProgress: progress.loadCarve(e.stage.id)?.volume ?? null },
    ]),
  );
  return {
    campaign,
    info,
    continueId: continueStageId(campaign, progress.lastStage),
    fresh: progress.lastStage === null && Object.keys(progress.records()).length === 0,
    health: progress.health,
  };
}
