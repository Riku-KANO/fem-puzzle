// Stage lifecycle with persistence: opens one game session per stage, resumes the saved
// in-progress carve, autosaves it while playing and on page hide, and saves before closing.
// The game itself is started by an injected factory (`startGame` in the app), so this module
// stays DOM/Three-free and unit-testable.

import { decodeBitmask, type Bitmask, type Stage } from '@stress-carve/protocol';
import type { CarveState } from '../carveState.ts';
import type { ProgressStore } from './records.ts';

/** The parts of `GameSession` (game/boot.ts) this module uses. */
export interface ProgressSession {
  controller: { state: CarveState };
  scene: { solidChanged(cells: readonly number[]): void };
  solver: { carve(removed: number[], restored: number[]): number };
  dispose(): void;
}

/**
 * Cells to remove so that `solid` (the stage's initial set) matches the saved bitmask.
 * Saved material outside the initial set is ignored (cannot be added) and protected cells
 * are never removed, so a stage file that changed since the save still loads sanely.
 * Null when the bitmask does not fit the grid.
 */
export function resumeCells(solid: Uint8Array, keep: Uint8Array, saved: Bitmask): number[] | null {
  let flags: Uint8Array;
  try {
    flags = decodeBitmask(saved, solid.length);
  } catch {
    return null;
  }
  const cells: number[] = [];
  for (let e = 0; e < solid.length; e++) {
    if (solid[e] && !keep[e] && !flags[e]) cells.push(e);
  }
  return cells;
}

/**
 * Apply a saved carve to a freshly started session: removes the cells from the carve state
 * without undo history (the resumed shape is the new baseline), rebuilds the view and sends
 * the diff to the solver. Returns the removed cells (null = saved data unusable).
 */
export function applyResume(session: ProgressSession, saved: Bitmask): number[] | null {
  const state = session.controller.state;
  const cells = resumeCells(state.solid, state.keep, saved);
  if (!cells) return null;
  if (cells.length === 0) return [];
  state.beginStroke();
  const removed = state.carve(cells);
  state.endStroke();
  state.history.clear();
  if (removed.length > 0) {
    session.scene.solidChanged(removed);
    session.solver.carve(removed, []);
  }
  return removed;
}

/** Timers and page-lifecycle hooks (window/document in the app, fakes or nothing in tests). */
export interface RunnerEnv {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
  /** subscribe to "the page may go away now" (pagehide / hidden); returns unsubscribe */
  onPageHide?(fn: () => void): () => void;
}

export const AUTOSAVE_INTERVAL_MS = 500;

/** What `open` reports about the resumed carve. */
export type ResumeStatus = 'fresh' | 'resumed' | 'invalid';

export class StageRunner<S extends ProgressSession> {
  session: S | null = null;
  stageId: string | null = null;
  resume: ResumeStatus = 'fresh';

  private stage: Stage | null = null;
  private lastSaved: Bitmask | null = null;
  private timer: unknown = null;
  private unsubscribePageHide: (() => void) | null = null;

  constructor(
    private readonly store: ProgressStore,
    private readonly start: (stage: Stage) => S,
    private readonly env: RunnerEnv,
  ) {}

  /** Start `stage` (closing any open one), resuming its saved carve. */
  open(stage: Stage): S {
    this.close();
    const session = this.start(stage);
    this.session = session;
    this.stage = stage;
    this.stageId = stage.id;
    this.resume = 'fresh';
    const saved = this.store.loadCarve(stage.id);
    if (saved) {
      const removed = applyResume(session, saved.solid);
      this.resume = removed === null ? 'invalid' : removed.length > 0 ? 'resumed' : 'fresh';
      if (removed === null) this.store.clearCarve(stage.id);
    }
    this.lastSaved = session.controller.state.toBitmask();
    this.store.setLastStage(stage.id);
    this.timer = this.env.setInterval(() => this.save(), AUTOSAVE_INTERVAL_MS);
    this.unsubscribePageHide = this.env.onPageHide?.(() => this.save()) ?? null;
    return session;
  }

  /**
   * Persist the current carve if it changed since the last save. A carve identical to the
   * stage as authored deletes the saved entry. Returns whether anything was written.
   */
  save(): boolean {
    const session = this.session;
    const id = this.stageId;
    if (!session || id === null) return false;
    const state = session.controller.state;
    const mask = state.toBitmask();
    if (mask === this.lastSaved) return false;
    this.lastSaved = mask;
    if (state.solidCount === state.initialCount) {
      this.store.clearCarve(id);
    } else {
      this.store.saveCarve(id, { solid: mask, volume: state.volumeFraction, savedAt: this.env.now() });
    }
    return true;
  }

  /** Save and dispose the open session. */
  close(): void {
    if (!this.session) return;
    this.save();
    this.detach();
  }

  /** Throw away the carve of the open stage and start it again from the authored block. */
  restart(): S | null {
    const stage = this.stage;
    if (!stage) return null;
    this.detach();
    this.store.clearCarve(stage.id);
    return this.open(stage);
  }

  private detach(): void {
    if (this.timer !== null) this.env.clearInterval(this.timer);
    this.timer = null;
    this.unsubscribePageHide?.();
    this.unsubscribePageHide = null;
    this.session?.dispose();
    this.session = null;
    this.stage = null;
    this.stageId = null;
    this.lastSaved = null;
  }
}

/** Browser `RunnerEnv`: real timers, pagehide + visibilitychange(hidden). */
export function browserRunnerEnv(win: Window): RunnerEnv {
  return {
    setInterval: (fn, ms) => win.setInterval(fn, ms),
    clearInterval: (h) => win.clearInterval(h as number),
    now: () => Date.now(),
    onPageHide(fn) {
      const onVisibility = (): void => {
        if (win.document.visibilityState === 'hidden') fn();
      };
      win.addEventListener('pagehide', fn);
      win.document.addEventListener('visibilitychange', onVisibility);
      return () => {
        win.removeEventListener('pagehide', fn);
        win.document.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
}
