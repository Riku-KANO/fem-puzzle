import { decodeBitmask, encodeBitmask, type FromWorker, type ResultMsg, type Stage, type ToWorker } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import type { VoxelHit } from '../../render/picking.ts';
import { SolverClient, type WorkerPort } from '../../solver/client.ts';
import { SolverHost } from '../../solver/host.ts';
import { MockBackend } from '../../solver/mockBackend.ts';
import { CarveState } from '../carveState.ts';
import { GameController, type HudModel, type ViewPort } from '../controller.ts';
import { buildDemoStage } from '../demoStage.ts';
import { cellIndex, makeGrid } from '../grid.ts';
import { submit, submitGate, SUBMIT_MESSAGES, type SubmitGateInput, type SubmitSource } from './submit.ts';

const gate = (over: Partial<SubmitGateInput> = {}): SubmitGateInput => ({
  resultCurrent: true,
  converged: true,
  solving: false,
  error: null,
  ...over,
});

describe('submitGate', () => {
  it('is open only for a converged result of the current design', () => {
    expect(submitGate(gate())).toEqual({ enabled: true, reason: SUBMIT_MESSAGES.ready, problem: null });
    expect(submitGate(gate({ resultCurrent: false }))).toMatchObject({ enabled: false, problem: null });
    expect(submitGate(gate({ solving: true }))).toMatchObject({ enabled: false, reason: SUBMIT_MESSAGES.solving });
    expect(submitGate(gate({ error: 'boom' }))).toMatchObject({ enabled: false, problem: '解析エラー' });
  });

  it('a stale but converged result does not open it; a current unconverged one explains why', () => {
    expect(submitGate(gate({ resultCurrent: false, converged: true })).enabled).toBe(false);
    const g = submitGate(gate({ converged: false }));
    expect(g.enabled).toBe(false);
    expect(g.problem).toBe('構造が安定していません');
    expect(g.reason).toContain('構造が安定していません');
  });
});

// --- submit() with a fake source -------------------------------------------------

function fakeSource(stage: Stage, result: ResultMsg | null, solid?: Uint8Array): SubmitSource {
  const flags = solid ?? decodeBitmask(stage.solid, stage.grid[0] * stage.grid[1] * stage.grid[2]);
  return {
    state: { stage, solid: flags, toBitmask: () => encodeBitmask(flags) },
    latestResult: result,
  };
}

function resultFor(stage: Stage, u: number, over: Partial<ResultMsg> = {}): ResultMsg {
  const n = stage.grid[0] * stage.grid[1] * stage.grid[2];
  return {
    type: 'result',
    seq: 7,
    converged: true,
    iterations: 1,
    relResidual: 0,
    elapsedMs: 0,
    cases: [
      {
        name: 'default',
        utilization: new Float32Array(n),
        displacement: new Float32Array(0),
        maxUtilization: u,
        loadDisplacement: 0,
      },
    ],
    floating: new Uint32Array(0),
    loadsConnected: true,
    ...over,
  };
}

describe('submit', () => {
  const stage = buildDemoStage();

  it('returns null while the gate is closed or before the first result', () => {
    expect(submit(fakeSource(stage, null), gate())).toBeNull();
    expect(submit(fakeSource(stage, resultFor(stage, 0.5)), gate({ resultCurrent: false }))).toBeNull();
    expect(submit(fakeSource(stage, resultFor(stage, 0.5)), gate({ converged: false }))).toBeNull();
  });

  it('a passing design yields a StageClear record for the progress store', () => {
    const s = submit(fakeSource(stage, resultFor(stage, 0.5)), gate());
    expect(s).not.toBeNull();
    expect(s!.seq).toBe(7);
    expect(s!.judgement.passed).toBe(true);
    expect(s!.clear).toEqual({
      stageId: stage.id,
      stars: 0, // untouched block: passes, but heavier than star1
      volumeFraction: 1,
      beatsBenchmark: false,
      solid: stage.solid,
    });
  });

  it('a failing design is judged but produces no clear record', () => {
    const s = submit(fakeSource(stage, resultFor(stage, 1.5)), gate());
    expect(s!.judgement.passed).toBe(false);
    expect(s!.clear).toBeNull();
  });
});

// --- end to end with the real controller + worker host + mock backend -------------

class LoopbackPort implements WorkerPort {
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  readonly host = new SolverHost(
    (msg) => this.onmessage?.({ data: msg } as MessageEvent<FromWorker>),
    () => (stage, opts) => Promise.resolve(new MockBackend(stage, { ...opts, steps: 2 })),
  );
  postMessage(message: ToWorker): void {
    this.host.receive(message);
  }
  terminate(): void {}
}

const nullView: ViewPort = {
  solidChanged() {},
  setUtilization() {},
  setResult() {},
  elementsRemoved() {},
  showBrush() {},
};

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

describe('submit with the GameController (mock solver in-process)', () => {
  it('opens after the solve settles, closes while a carve is pending, judges the current design', async () => {
    const stage = buildDemoStage();
    const port = new LoopbackPort();
    const hud = newHud();
    const controller = new GameController(new CarveState(stage), new SolverClient(port), nullView, hud);
    const settle = async () => {
      controller.flush();
      await port.host.idle();
    };
    expect(submitGate(hud).enabled).toBe(false);
    await settle();
    expect(submitGate(hud).enabled).toBe(true);

    // carve one surface voxel in the middle of the beam: pending → gate closed
    const g = makeGrid(stage.grid);
    const c: [number, number, number] = [12, 4, 3];
    const hit: VoxelHit = { element: cellIndex(g, ...c), cell: c, face: 'z+', t: 0, point: [12.5, 4.5, 4] };
    controller.strokeStart(hit);
    controller.strokeEnd();
    expect(submitGate(hud).enabled).toBe(false);
    expect(submit(controller, hud)).toBeNull();

    await settle();
    const s = submit(controller, hud);
    expect(s).not.toBeNull();
    expect(s!.seq).toBe(controller.latestResult!.seq);
    expect(s!.judgement.solidCount).toBe(controller.state.solidCount);
    expect(s!.judgement.passed).toBe(true);
    expect(s!.solid).toBe(controller.state.toBitmask());
    controller.dispose();
  });
});
