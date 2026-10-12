import { encodeBitmask, type FromWorker, type ResultMsg, type Stage, type ToWorker, type Vec3 } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { CarveState } from '../src/game/carveState.ts';
import { GameController, MESSAGES, type HudModel, type RemovalCause, type ViewPort } from '../src/game/controller.ts';
import { buildDemoStage } from '../src/game/demoStage.ts';
import { cellIndex, makeGrid } from '../src/game/grid.ts';
import type { VoxelHit } from '../src/render/picking.ts';
import { releaseRenderer } from '../src/render/scene.ts';
import { SolverClient, type WorkerPort } from '../src/solver/client.ts';
import { SolverHost } from '../src/solver/host.ts';
import { MockBackend } from '../src/solver/mockBackend.ts';

/** Main-thread port wired straight into an in-process SolverHost. */
class LoopbackPort implements WorkerPort {
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  sent: ToWorker[] = [];
  readonly host = new SolverHost(
    (msg) => this.onmessage?.({ data: msg } as MessageEvent<FromWorker>),
    () => (stage, opts) => Promise.resolve(new MockBackend(stage, { ...opts, steps: 2 })),
  );
  postMessage(message: ToWorker): void {
    this.sent.push(message);
    this.host.receive(message);
  }
  terminate(): void {}
}

class FakeView implements ViewPort {
  changed: number[] = [];
  removed: { cells: readonly number[]; cause: RemovalCause }[] = [];
  utilization: Float32Array | null = null;
  results: ResultMsg[] = [];
  solidChanged(cells: readonly number[]): void {
    this.changed.push(...cells);
  }
  setUtilization(u: Float32Array | null): void {
    this.utilization = u;
  }
  setResult(r: ResultMsg): void {
    this.results.push(r);
  }
  elementsRemoved(cells: readonly number[], cause: RemovalCause): void {
    this.removed.push({ cells, cause });
  }
  showBrush(): void {}
}

const newHud = (): HudModel => ({
  volumeFraction: 1,
  solidCount: 0,
  canUndo: false,
  canRedo: false,
  brush: 1,
  solving: false,
  iteration: 0,
  relResidual: 0,
  backend: null,
  maxUtilization: null,
  loadsConnected: true,
  converged: false,
  resultCurrent: false,
  error: null,
  toast: null,
});

function setup(stage: Stage, hud: HudModel = newHud()) {
  const port = new LoopbackPort();
  const view = new FakeView();
  const state = new CarveState(stage);
  const controller = new GameController(state, new SolverClient(port), view, hud);
  const settle = async () => {
    controller.flush();
    await port.host.idle();
  };
  return { port, view, hud, state, controller, settle };
}

/** Hit on the z+ face of a cell (always exposed in a 1-thick plate). */
const hitZ = (stage: Stage, c: Vec3): VoxelHit => ({
  element: cellIndex(makeGrid(stage.grid), ...c),
  cell: c,
  face: 'z+',
  t: 0,
  point: [c[0] + 0.5, c[1] + 0.5, c[2] + 1],
});

/** 10×3×1 plate, clamped at x-, loaded at the top of the free end. */
function plateStage(): Stage {
  const n = 10 * 3;
  return {
    ...buildDemoStage(),
    id: 'plate',
    grid: [10, 3, 1],
    solid: encodeBitmask(new Uint8Array(n).fill(1)),
    keep: encodeBitmask(new Uint8Array(n)),
    loads: [{ cells: [[9, 2, 0]], force: [0, -500, 0] }],
  };
}

