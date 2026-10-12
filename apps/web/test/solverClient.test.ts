import type { FromWorker, ResultMsg, ToWorker } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { buildDemoStage } from '../src/game/demoStage.ts';
import { SolverClient, type WorkerPort } from '../src/solver/client.ts';

class FakePort implements WorkerPort {
  sent: ToWorker[] = [];
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  postMessage(message: ToWorker): void {
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  deliver(msg: FromWorker): void {
    this.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
  }
}

const result = (seq: number): ResultMsg => ({
  type: 'result',
  seq,
  converged: true,
  iterations: 1,
  relResidual: 1e-6,
  elapsedMs: 1,
  cases: [],
  floating: new Uint32Array(),
  loadsConnected: true,
});

describe('SolverClient', () => {
  it('numbers requests with increasing seq', () => {
    const port = new FakePort();
    const c = new SolverClient(port);
    c.init(buildDemoStage());
    expect(c.carve([1], [])).toBe(1);
    expect(c.carve([2], [])).toBe(2);
    expect(c.setSolid('AA==')).toBe(3);
    expect(port.sent.map((m) => m.type)).toEqual(['init', 'carve', 'carve', 'setSolid']);
    expect(port.sent.map((m) => ('seq' in m ? m.seq : 0))).toEqual([0, 1, 2, 3]);
  });

  it('drops progress/result/error for stale seq and applies the current one', () => {
    const port = new FakePort();
    const c = new SolverClient(port);
    const got: number[] = [];
    const progress: number[] = [];
    const errors: string[] = [];
    c.subscribe({
      result: (m) => got.push(m.seq),
      progress: (m) => progress.push(m.seq),
      error: (m) => errors.push(m.message),
    });
    c.init(buildDemoStage());
    port.deliver(result(0));
    c.carve([1], []);
    c.carve([2], []);
    expect(c.solving).toBe(true);
    port.deliver({ type: 'progress', seq: 1, iteration: 3, relResidual: 0.1, utilization: new Float32Array(1) });
    port.deliver(result(1));
    port.deliver({ type: 'error', seq: 1, message: 'old' });
    expect(got).toEqual([0]);
    expect(progress).toEqual([]);
    expect(errors).toEqual([]);
    expect(c.dropped).toBe(3);
    port.deliver({ type: 'progress', seq: 2, iteration: 3, relResidual: 0.1, utilization: new Float32Array(1) });
    port.deliver(result(2));
    expect(progress).toEqual([2]);
    expect(got).toEqual([0, 2]);
    expect(c.solving).toBe(false);
    port.deliver({ type: 'error', message: 'unsequenced errors always pass' });
    expect(errors).toHaveLength(1);
  });

  it('dispose terminates the worker and ignores late messages', () => {
    const port = new FakePort();
    const c = new SolverClient(port);
    const got: number[] = [];
    c.subscribe({ result: (m) => got.push(m.seq) });
    c.init(buildDemoStage());
    const deliver = port.onmessage!;
    c.dispose();
    deliver({ data: result(0) } as MessageEvent<FromWorker>);
    expect(got).toEqual([]);
    expect(port.terminated).toBe(true);
  });
});
