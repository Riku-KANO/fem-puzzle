import { describe, expect, it } from 'vitest';
import {
  browserStorage,
  CORRUPT_SUFFIX,
  MemoryStore,
  VersionedValue,
  type KeyValueStore,
  type VersionedSpec,
} from '../src/game/progress/storage.ts';

interface Doc {
  n: number;
}

const parseDoc = (d: unknown): Doc | null =>
  typeof d === 'object' && d !== null && typeof (d as Doc).n === 'number' ? { n: (d as Doc).n } : null;

const spec = (extra: Partial<VersionedSpec<Doc>> = {}): VersionedSpec<Doc> => ({
  key: 'test:doc',
  version: 1,
  parse: parseDoc,
  ...extra,
});

/** A store whose operations throw, like a browser with storage disabled or full. */
class ThrowingStore implements KeyValueStore {
  constructor(private readonly ops: { get?: boolean; set?: boolean; remove?: boolean }) {}
  readonly inner = new MemoryStore();
  getItem(key: string): string | null {
    if (this.ops.get) throw new DOMException('denied', 'SecurityError');
    return this.inner.getItem(key);
  }
  setItem(key: string, value: string): void {
    if (this.ops.set) throw new DOMException('full', 'QuotaExceededError');
    this.inner.setItem(key, value);
  }
  removeItem(key: string): void {
    if (this.ops.remove) throw new DOMException('denied', 'SecurityError');
    this.inner.removeItem(key);
  }
}

describe('browserStorage (availability probe)', () => {
  it('returns localStorage when it accepts writes and leaves no probe key behind', () => {
    const ls = new MemoryStore();
    expect(browserStorage({ localStorage: ls })).toBe(ls);
    expect(ls.map.size).toBe(0);
  });

  it('is null without localStorage (node, old browsers)', () => {
    expect(browserStorage({})).toBeNull();
    expect(browserStorage({ localStorage: null })).toBeNull();
  });

  it('is null when accessing localStorage throws (cookies blocked, sandboxed iframe)', () => {
    const scope = {
      get localStorage(): KeyValueStore {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(browserStorage(scope)).toBeNull();
  });

  it('is null when writes throw (Safari private mode quota 0)', () => {
    expect(browserStorage({ localStorage: new ThrowingStore({ set: true }) })).toBeNull();
  });
});

describe('VersionedValue', () => {
  it('saves a {v, data} envelope and loads it back', () => {
    const kv = new MemoryStore();
    const value = new VersionedValue(kv, spec());
    expect(value.load()).toEqual({ value: null, status: 'empty' });
    expect(value.save({ n: 7 })).toBe(true);
    expect(JSON.parse(kv.getItem('test:doc')!)).toEqual({ v: 1, data: { n: 7 } });
    expect(new VersionedValue(kv, spec()).load()).toEqual({ value: { n: 7 }, status: 'ok' });
    expect(value.remove()).toBe(true);
    expect(kv.getItem('test:doc')).toBeNull();
  });

  it.each([
    ['not JSON', '{"v":1,"data":'],
    ['JSON but not an object', '[1,2]'],
    ['no version', '{"data":{"n":1}}'],
    ['non-integer version', '{"v":1.5,"data":{"n":1}}'],
    ['negative version', '{"v":-1,"data":{"n":1}}'],
    ['no data', '{"v":1}'],
    ['invalid data shape', '{"v":1,"data":{"n":"seven"}}'],
  ])('corrupt data (%s): reset, raw value backed up, writes allowed again', (_name, raw) => {
    const kv = new MemoryStore();
    kv.setItem('test:doc', raw);
    const value = new VersionedValue(kv, spec());
    expect(value.load()).toEqual({ value: null, status: 'corrupt' });
    expect(kv.getItem('test:doc')).toBeNull();
    expect(kv.getItem('test:doc' + CORRUPT_SUFFIX)).toBe(raw);
    expect(value.save({ n: 1 })).toBe(true);
    expect(value.load().status).toBe('ok');
  });

  it('a parse function that throws counts as corrupt, not as a crash', () => {
    const kv = new MemoryStore();
    kv.setItem('test:doc', '{"v":1,"data":{}}');
    const value = new VersionedValue(kv, spec({ parse: () => { throw new Error('boom'); } }));
    expect(value.load().status).toBe('corrupt');
  });

  it('runs migrations step by step from an older version', () => {
    const kv = new MemoryStore();
    kv.setItem('test:doc', JSON.stringify({ v: 1, data: { count: 2 } }));
    const steps: number[] = [];
    const v3 = spec({
      version: 3,
      migrations: {
        1: (d) => {
          steps.push(1);
          return { m: (d as { count: number }).count * 10 };
        },
        2: (d) => {
          steps.push(2);
          return { n: (d as { m: number }).m + 1 };
        },
      },
    });
    const value = new VersionedValue(kv, v3);
    expect(value.load()).toEqual({ value: { n: 21 }, status: 'migrated' });
    expect(steps).toEqual([1, 2]);
    // The upgrade is written back on the next save, in the current version.
    expect(value.save({ n: 21 })).toBe(true);
    expect(JSON.parse(kv.getItem('test:doc')!).v).toBe(3);
    expect(value.load().status).toBe('ok');
  });

  it('an older version without a migration path (or a failing one) is corrupt', () => {
    const kv = new MemoryStore();
    kv.setItem('test:doc', JSON.stringify({ v: 1, data: { n: 1 } }));
    expect(new VersionedValue(kv, spec({ version: 2 })).load().status).toBe('corrupt');
    kv.setItem('test:doc', JSON.stringify({ v: 1, data: { n: 1 } }));
    const failing = spec({ version: 2, migrations: { 1: () => { throw new Error('bad'); } } });
    expect(new VersionedValue(kv, failing).load().status).toBe('corrupt');
  });

  it('data from a newer build is ignored and never overwritten or deleted', () => {
    const kv = new MemoryStore();
    const raw = JSON.stringify({ v: 9, data: { future: true } });
    kv.setItem('test:doc', raw);
    const value = new VersionedValue(kv, spec());
    expect(value.load()).toEqual({ value: null, status: 'newer' });
    expect(value.save({ n: 1 })).toBe(false);
    expect(value.remove()).toBe(false);
    expect(kv.getItem('test:doc')).toBe(raw);
    expect(kv.getItem('test:doc' + CORRUPT_SUFFIX)).toBeNull();
  });

  it('unavailable storage: loads are empty and saves report false', () => {
    const value = new VersionedValue<Doc>(null, spec());
    expect(value.load()).toEqual({ value: null, status: 'empty' });
    expect(value.save({ n: 1 })).toBe(false);
    expect(value.remove()).toBe(false);
  });

  it('storage that throws on every call never throws out of the module', () => {
    const kv = new ThrowingStore({ get: true, set: true, remove: true });
    const value = new VersionedValue(kv, spec());
    expect(value.load()).toEqual({ value: null, status: 'empty' });
    expect(value.save({ n: 1 })).toBe(false);
    expect(value.remove()).toBe(false);
  });

  it('a full storage (quota) fails the save but keeps reads working', () => {
    const kv = new ThrowingStore({ set: true });
    kv.inner.setItem('test:doc', JSON.stringify({ v: 1, data: { n: 3 } }));
    const value = new VersionedValue(kv, spec());
    expect(value.load()).toEqual({ value: { n: 3 }, status: 'ok' });
    expect(value.save({ n: 4 })).toBe(false);
    expect(value.load().value).toEqual({ n: 3 });
  });
});
