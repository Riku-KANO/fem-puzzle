// Remembers that the player finished or skipped the tutorial (a per-browser convenience;
// campaign records are T-304's). Storage may be missing or throw (private mode, blocked
// site data): then the tutorial simply shows again.

export const TUTORIAL_SEEN_KEY = 'stress-carve:tutorial-seen:v1';

/** The subset of `Storage` used here (injectable for tests). */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function tutorialSeen(store: KeyValueStore | null = defaultStore()): boolean {
  try {
    return store?.getItem(TUTORIAL_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTutorialSeen(store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(TUTORIAL_SEEN_KEY, '1');
  } catch {
    // storage unavailable: nothing to remember
  }
}
