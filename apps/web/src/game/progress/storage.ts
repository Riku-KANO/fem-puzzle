// Versioned, failure-tolerant key/value persistence (design doc 公開形態: 記録はブラウザ内に保存).
//
// Every stored value is a JSON envelope `{ "v": <schema version>, "data": ... }`. Reading never
// throws: unavailable storage, corrupt JSON, invalid shapes and unknown versions all degrade to
// "no saved data" with a status the caller can show. Pure TS (storage is injected) so the
// edge cases are unit-testable in node.

/** The subset of the Web Storage API we use (so tests and fallbacks can stand in). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory stand-in: progress still works for the session when storage is unavailable. */
export class MemoryStore implements KeyValueStore {
  readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Key prefix shared by everything this app stores. */
export const STORAGE_PREFIX = 'stress-carve:';

const PROBE_KEY = `${STORAGE_PREFIX}probe`;

/**
 * `localStorage` if it exists and accepts a write, else null. Covers disabled cookies
 * (SecurityError on access), sandboxed iframes, Safari private mode (quota 0) and node.
 */
export function browserStorage(scope: unknown = globalThis): KeyValueStore | null {
  try {
    const s = (scope as { localStorage?: KeyValueStore | null }).localStorage;
    if (!s) return null;
    s.setItem(PROBE_KEY, '1');
    s.removeItem(PROBE_KEY);
    return s;
  } catch {
    return null;
  }
}

/**
 * How a load went.
 * - `empty`: nothing stored (or storage unavailable)
 * - `ok`: current version, valid
 * - `migrated`: older version upgraded in memory (written back on the next save)
 * - `corrupt`: unparsable, invalid, or an older version with no migration path; the raw
 *   value was copied to `<key>:corrupt` and the value reset
 * - `newer`: written by a newer build; ignored and protected from being overwritten
 */
export type LoadStatus = 'empty' | 'ok' | 'migrated' | 'corrupt' | 'newer';

export interface Loaded<T> {
  value: T | null;
  status: LoadStatus;
}

export interface VersionedSpec<T> {
  key: string;
  /** current schema version (positive integer) */
  version: number;
  /** Validate/normalise `data` of the current version; null = unusable. */
  parse(data: unknown): T | null;
  /** `migrations[v]` upgrades data of version `v` to `v + 1`. */
  migrations?: Readonly<Record<number, (data: unknown) => unknown>>;
}

/** Suffix of the key that receives an unreadable value before it is reset. */
export const CORRUPT_SUFFIX = ':corrupt';

/**
 * One versioned JSON value under one key. `storage` null = unavailable: loads are empty and
 * saves report false. Writes that throw (quota, private mode) also report false.
 */
export class VersionedValue<T> {
  /** set after loading a value from a newer build: saving would destroy it */
  private readOnly = false;

  constructor(
    private readonly storage: KeyValueStore | null,
    readonly spec: VersionedSpec<T>,
  ) {}

  load(): Loaded<T> {
    this.readOnly = false;
    const raw = safeGet(this.storage, this.spec.key);
    if (raw === null) return { value: null, status: 'empty' };
    const decoded = decodeEnvelope(raw);
    if (!decoded) return this.corrupt(raw);
    let { v, data } = decoded;
    if (v > this.spec.version) {
      this.readOnly = true;
      return { value: null, status: 'newer' };
    }
    const migrated = v < this.spec.version;
    while (v < this.spec.version) {
      const step = this.spec.migrations?.[v];
      if (!step) return this.corrupt(raw);
      try {
        data = step(data);
      } catch {
        return this.corrupt(raw);
      }
      v++;
    }
    const value = safeParse(this.spec, data);
    if (value === null) return this.corrupt(raw);
    return { value, status: migrated ? 'migrated' : 'ok' };
  }

  /** Persist `value` as the current version. False if not persisted. */
  save(value: T): boolean {
    if (this.readOnly) return false;
    return safeSet(this.storage, this.spec.key, JSON.stringify({ v: this.spec.version, data: value }));
  }

  /** Delete the stored value (no-op when it came from a newer build). */
  remove(): boolean {
    if (this.readOnly) return false;
    return safeRemove(this.storage, this.spec.key);
  }

  private corrupt(raw: string): Loaded<T> {
    // Keep the bytes for a human to recover; best effort (may itself exceed the quota).
    safeSet(this.storage, this.spec.key + CORRUPT_SUFFIX, raw);
    safeRemove(this.storage, this.spec.key);
    return { value: null, status: 'corrupt' };
  }
}

function decodeEnvelope(raw: string): { v: number; data: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const env = parsed as { v?: unknown; data?: unknown };
  if (typeof env.v !== 'number' || !Number.isInteger(env.v) || env.v < 0) return null;
  if (!('data' in env)) return null;
  return { v: env.v, data: env.data };
}

function safeParse<T>(spec: VersionedSpec<T>, data: unknown): T | null {
  try {
    return spec.parse(data);
  } catch {
    return null;
  }
}

function safeGet(storage: KeyValueStore | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: KeyValueStore | null, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(storage: KeyValueStore | null, key: string): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// --- small validators for `parse` implementations ----------------------------

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function finiteIn(x: unknown, min: number, max: number): number | null {
  return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : null;
}
