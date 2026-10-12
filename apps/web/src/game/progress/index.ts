// Campaign progress (T-304): local records, unlocks, resumable carves. Public surface.

export {
  buildCampaign,
  clearsToUnlockNext,
  continueStageId,
  nextStageId,
  nextUnlockedStageId,
  worldName,
  WORLD_NAMES,
  WORLD_UNLOCK_RATIO,
  type Campaign,
  type StageRef,
  type StageStatus,
  type WorldStatus,
} from './campaign.ts';
export {
  isCleared,
  ProgressStore,
  type ClearOutcome,
  type ProgressHealth,
  type SavedCarve,
  type StageClear,
  type StageRecord,
  type Stars,
} from './records.ts';
export {
  applyResume,
  browserRunnerEnv,
  resumeCells,
  StageRunner,
  type ProgressSession,
  type ResumeStatus,
  type RunnerEnv,
} from './session.ts';
export { browserStorage, MemoryStore, type KeyValueStore } from './storage.ts';

import { ProgressStore } from './records.ts';
import { browserStorage } from './storage.ts';

/** The app's store: `localStorage` when usable, else session-only memory. */
export function createProgressStore(scope: unknown = globalThis): ProgressStore {
  return new ProgressStore(browserStorage(scope));
}
