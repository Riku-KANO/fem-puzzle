// JS mock backend: deterministic fields from `mockPhysics.ts`, delivered like an iterative
// solver — a few "iterations" that blend the previous field into the new one, posting
// `progress` when due, checking for cancellation between chunks.

import { decodeBitmask, elementCount, nodeCount, type SolverOptionsMsg, type Stage } from '@stress-carve/protocol';
import type { Backend, BackendFactory, SolveHooks, SolveOutput } from './backend.ts';
import { buildMockModel, computeMockFields, type MockModel } from './mockPhysics.ts';

export interface MockBackendOptions {
  /** simulated iteration chunks per solve (default 6) */
  steps?: number;
  /** artificial delay per chunk in ms, to mimic solver latency in the browser (default 0) */
  stepDelayMs?: number;
}

const ITERS_PER_STEP = 8;

export class MockBackend implements Backend {
  readonly info;
  private readonly model: MockModel;
  private readonly solid: Uint8Array;
  private readonly steps: number;
  private readonly stepDelayMs: number;
  /** utilisation of case 0 from the last finished solve (warm start of the animation) */
  private last: Float32Array;

  constructor(stage: Stage, options: SolverOptionsMsg & MockBackendOptions = {}) {
    const n = elementCount(stage.grid);
    this.info = { backend: 'mock' as const, elements: n, nodes: nodeCount(stage.grid), levels: 0 };
    this.model = buildMockModel(stage);
    this.solid = decodeBitmask(stage.solid, n);
    this.steps = Math.max(1, options.steps ?? 6);
    this.stepDelayMs = options.stepDelayMs ?? 0;
    this.last = new Float32Array(n);
  }

  setSolid(indices: Uint32Array, solid: boolean): void {
    const v = solid ? 1 : 0;
    for (const e of indices) if (e < this.solid.length) this.solid[e] = v;
  }

  /** Synchronous final answer (tests, benchmarks). */
  computeNow(): SolveOutput {
    const f = computeMockFields(this.model, this.solid);
    return {
      converged: true,
      iterations: this.steps * ITERS_PER_STEP,
      relResidual: residualAt(this.steps),
      cases: f.cases,
      floating: f.floating,
      loadsConnected: f.loadsConnected,
    };
  }

  async solve(hooks: SolveHooks): Promise<SolveOutput | null> {
    const out = this.computeNow();
    const target = out.cases[0]?.utilization;
    const from = this.last;
    for (let step = 1; step < this.steps; step++) {
      if (hooks.cancelled()) return null;
      if (target && hooks.progressDue()) {
        const t = easeOut(step / this.steps);
        const snap = new Float32Array(target.length);
        for (let e = 0; e < snap.length; e++) snap[e] = from[e]! + (target[e]! - from[e]!) * t;
        hooks.progress(step * ITERS_PER_STEP, residualAt(step), snap);
      }
      await (this.stepDelayMs > 0 ? delay(this.stepDelayMs) : hooks.yield());
    }
    if (hooks.cancelled()) return null;
    if (target) this.last = new Float32Array(target);
    return out;
  }

  dispose(): void {}
}

export const mockBackendFactory: BackendFactory = (stage, options) =>
  Promise.resolve(new MockBackend(stage, options));

function residualAt(step: number): number {
  return 10 ** (-0.85 * step);
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 2;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
