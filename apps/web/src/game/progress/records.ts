// Local campaign records: best result per stage, the in-progress carve per stage and the
// last opened stage. Everything lives in the browser (design doc 公開形態); see storage.ts
// for the versioned envelope and the failure handling.

import type { Bitmask } from '@stress-carve/protocol';
import {
  finiteIn,
  isRecord,
  MemoryStore,
  STORAGE_PREFIX,
  VersionedValue,
  type KeyValueStore,
  type LoadStatus,
} from './storage.ts';

/**
 * A passed submission, fired once per submit by the judge flow (T-301 defines the same shape
 * in `game/judge`; structural typing keeps the two modules independent).
 */
export interface StageClear {
  stageId: string;
  /** 0 = judge passed but the volume is above `targets.star1` */
  stars: 0 | 1 | 2 | 3;
  volumeFraction: number;
  /** false when the stage has no benchmark */
  beatsBenchmark: boolean;
  /** the submitted design */
  solid: Bitmask;
}

export type Stars = 0 | 1 | 2 | 3;

/** Best results of one stage. */
export interface StageRecord {
  /** most stars earned */
  stars: Stars;
  /** lowest volume fraction of a passed submission */
  volume: number;
  /** beat the optimiser at least once */
  beatBenchmark: boolean;
  /** number of passed submissions */
  clears: number;
  /** epoch ms of the first / latest passed submission */
  firstAt: number;
  lastAt: number;
  /** design of the lowest-volume submission */
  solid: Bitmask;
}

/** A stage counts as cleared (unlocks the next one) with at least one star. */
export function isCleared(record: StageRecord | null | undefined): boolean {
  return !!record && record.stars >= 1;
}

/** Saved carve of a stage in progress. */
export interface SavedCarve {
  solid: Bitmask;
  /** volume fraction at save time (display only; the bitmask is authoritative) */
  volume: number;
  savedAt: number;
}

interface ProgressDoc {
  records: Record<string, StageRecord>;
  /** last stage opened (title screen つづきから) */
  last: string | null;
}

export const PROGRESS_KEY = `${STORAGE_PREFIX}progress`;
export const CARVE_KEY_PREFIX = `${STORAGE_PREFIX}carve:`;
export const PROGRESS_VERSION = 1;
export const CARVE_VERSION = 1;

/** Outcome of `recordClear`, for "new best" badges. */
export interface ClearOutcome {
  previous: StageRecord | null;
  record: StageRecord;
  firstClear: boolean;
  newBestVolume: boolean;
  newBestStars: boolean;
  /** false when nothing could be persisted (kept for this session only) */
  persisted: boolean;
}

/** Persistence summary for the UI. */
export interface ProgressHealth {
  /** storage accepts writes */
  persistent: boolean;
  /** status of the last progress load (corrupt / newer are worth telling the player) */
  status: LoadStatus;
}

export class ProgressStore {
  /** false when storage is unavailable and everything lives in memory for this session */
  readonly persistent: boolean;
  private readonly storage: KeyValueStore;
  private readonly doc: VersionedValue<ProgressDoc>;
  private cache: ProgressDoc;
  private status: LoadStatus;

  /**
   * @param storage null when unavailable: records and carves then live in memory for this
   *   session (unlocks and resume still work until the page is closed).
   * @param now clock (epoch ms), injectable for tests
   */
  constructor(
    storage: KeyValueStore | null,
    private readonly now: () => number = Date.now,
  ) {
    this.persistent = storage !== null;
    this.storage = storage ?? new MemoryStore();
    this.doc = new VersionedValue(this.storage, {
      key: PROGRESS_KEY,
      version: PROGRESS_VERSION,
      parse: parseProgressDoc,
    });
    const loaded = this.doc.load();
    this.cache = loaded.value ?? emptyDoc();
    this.status = loaded.status;
  }

  get health(): ProgressHealth {
    return { persistent: this.persistent, status: this.status };
  }

  record(stageId: string): StageRecord | null {
    return this.cache.records[stageId] ?? null;
  }

  /** All records (a copy). */
  records(): Record<string, StageRecord> {
    return { ...this.cache.records };
  }

  get lastStage(): string | null {
    return this.cache.last;
  }

  /** Remember the stage the player opened last. */
  setLastStage(stageId: string): void {
    this.update((doc) => {
      doc.last = stageId;
    });
  }

  /** Merge a passed submission into the stage's record and persist it. */
  recordClear(clear: StageClear): ClearOutcome {
    const previous = this.record(clear.stageId);
    const t = this.now();
    const volume = finiteIn(clear.volumeFraction, 0, 1) ?? 1;
    const stars = clampStars(clear.stars);
    const better = !previous || volume < previous.volume;
    const record: StageRecord = {
      stars: Math.max(previous?.stars ?? 0, stars) as Stars,
      volume: better ? volume : previous.volume,
      beatBenchmark: (previous?.beatBenchmark ?? false) || clear.beatsBenchmark,
      clears: (previous?.clears ?? 0) + 1,
      firstAt: previous?.firstAt ?? t,
      lastAt: t,
      solid: better ? clear.solid : previous.solid,
    };
    const persisted = this.update((doc) => {
      doc.records[clear.stageId] = record;
    });
    return {
      previous,
      record,
      firstClear: !isCleared(previous) && isCleared(record),
      newBestVolume: previous !== null && volume < previous.volume,
      newBestStars: record.stars > (previous?.stars ?? 0),
      persisted,
    };
  }

