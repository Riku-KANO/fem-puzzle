// Coalesces solid-set changes between flushes (one `carve` message per animation frame at
// most), cancelling out cells that were removed and restored again before the flush.

import type { SolidDiff } from '../game/carveState.ts';

export class DiffBatcher {
  /** element → solid state the solver last saw, for cells touched since the last flush */
  private original = new Map<number, boolean>();
  /** element → current solid state */
  private current = new Map<number, boolean>();

  get pending(): boolean {
    for (const [e, s] of this.current) if (this.original.get(e) !== s) return true;
    return false;
  }

  add(diff: SolidDiff): void {
    for (const e of diff.removed) this.set(e, false);
    for (const e of diff.restored) this.set(e, true);
  }

  /** Net diff since the last take (sorted), or null if nothing changed. */
  take(): SolidDiff | null {
    const removed: number[] = [];
    const restored: number[] = [];
    for (const [e, s] of this.current) {
      if (this.original.get(e) === s) continue;
      (s ? restored : removed).push(e);
    }
    this.original.clear();
    this.current.clear();
    if (removed.length + restored.length === 0) return null;
    removed.sort((a, b) => a - b);
    restored.sort((a, b) => a - b);
    return { removed, restored };
  }

  clear(): void {
    this.original.clear();
    this.current.clear();
  }

  private set(e: number, solid: boolean): void {
    if (!this.original.has(e)) this.original.set(e, !solid);
    this.current.set(e, solid);
  }
}
