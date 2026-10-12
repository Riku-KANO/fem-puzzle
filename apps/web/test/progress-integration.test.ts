// StageRunner against the real controller + solver protocol (in-process SolverHost with the
// mock backend): a resumed carve reaches the solver and the first current result describes it;
// switching stages leaves no HUD state behind.

import type { FromWorker, ResultMsg, Stage, ToWorker } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { CarveState } from '../src/game/carveState.ts';
import { GameController, type HudModel, type ViewPort } from '../src/game/controller.ts';
import { buildDemoStage } from '../src/game/demoStage.ts';
import { ProgressStore } from '../src/game/progress/records.ts';
import { StageRunner, type ProgressSession, type RunnerEnv } from '../src/game/progress/session.ts';
import { MemoryStore } from '../src/game/progress/storage.ts';
import { SolverClient, type WorkerPort } from '../src/solver/client.ts';
import { SolverHost } from '../src/solver/host.ts';
import { MockBackend } from '../src/solver/mockBackend.ts';

class LoopbackPort implements WorkerPort {
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  readonly sent: ToWorker[] = [];
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

class NullView implements ViewPort {
  changed = 0;
  solidChanged(cells: readonly number[]): void {
    this.changed += cells.length;
  }
  setUtilization(): void {}
  setResult(_r: ResultMsg): void {}
  elementsRemoved(): void {}
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

interface RealSession extends ProgressSession {
  controller: GameController;
  port: LoopbackPort;
  disposed: boolean;
}

function startReal(stage: Stage, hud: HudModel): RealSession {
  const port = new LoopbackPort();
  const solver = new SolverClient(port);
  const scene = new NullView();
  const controller = new GameController(new CarveState(stage), solver, scene, hud);
  const session: RealSession = {
    controller,
    scene,
    solver,
    port,
    disposed: false,
    dispose() {
      controller.dispose();
      solver.dispose();
      session.disposed = true;
    },
  };
  return session;
}

const env: RunnerEnv = {
  setInterval: () => 0,
  clearInterval: () => {},
  now: () => 1,
};

async function settle(session: RealSession): Promise<void> {
  session.controller.flush();
  await session.port.host.idle();
  session.controller.flush();
}

/** Carve the free end of the demo cantilever (not protected, keeps the beam connected). */
function carveSome(state: CarveState): number[] {
  const cells: number[] = [];
  for (let e = 0; e < state.solid.length && cells.length < 6; e++) {
    if (state.solid[e] && !state.keep[e] && e % state.grid.nx > 3) cells.push(e);
  }
  state.carve(cells);
  state.endStroke();
  return cells;
}

describe('StageRunner with the real controller and solver protocol', () => {
  it('a resumed carve is sent after init and the current result describes it', async () => {
    const stage = buildDemoStage();
    const storage = new MemoryStore();
    const hud = newHud();

    const first = new StageRunner(new ProgressStore(storage), (s) => startReal(s, hud), env);
    const s1 = first.open(stage);
    const carved = carveSome(s1.controller.state);
    await settle(s1);
    const expected = s1.controller.state.toBitmask();
    first.close();
    expect(s1.disposed).toBe(true);

    // Reload.
    const runner = new StageRunner(new ProgressStore(storage), (s) => startReal(s, hud), env);
    const s2 = runner.open(stage);
    expect(runner.resume).toBe('resumed');
    expect(s2.port.sent.map((m) => m.type)).toEqual(['init', 'carve']);
    const carveMsg = s2.port.sent[1];
    expect(carveMsg?.type === 'carve' ? [...carveMsg.removed].sort((a, b) => a - b) : null).toEqual(
      [...carved].sort((a, b) => a - b),
    );
    await settle(s2);
    expect(s2.controller.state.toBitmask()).toBe(expected);
    expect(s2.controller.latestResult?.seq).toBe(1);
    expect(hud.resultCurrent).toBe(true);
    expect(hud.volumeFraction).toBeCloseTo(s2.controller.state.volumeFraction, 12);
    expect(hud.canUndo).toBe(false);
    runner.close();
  });

  it('switching stages starts from a clean HUD', async () => {
    const hud = newHud();
    const runner = new StageRunner(new ProgressStore(new MemoryStore()), (s) => startReal(s, hud), env);
    const a = runner.open(buildDemoStage());
    carveSome(a.controller.state);
    await settle(a);
    hud.loadsConnected = false;
    hud.error = 'stale';
    hud.toast = { text: 'stale', id: 1 };
    const b = runner.open({ ...buildDemoStage(), id: 'other' });
    expect(a.disposed).toBe(true);
    expect(hud).toMatchObject({
      volumeFraction: 1,
      canUndo: false,
      loadsConnected: true,
      error: null,
      toast: null,
      maxUtilization: null,
      resultCurrent: false,
    });
    await settle(b);
    expect(hud.resultCurrent).toBe(true);
    runner.close();
  });
});
