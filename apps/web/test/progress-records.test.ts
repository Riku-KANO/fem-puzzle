import { describe, expect, it } from 'vitest';
import {
  CARVE_KEY_PREFIX,
  isCleared,
  PROGRESS_KEY,
  PROGRESS_VERSION,
  ProgressStore,
  type StageClear,
} from '../src/game/progress/records.ts';
import { CORRUPT_SUFFIX, MemoryStore, type KeyValueStore } from '../src/game/progress/storage.ts';

const clear = (over: Partial<StageClear> = {}): StageClear => ({
  stageId: 'w1-01',
  stars: 2,
  volumeFraction: 0.5,
  beatsBenchmark: false,
  solid: 'AAAA',
  ...over,
});

function clock(start = 1_000): () => number {
  let t = start;
  return () => (t += 10);
}

describe('ProgressStore records', () => {
  it('records a first clear and persists it in the versioned envelope', () => {
    const kv = new MemoryStore();
    const store = new ProgressStore(kv, clock());
    const out = store.recordClear(clear());
    expect(out).toMatchObject({ previous: null, firstClear: true, newBestStars: true, newBestVolume: false, persisted: true });
    expect(out.record).toEqual({
      stars: 2,
      volume: 0.5,
      beatBenchmark: false,
      clears: 1,
      firstAt: 1010,
      lastAt: 1010,
      solid: 'AAAA',
    });
    const raw = JSON.parse(kv.getItem(PROGRESS_KEY)!);
    expect(raw.v).toBe(PROGRESS_VERSION);
    expect(raw.data.records['w1-01']).toEqual(out.record);
    // A new store (page reload) sees the same record.
    expect(new ProgressStore(kv).record('w1-01')).toEqual(out.record);
    expect(new ProgressStore(kv).health).toEqual({ persistent: true, status: 'ok' });
  });

  it('keeps the best of each field across clears', () => {
    const store = new ProgressStore(new MemoryStore(), clock());
    store.recordClear(clear({ stars: 2, volumeFraction: 0.5, solid: 'BEST', beatsBenchmark: true }));
    const worse = store.recordClear(clear({ stars: 1, volumeFraction: 0.62, solid: 'WORSE' }));
    expect(worse.record).toMatchObject({ stars: 2, volume: 0.5, solid: 'BEST', beatBenchmark: true, clears: 2 });
    expect(worse).toMatchObject({ firstClear: false, newBestVolume: false, newBestStars: false });
    const better = store.recordClear(clear({ stars: 3, volumeFraction: 0.41, solid: 'NEW' }));
    expect(better.record).toMatchObject({ stars: 3, volume: 0.41, solid: 'NEW', beatBenchmark: true, clears: 3 });
    expect(better).toMatchObject({ newBestVolume: true, newBestStars: true });
    expect(better.record.firstAt).toBeLessThan(better.record.lastAt);
  });

  it('a 0-star pass is recorded but does not count as cleared', () => {
    const store = new ProgressStore(new MemoryStore());
    const out = store.recordClear(clear({ stars: 0, volumeFraction: 0.8 }));
    expect(out.record.stars).toBe(0);
    expect(out.firstClear).toBe(false);
    expect(isCleared(store.record('w1-01'))).toBe(false);
    expect(store.recordClear(clear({ stars: 1, volumeFraction: 0.69 })).firstClear).toBe(true);
    expect(isCleared(null)).toBe(false);
  });

  it('sanitises out-of-range clear events', () => {
    const store = new ProgressStore(new MemoryStore());
    const out = store.recordClear(clear({ stars: 7 as 3, volumeFraction: Number.NaN }));
    expect(out.record.stars).toBe(3);
    expect(out.record.volume).toBe(1);
  });

  it('remembers the last opened stage', () => {
    const kv = new MemoryStore();
    new ProgressStore(kv).setLastStage('w2-03');
    expect(new ProgressStore(kv).lastStage).toBe('w2-03');
  });

  it('corrupt progress data resets to empty, keeps a backup, and saving works again', () => {
    const kv = new MemoryStore();
    kv.setItem(PROGRESS_KEY, '{"v":1,"data":{"records":');
    const store = new ProgressStore(kv);
    expect(store.health).toEqual({ persistent: true, status: 'corrupt' });
    expect(store.records()).toEqual({});
    expect(kv.getItem(PROGRESS_KEY + CORRUPT_SUFFIX)).toBe('{"v":1,"data":{"records":');
    expect(store.recordClear(clear()).persisted).toBe(true);
    expect(new ProgressStore(kv).record('w1-01')?.stars).toBe(2);
  });

  it('drops individual invalid records but keeps the valid ones', () => {
    const kv = new MemoryStore();
    const good = { stars: 3, volume: 0.4, beatBenchmark: true, clears: 2, firstAt: 1, lastAt: 2, solid: 'AA==' };
    kv.setItem(
      PROGRESS_KEY,
      JSON.stringify({
        v: 1,
        data: {
          records: {
            good,
            badStars: { ...good, stars: 4 },
            badVolume: { ...good, volume: 1.5 },
            missing: { stars: 1 },
            notObject: 'x',
          },
          last: 42,
        },
      }),
    );
    const store = new ProgressStore(kv);
    expect(Object.keys(store.records())).toEqual(['good']);
    expect(store.lastStage).toBeNull();
    expect(store.health.status).toBe('ok');
  });

  it('works for the session when storage is unavailable', () => {
    const store = new ProgressStore(null);
    expect(store.health).toEqual({ persistent: false, status: 'empty' });
    expect(store.recordClear(clear()).record.stars).toBe(2);
    expect(store.record('w1-01')?.volume).toBe(0.5);
    store.saveCarve('w1-01', { solid: 'AA==', volume: 0.9, savedAt: 1 });
    expect(store.loadCarve('w1-01')?.volume).toBe(0.9);
  });

  it('survives a storage whose writes throw (quota exceeded)', () => {
    const kv: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {},
    };
    const store = new ProgressStore(kv);
    const out = store.recordClear(clear());
    expect(out.persisted).toBe(false);
    expect(store.record('w1-01')?.stars).toBe(2); // still known for this session
    expect(store.saveCarve('w1-01', { solid: 'AA==', volume: 0.9, savedAt: 1 })).toBe(false);
  });

  it('never overwrites progress written by a newer version', () => {
    const kv = new MemoryStore();
    const raw = JSON.stringify({ v: PROGRESS_VERSION + 1, data: { anything: true } });
    kv.setItem(PROGRESS_KEY, raw);
    const store = new ProgressStore(kv);
    expect(store.health.status).toBe('newer');
    const out = store.recordClear(clear());
    expect(out.persisted).toBe(false);
    expect(store.record('w1-01')).not.toBeNull();
    expect(kv.getItem(PROGRESS_KEY)).toBe(raw);
  });

  it('read-modify-write keeps records another tab saved meanwhile', () => {
    const kv = new MemoryStore();
    const tabA = new ProgressStore(kv);
    const tabB = new ProgressStore(kv);
    tabA.recordClear(clear({ stageId: 'w1-01', volumeFraction: 0.6 }));
    tabB.recordClear(clear({ stageId: 'w1-02' }));
    tabB.recordClear(clear({ stageId: 'w1-01', volumeFraction: 0.65 }));
    const fresh = new ProgressStore(kv);
    expect(Object.keys(fresh.records()).sort()).toEqual(['w1-01', 'w1-02']);
    expect(fresh.record('w1-01')?.volume).toBe(0.6);
  });
});

