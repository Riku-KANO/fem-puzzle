// The player's working state for one stage: which voxels are solid, the undo history and
// the derived volume fraction. Pure (no DOM / Three / worker), so judge (T-301), progress
// (T-304) and tests can use it directly.

import {
  decodeBitmask,
  effectiveKeep,
  elementCount,
  encodeBitmask,
  type Bitmask,
  type Stage,
} from '@stress-carve/protocol';
import { countSet, makeGrid, type Grid } from './grid.ts';
import { History } from './history.ts';

/** One undoable action: a drag (or click) plus any debris it caused. */
export interface CarveEntry {
  /** cells the player removed */
  carved: number[];
  /** cells the solver reported floating afterwards (removed as debris, T-307) */
  floating: number[];
}

/** Net change of the solid set, in protocol terms (`carve` message). */
export interface SolidDiff {
  removed: number[];
  restored: number[];
}

export class CarveState {
  readonly stage: Stage;
  readonly grid: Grid;
  /** 1 = material present (current) */
  readonly solid: Uint8Array;
  /** 1 = protected: keep ∪ support cells ∪ load cells */
  readonly keep: Uint8Array;
  /** 1 = obstacle */
  readonly block: Uint8Array;
  /** solid count of the stage as authored (denominator of the volume fraction) */
  readonly initialCount: number;
  readonly history = new History<CarveEntry>();

  private count: number;
  private stroke: CarveEntry | null = null;
  private strokeSet = new Set<number>();

  constructor(stage: Stage) {
    this.stage = stage;
    this.grid = makeGrid(stage.grid);
    const n = elementCount(stage.grid);
    this.solid = decodeBitmask(stage.solid, n);
    this.keep = effectiveKeep(stage);
    this.block = stage.block ? decodeBitmask(stage.block, n) : new Uint8Array(n);
    this.initialCount = countSet(this.solid);
    this.count = this.initialCount;
  }

  get solidCount(): number {
    return this.count;
  }

  /** remaining / initial solid count (design doc スコア: lower is better) */
  get volumeFraction(): number {
    return this.initialCount > 0 ? this.count / this.initialCount : 0;
  }

  get strokeActive(): boolean {
    return this.stroke !== null;
  }

  /** Cells removed so far by the open stroke (brush uses it to avoid drilling). */
  get strokeRemoved(): ReadonlySet<number> {
    return this.strokeSet;
  }

  get canUndo(): boolean {
    return this.history.canUndo || (this.stroke !== null && this.stroke.carved.length > 0);
  }

  get canRedo(): boolean {
    return this.stroke === null && this.history.canRedo;
  }

  beginStroke(): void {
    if (this.stroke) this.endStroke();
    this.stroke = { carved: [], floating: [] };
    this.strokeSet.clear();
  }

  /**
   * Remove `cells` (ignores non-solid and protected ones). Opens a stroke if none is open.
   * Returns the cells actually removed.
   */
  carve(cells: readonly number[]): number[] {
    if (!this.stroke) this.beginStroke();
    const stroke = this.stroke!;
    const removed: number[] = [];
    for (const e of cells) {
      if (!this.solid[e] || this.keep[e]) continue;
      this.solid[e] = 0;
      removed.push(e);
      stroke.carved.push(e);
      this.strokeSet.add(e);
    }
    this.count -= removed.length;
    return removed;
  }

  /** Close the open stroke; returns the committed entry, or null if it removed nothing. */
  endStroke(): CarveEntry | null {
    const stroke = this.stroke;
    this.stroke = null;
    this.strokeSet.clear();
    if (!stroke || stroke.carved.length + stroke.floating.length === 0) return null;
    this.history.push(stroke);
    return stroke;
  }

  /**
   * Remove solver-reported floating cells. They are recorded with the open stroke, else with
   * the newest history entry (so undoing that action brings them back), else — before any
   * action, i.e. a stage authored with loose material — dropped without history.
   * Never touches the redo stack. Returns the cells actually removed.
   */
  removeFloating(cells: ArrayLike<number>): number[] {
    const removed: number[] = [];
    for (let i = 0; i < cells.length; i++) {
      const e = cells[i]!;
      if (!this.solid[e]) continue;
      this.solid[e] = 0;
      removed.push(e);
    }
    this.count -= removed.length;
    const entry = this.stroke ?? this.history.peek();
    if (entry) entry.floating.push(...removed);
    return removed;
  }

  undo(): SolidDiff | null {
    this.endStroke();
    const entry = this.history.undo();
    if (!entry) return null;
    return { removed: [], restored: this.restore(entry) };
  }

  redo(): SolidDiff | null {
    this.endStroke();
    const entry = this.history.redo();
    if (!entry) return null;
    return { removed: this.reapply(entry), restored: [] };
  }

  /**
   * Revert `entry` if it is the newest action, without making it redoable — used when the
   * second click of a double-click turns out to have been a camera gesture.
   */
  discard(entry: CarveEntry): SolidDiff | null {
    this.endStroke();
    if (this.history.peek() !== entry) return null;
    this.history.discardTop();
    return { removed: [], restored: this.restore(entry) };
  }

  toBitmask(): Bitmask {
    return encodeBitmask(this.solid);
  }

  private restore(entry: CarveEntry): number[] {
    const restored: number[] = [];
    for (const list of [entry.carved, entry.floating]) {
      for (const e of list) {
        if (this.solid[e]) continue;
        this.solid[e] = 1;
        restored.push(e);
      }
    }
    this.count += restored.length;
    return restored;
  }

  private reapply(entry: CarveEntry): number[] {
    const removed: number[] = [];
    for (const list of [entry.carved, entry.floating]) {
      for (const e of list) {
        if (!this.solid[e]) continue;
        this.solid[e] = 0;
        removed.push(e);
      }
    }
    this.count -= removed.length;
    return removed;
  }
}
