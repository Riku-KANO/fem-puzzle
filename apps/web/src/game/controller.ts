// GameController: the one place where player input, the carve state, the solver client, the
// 3D view and the HUD meet. DOM/Three-free (the view and HUD are interfaces), so the whole
// carve → solve → result → debris loop is testable with fakes.

import type { ErrorMsg, ProgressMsg, ReadyMsg, ResultMsg, SolverOptionsMsg } from '@stress-carve/protocol';
import { envelope } from '../render/colormap.ts';
import type { VoxelHit } from '../render/picking.ts';
import type { SolverClient } from '../solver/client.ts';
import { DiffBatcher } from '../solver/diffBatcher.ts';
import { brushSelect, type BrushSelection, type BrushSize } from './brush.ts';
import type { CarveEntry, CarveState, SolidDiff } from './carveState.ts';
import { debrisCells } from './connectivity.ts';

export type RemovalCause = 'carve' | 'floating';

/** What the controller needs from the 3D view (implemented by `render/scene.ts`). */
export interface ViewPort {
  /** These cells flipped solid/empty: rebuild the affected chunks. */
  solidChanged(cells: readonly number[]): void;
  /** Per-element utilisation to colour by (envelope over load cases); null = not solved yet. */
  setUtilization(utilization: Float32Array | null): void;
  /** Latest current result (displacements for the load test, T-302). */
  setResult(result: ResultMsg): void;
  /** Cells left the solid set — debris hook (T-307/T-310). Not called for undo/redo. */
  elementsRemoved(cells: readonly number[], cause: RemovalCause): void;
  /** Hover preview of the brush; null hides it. */
  showBrush(selection: BrushSelection | null): void;
  /** Cell hidden by the current view (T-303 section): the brush treats it as empty. */
  isHidden?(element: number): boolean;
}

/** HUD fields the controller keeps up to date (a Svelte `$state` class in the app). */
export interface HudModel {
  volumeFraction: number;
  solidCount: number;
  canUndo: boolean;
  canRedo: boolean;
  brush: BrushSize;
  /** a newer state than the latest result exists (pending diff or solve in flight) */
  solving: boolean;
  iteration: number;
  relResidual: number;
  backend: ReadyMsg['backend'] | null;
  /** judged maximum utilisation over all load cases of the latest result */
  maxUtilization: number | null;
  loadsConnected: boolean;
  converged: boolean;
  /** the latest result describes exactly the current solid set (T-301: submit gate) */
  resultCurrent: boolean;
  error: string | null;
  toast: { text: string; id: number } | null;
}

export const MESSAGES = {
  protected: '保護領域は削れません',
  block: '障害物は削れません',
} as const;

export class GameController {
  brush: BrushSize = 1;
  /** latest result for the newest request (null until the first one arrives) */
  latestResult: ResultMsg | null = null;

  private readonly batcher = new DiffBatcher();
  private readonly unsubscribe: () => void;
  private toastId = 0;

  constructor(
    readonly state: CarveState,
    private readonly solver: SolverClient,
    private readonly view: ViewPort,
    private readonly hud: HudModel,
    options?: SolverOptionsMsg,
  ) {
    this.unsubscribe = solver.subscribe({
      ready: (m) => this.onReady(m),
      progress: (m) => this.onProgress(m),
      result: (m) => this.onResult(m),
      error: (m) => this.onError(m),
    });
    hud.brush = this.brush;
    hud.error = null;
    hud.maxUtilization = null;
    solver.init(state.stage, options);
    this.syncHud();
  }

  // --- input ----------------------------------------------------------------

  /** Pointer hover: preview what the brush would carve. */
  hover(hit: VoxelHit | null): void {
    this.view.showBrush(hit && !this.state.block[hit.element] ? this.select(hit) : null);
  }

  strokeStart(hit: VoxelHit | null): void {
    this.state.beginStroke();
    this.carveAt(hit, true);
  }

  strokeMove(hit: VoxelHit | null): void {
    if (!this.state.strokeActive) return;
    this.carveAt(hit, false);
  }

  /** Ends the drag; returns the history entry it created (null if nothing was carved). */
  strokeEnd(): CarveEntry | null {
    const entry = this.state.endStroke();
    this.syncHud();
    return entry;
  }