describe('ProgressStore carves', () => {
  it('saves, loads and clears the in-progress carve per stage', () => {
    const kv = new MemoryStore();
    const store = new ProgressStore(kv);
    expect(store.loadCarve('w1-01')).toBeNull();
    store.saveCarve('w1-01', { solid: 'AQ==', volume: 0.75, savedAt: 5 });
    expect(JSON.parse(kv.getItem(CARVE_KEY_PREFIX + 'w1-01')!)).toEqual({
      v: 1,
      data: { solid: 'AQ==', volume: 0.75, savedAt: 5 },
    });
    expect(new ProgressStore(kv).loadCarve('w1-01')).toEqual({ solid: 'AQ==', volume: 0.75, savedAt: 5 });
    expect(store.loadCarve('w1-02')).toBeNull();
    store.clearCarve('w1-01');
    expect(store.loadCarve('w1-01')).toBeNull();
  });

  it('invalid carve data loads as nothing', () => {
    const kv = new MemoryStore();
    kv.setItem(CARVE_KEY_PREFIX + 'w1-01', JSON.stringify({ v: 1, data: { solid: 3, volume: 0.5, savedAt: 1 } }));
    kv.setItem(CARVE_KEY_PREFIX + 'w1-02', 'garbage');
    const store = new ProgressStore(kv);
    expect(store.loadCarve('w1-01')).toBeNull();
    expect(store.loadCarve('w1-02')).toBeNull();
  });

  it('resetAll erases records and carves', () => {
    const kv = new MemoryStore();
    const store = new ProgressStore(kv);
    store.recordClear(clear());
    store.saveCarve('w1-01', { solid: 'AQ==', volume: 0.75, savedAt: 5 });
    store.resetAll(['w1-01']);
    expect(store.records()).toEqual({});
    expect(kv.map.size).toBe(0);
  });
});