  /** Saved in-progress carve of a stage, or null. */
  loadCarve(stageId: string): SavedCarve | null {
    return this.carveValue(stageId).load().value;
  }

  saveCarve(stageId: string, carve: SavedCarve): boolean {
    return this.carveValue(stageId).save(carve);
  }

  clearCarve(stageId: string): boolean {
    return this.carveValue(stageId).remove();
  }

  /** Erase all records and carves of the given stages (settings → 記録を消去). */
  resetAll(stageIds: readonly string[]): void {
    for (const id of stageIds) this.clearCarve(id);
    this.cache = emptyDoc();
    this.doc.remove();
  }

  /**
   * Read-modify-write: re-read the stored doc first so another tab's records are not lost,
   * then apply `mutate` to it and to the cache. Returns whether it was persisted.
   * Policy is "never lose a clear": records this page knows are merged back in, so records
   * deleted elsewhere while this page is open return on its next write (`resetAll` here
   * clears the cache too).
   */
  private update(mutate: (doc: ProgressDoc) => void): boolean {
    const fresh = this.doc.load();
    if (fresh.value) this.cache = mergeDocs(this.cache, fresh.value);
    if (fresh.status !== 'empty') this.status = fresh.status;
    mutate(this.cache);
    return this.doc.save(this.cache);
  }

  private carveValue(stageId: string): VersionedValue<SavedCarve> {
    return new VersionedValue(this.storage, {
      key: CARVE_KEY_PREFIX + stageId,
      version: CARVE_VERSION,
      parse: parseSavedCarve,
    });
  }
}

function emptyDoc(): ProgressDoc {
  return { records: {}, last: null };
}

/** Union of two docs, keeping the better result per stage (`a` wins `last`). */
function mergeDocs(a: ProgressDoc, b: ProgressDoc): ProgressDoc {
  const records: Record<string, StageRecord> = { ...b.records };
  for (const [id, ra] of Object.entries(a.records)) {
    const rb = records[id];
    records[id] = rb ? mergeRecords(ra, rb) : ra;
  }
  return { records, last: a.last ?? b.last };
}

function mergeRecords(a: StageRecord, b: StageRecord): StageRecord {
  const best = a.volume <= b.volume ? a : b;
  return {
    stars: Math.max(a.stars, b.stars) as Stars,
    volume: best.volume,
    beatBenchmark: a.beatBenchmark || b.beatBenchmark,
    clears: Math.max(a.clears, b.clears),
    firstAt: Math.min(a.firstAt, b.firstAt),
    lastAt: Math.max(a.lastAt, b.lastAt),
    solid: best.solid,
  };
}

function clampStars(x: unknown): Stars {
  return typeof x === 'number' && Number.isFinite(x) ? (Math.max(0, Math.min(3, Math.floor(x))) as Stars) : 0;
}

// --- parsing (stored data is untrusted: other builds, extensions, manual edits) ---------

function parseProgressDoc(data: unknown): ProgressDoc | null {
  if (!isRecord(data) || !isRecord(data.records)) return null;
  const records: Record<string, StageRecord> = {};
  // Invalid entries are dropped individually so one bad record does not cost all the others.
  for (const [id, raw] of Object.entries(data.records)) {
    const r = parseStageRecord(raw);
    if (r) records[id] = r;
  }
  const last = typeof data.last === 'string' ? data.last : null;
  return { records, last };
}

export function parseStageRecord(raw: unknown): StageRecord | null {
  if (!isRecord(raw)) return null;
  const stars = raw.stars;
  const volume = finiteIn(raw.volume, 0, 1);
  const clears = finiteIn(raw.clears, 0, Number.MAX_SAFE_INTEGER);
  const firstAt = finiteIn(raw.firstAt, 0, Number.MAX_SAFE_INTEGER);
  const lastAt = finiteIn(raw.lastAt, 0, Number.MAX_SAFE_INTEGER);
  if (stars !== 0 && stars !== 1 && stars !== 2 && stars !== 3) return null;
  if (volume === null || clears === null || firstAt === null || lastAt === null) return null;
  if (typeof raw.beatBenchmark !== 'boolean' || typeof raw.solid !== 'string') return null;
  return {
    stars,
    volume,
    beatBenchmark: raw.beatBenchmark,
    clears: Math.floor(clears),
    firstAt,
    lastAt,
    solid: raw.solid,
  };
}

function parseSavedCarve(raw: unknown): SavedCarve | null {
  if (!isRecord(raw) || typeof raw.solid !== 'string') return null;
  const volume = finiteIn(raw.volume, 0, 1);
  const savedAt = finiteIn(raw.savedAt, 0, Number.MAX_SAFE_INTEGER);
  if (volume === null || savedAt === null) return null;
  return { solid: raw.solid, volume, savedAt };
}