describe('GameController (with the worker host + mock backend in-process)', () => {
  it('init → ready + first result fill the HUD', async () => {
    const { hud, view, settle } = setup(buildDemoStage());
    await settle();
    expect(hud.backend).toBe('mock');
    expect(hud.maxUtilization).toBeGreaterThan(0);
    expect(hud.solving).toBe(false);
    expect(hud.resultCurrent).toBe(true);
    expect(view.utilization).toHaveLength(768);
  });

  it('a drag is one history entry, sent as one coalesced carve; undo restores', async () => {
    const stage = plateStage();
    const { hud, port, controller, settle } = setup(stage);
    await settle();
    controller.strokeStart(hitZ(stage, [3, 0, 0]));
    controller.strokeMove(hitZ(stage, [4, 0, 0]));
    controller.strokeMove(hitZ(stage, [4, 0, 0])); // already gone: no-op
    controller.strokeEnd();
    expect(hud.solidCount).toBe(28);
    expect(hud.solving).toBe(true);
    expect(hud.resultCurrent).toBe(false);
    await settle();
    const carves = port.sent.filter((m) => m.type === 'carve');
    expect(carves).toHaveLength(1);
    expect(carves[0]).toMatchObject({ seq: 1, removed: [3, 4], restored: [] });
    expect(hud.resultCurrent).toBe(true);
    expect(hud.canUndo).toBe(true);

    controller.undo();
    expect(hud.solidCount).toBe(30);
    expect(hud.canRedo).toBe(true);
    await settle();
    expect(port.sent.at(-1)).toMatchObject({ type: 'carve', seq: 2, removed: [], restored: [3, 4] });
  });

  it('floating material is removed as debris and recorded in the same history entry', async () => {
    const stage = plateStage();
    const { hud, view, state, controller, settle } = setup(stage);
    await settle();
    // isolate cell (7,0): remove its neighbours (6,0), (8,0), (7,1) in one drag
    controller.strokeStart(hitZ(stage, [6, 0, 0]));
    controller.strokeMove(hitZ(stage, [8, 0, 0]));
    controller.strokeMove(hitZ(stage, [7, 1, 0]));
    controller.strokeEnd();
    await settle(); // result reports (7,0) floating → removed, diff queued
    const island = cellIndex(state.grid, 7, 0, 0);
    expect(state.solid[island]).toBe(0);
    expect(view.removed.at(-1)).toEqual({ cells: [island], cause: 'floating' });
    expect(state.history.undoDepth).toBe(1);
    expect(state.history.peek()!.floating).toEqual([island]);
    expect(hud.solidCount).toBe(26);
    await settle(); // the debris diff is sent and solved
    expect(hud.resultCurrent).toBe(true);
    expect(hud.loadsConnected).toBe(true);

    controller.undo();
    expect(hud.solidCount).toBe(30);
    expect(state.solid[island]).toBe(1);
  });

  it('a floating part that holds a load stays (loads not connected)', async () => {
    const stage = plateStage();
    const { hud, state, controller, settle } = setup(stage);
    await settle();
    controller.strokeStart(hitZ(stage, [5, 0, 0]));
    controller.strokeMove(hitZ(stage, [5, 1, 0]));
    controller.strokeMove(hitZ(stage, [5, 2, 0]));
    controller.strokeEnd();
    await settle();
    expect(hud.loadsConnected).toBe(false);
    expect(hud.solidCount).toBe(27);
    expect(state.solid[cellIndex(state.grid, 9, 2, 0)]).toBe(1);
  });

  it('protected cells give feedback instead of carving', async () => {
    const stage = plateStage();
    const { hud, controller, settle } = setup(stage);
    await settle();
    controller.strokeStart(hitZ(stage, [0, 1, 0])); // clamped face
    controller.strokeEnd();
    expect(hud.toast?.text).toBe(MESSAGES.protected);
    expect(hud.solidCount).toBe(30);
    expect(hud.canUndo).toBe(false);
  });

  it('double-click revert drops the click from history without a redo entry', async () => {
    const stage = plateStage();
    const { hud, controller, settle } = setup(stage);
    await settle();
    controller.strokeStart(hitZ(stage, [4, 1, 0]));
    const entry = controller.strokeEnd()!;
    controller.revert(entry);
    expect(hud.solidCount).toBe(30);
    expect(hud.canUndo).toBe(false);
    expect(hud.canRedo).toBe(false);
  });
  /** carve (6,0), (8,0), (7,1) in one drag: isolates (7,0) */
  function carveIsland(controller: GameController, stage: Stage): void {
    controller.strokeStart(hitZ(stage, [6, 0, 0]));
    controller.strokeMove(hitZ(stage, [8, 0, 0]));
    controller.strokeMove(hitZ(stage, [7, 1, 0]));
    controller.strokeEnd();
  }

  // T-311 #1: debris arriving during a press that carves nothing (e.g. on empty space)
  it('debris during a no-op press joins the carve that caused it, not a new entry', async () => {
    const stage = plateStage();
    const { state, view, controller, settle, port } = setup(stage);
    await settle();
    // an older entry, undone, so there is something on the redo stack
    controller.strokeStart(hitZ(stage, [2, 2, 0]));
    controller.strokeEnd();
    controller.undo();
    await settle();
    expect(state.history.redoDepth).toBe(1);

    carveIsland(controller, stage);
    controller.flush(); // carve sent; result not yet processed
    controller.strokeStart(null); // press on empty space, held while the result arrives
    await port.host.idle(); // result: (7,0) floating → debris
    const island = cellIndex(state.grid, 7, 0, 0);
    expect(state.solid[island]).toBe(0);
    expect(view.removed.at(-1)).toEqual({ cells: [island], cause: 'floating' });
    expect(controller.strokeEnd()).toBeNull();
    expect(state.history.undoDepth).toBe(1); // no debris-only entry
    expect(state.history.peek()!.floating).toEqual([island]);

    controller.undo(); // restores the carve *and* its debris
    for (const [x, y] of [
      [6, 0],
      [8, 0],
      [7, 1],
      [7, 0],
    ] as const) {
      expect(state.solid[cellIndex(state.grid, x, y, 0)], `${x},${y}`).toBe(1);
    }
    expect(state.solidCount).toBe(30);
  });

  it('a press that carves nothing keeps the redo stack', async () => {
    const stage = plateStage();
    const { state, controller, settle } = setup(stage);
    await settle();
    controller.strokeStart(hitZ(stage, [4, 1, 0]));
    controller.strokeEnd();
    controller.undo();
    controller.strokeStart(null);
    controller.strokeEnd();
    controller.strokeStart(hitZ(stage, [0, 1, 0])); // protected: carves nothing
    controller.strokeEnd();
    expect(state.canRedo).toBe(true);
  });

  // T-311 #3: the `!batcher.pending` guard in onResult
  it('no debris when an undo is pending: the result describes an outdated state', async () => {
    const stage = plateStage();
    const { state, view, controller, settle, port } = setup(stage);
    await settle();
    carveIsland(controller, stage);
    controller.flush(); // seq 1 in flight: (7,0) will be reported floating
    controller.undo(); // reconnects (7,0) before the result arrives (diff not sent yet)
    await port.host.idle();
    const island = cellIndex(state.grid, 7, 0, 0);
    expect(state.solid[island]).toBe(1);
    expect(view.removed.filter((r) => r.cause === 'floating')).toEqual([]);
    expect(state.history.undoDepth).toBe(0);
    expect(state.history.redoDepth).toBe(1);
    expect(state.history.peek()).toBeUndefined();
    await settle(); // the restore is sent and solved: still nothing floating
    expect(state.solidCount).toBe(30);
    expect(view.removed.filter((r) => r.cause === 'floating')).toEqual([]);
  });

  // T-311 #4: a new session must not inherit HUD values from the previous stage
  it('the constructor resets every HUD field', () => {
    const stale: HudModel = {
      volumeFraction: 0.3,
      solidCount: 5,
      canUndo: true,
      canRedo: true,
      brush: 5,
      solving: false,
      iteration: 99,
      relResidual: 1e-3,
      backend: 'wasm',
      maxUtilization: 2,
      loadsConnected: false,
      converged: true,
      resultCurrent: true,
      error: 'old',
      toast: { text: 'old', id: 7 },
    };
    setup(plateStage(), stale);
    expect(stale).toEqual({
      volumeFraction: 1,
      solidCount: 30,
      canUndo: false,
      canRedo: false,
      brush: 1,
      solving: true,
      iteration: 0,
      relResidual: Number.NaN,
      backend: null,
      maxUtilization: null,
      loadsConnected: true,
      converged: false,
      resultCurrent: false,
      error: null,
      toast: null,
    });
  });
});

// T-311 #6 — lives here because T-311 owns only this and host.test.ts (the session teardown
// that GameSession.dispose → StageScene.dispose performs).
describe('StageScene teardown', () => {
  it('releases the WebGL context before removing the canvas', () => {
    const calls: string[] = [];
    releaseRenderer({
      dispose: () => calls.push('dispose'),
      forceContextLoss: () => calls.push('forceContextLoss'),
      domElement: { remove: () => calls.push('remove') },
    });
    expect(calls).toEqual(['dispose', 'forceContextLoss', 'remove']);
  });
});