  undo(): void {
    const diff = this.state.undo();
    if (diff) this.apply(diff, null);
    this.syncHud();
  }

  redo(): void {
    const diff = this.state.redo();
    if (diff) this.apply(diff, null);
    this.syncHud();
  }

  /** Revert a click that turned out to be the first half of a double-click. */
  revert(entry: CarveEntry): void {
    const diff = this.state.discard(entry);
    if (diff) this.apply(diff, null);
    this.syncHud();
  }

  setBrush(size: BrushSize): void {
    this.brush = size;
    this.hud.brush = size;
  }

  /** Send the coalesced diff to the solver; call once per animation frame. */
  flush(): void {
    const diff = this.batcher.take();
    if (diff) this.solver.carve(diff.removed, diff.restored);
    this.syncHud();
  }

  dispose(): void {
    this.unsubscribe();
  }

  // --- internals ------------------------------------------------------------

  private select(hit: VoxelHit): BrushSelection {
    const s = this.state;
    return brushSelect(s.grid, hit.cell, hit.face, this.brush, {
      solid: s.solid,
      keep: s.keep,
      block: s.block,
      strokeRemoved: s.strokeRemoved,
      hidden: this.view.isHidden?.bind(this.view),
    });
  }

  private carveAt(hit: VoxelHit | null, firstPress: boolean): void {
    if (!hit) return;
    if (this.state.block[hit.element]) {
      if (firstPress) this.toast(MESSAGES.block);
      return;
    }
    const sel = this.select(hit);
    const removed = this.state.carve(sel.carve);
    if (removed.length > 0) this.apply({ removed, restored: [] }, 'carve');
    else if (firstPress && sel.protected.length > 0) this.toast(MESSAGES.protected);
    this.view.showBrush(this.select(hit));
    this.syncHud();
  }

  private apply(diff: SolidDiff, cause: RemovalCause | null): void {
    this.batcher.add(diff);
    this.view.solidChanged([...diff.removed, ...diff.restored]);
    if (cause && diff.removed.length > 0) this.view.elementsRemoved(diff.removed, cause);
  }

  private onReady(msg: ReadyMsg): void {
    this.hud.backend = msg.backend;
  }

  private onProgress(msg: ProgressMsg): void {
    this.view.setUtilization(msg.utilization);
    this.hud.iteration = msg.iteration;
    this.hud.relResidual = msg.relResidual;
  }

  private onResult(msg: ResultMsg): void {
    this.latestResult = msg;
    this.hud.error = null;
    this.view.setUtilization(envelope(msg.cases.map((c) => c.utilization)));
    this.view.setResult(msg);
    this.hud.iteration = msg.iterations;
    this.hud.relResidual = msg.relResidual;
    this.hud.converged = msg.converged;
    this.hud.loadsConnected = msg.loadsConnected;
    this.hud.maxUtilization = msg.cases.reduce((m, c) => Math.max(m, c.maxUtilization), 0);
    // Debris only when the result describes the current state: with an unsent diff pending
    // (e.g. an undo that reconnects the part) the list may already be wrong.
    if (msg.floating.length > 0 && !this.batcher.pending) {
      const debris = debrisCells(this.state.grid, msg.floating, this.state.keep);
      const removed = this.state.removeFloating(debris);
      if (removed.length > 0) this.apply({ removed, restored: [] }, 'floating');
    }
    this.syncHud();
  }

  private onError(msg: ErrorMsg): void {
    this.hud.error = msg.message;
    this.syncHud();
  }

  private toast(text: string): void {
    this.hud.toast = { text, id: ++this.toastId };
  }

  private syncHud(): void {
    const s = this.state;
    const h = this.hud;
    h.volumeFraction = s.volumeFraction;
    h.solidCount = s.solidCount;
    h.canUndo = s.canUndo;
    h.canRedo = s.canRedo;
    const pending = this.batcher.pending;
    h.solving = pending || this.solver.solving;
    h.resultCurrent =
      !pending && this.latestResult !== null && this.latestResult.seq === this.solver.latestSeq;
  }
}
