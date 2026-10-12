import { encodeBitmask, nodeCount, type FromWorker, type ResultMsg, type Stage } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { buildDemoStage } from '../src/game/demoStage.ts';
import { cellIndex, makeGrid } from '../src/game/grid.ts';
import type { Backend, BackendFactory, SolveHooks, SolveOutput } from '../src/solver/backend.ts';
import { SolverHost, type HostOptions } from '../src/solver/host.ts';
import { MockBackend } from '../src/solver/mockBackend.ts';

type Factory = () => BackendFactory;

const mockFactory =
  (steps: number): Factory =>
  () =>
  (stage, opts) =>
    Promise.resolve(new MockBackend(stage, { ...opts, steps }));

function setup(backend: number | Factory = 3, hostOptions: HostOptions = {}) {
  const out: FromWorker[] = [];
  const transfers: Transferable[][] = [];
  const host = new SolverHost(
    (msg, transfer) => {
      // like a real postMessage: transferred buffers are detached, so a backend that reuses
      // or double-transfers a buffer fails here
      out.push(structuredClone(msg, { transfer }));
      transfers.push(transfer);
    },
    typeof backend === 'number' ? mockFactory(backend) : backend,
    hostOptions,
  );
  return { host, out, transfers };
}

const results = (out: FromWorker[]) => out.filter((m): m is ResultMsg => m.type === 'result');

/** A yield that only resolves when the test opens it — pins a solve between two chunks. */
class Gate {
  private waiters: (() => void)[] = [];
  readonly wait = (): Promise<void> =>
    new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  get pending(): number {
    return this.waiters.length;
  }
  open(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

/** Keep opening the gate until the host has processed everything. */
async function drain(host: SolverHost, gate: Gate): Promise<void> {
  let done = false;
  const idle = host.idle().then(() => {
    done = true;
  });
  while (!done) {
    gate.open();
    await tick();
  }
  await idle;
}

/** Mock backend factory that records whether each solve finished or was cancelled. */
function spyingFactory(steps: number, outcomes: string[]): Factory {
  return () => (stage, opts) => {
    const be = new MockBackend(stage, { ...opts, steps });
    const solve = be.solve.bind(be);
    be.solve = async (hooks: SolveHooks) => {
      const r = await solve(hooks);
      outcomes.push(r ? 'done' : 'cancelled');
      return r;
    };
    return Promise.resolve(be);
  };
}

describe('SolverHost (worker message handler)', () => {
  it('init replies ready then a result for seq 0', async () => {
    const { host, out, transfers } = setup();
    host.receive({ type: 'init', stage: buildDemoStage() });
    await host.idle();
    expect(out[0]).toMatchObject({ type: 'ready', backend: 'mock', elements: 768, nodes: 25 * 9 * 5, levels: 0 });
    const r = results(out);
    expect(r).toHaveLength(1);
    expect(r[0]!.seq).toBe(0);
    expect(r[0]!.cases[0]!.utilization).toHaveLength(768);
    expect(r[0]!.cases[0]!.displacement).toHaveLength(3 * 25 * 9 * 5);
    expect(transfers.at(-1)!.length).toBe(3); // floating + utilization + displacement buffers
  });

  it('queued carves are all applied, only the newest is solved', async () => {
    const { host, out } = setup(4);
    const stage = buildDemoStage();
    const g = makeGrid(stage.grid);
    host.receive({ type: 'init', stage });
    await host.idle();
    out.length = 0;
    // cut the beam in two steps; only the second solve should report
    const left: number[] = [];
    const right: number[] = [];
    for (let y = 0; y < 8; y++) for (let z = 0; z < 4; z++) (y < 4 ? left : right).push(cellIndex(g, 10, y, z));
    host.receive({ type: 'carve', seq: 1, removed: left, restored: [] });
    host.receive({ type: 'carve', seq: 2, removed: right, restored: [] });
    await host.idle();
    const r = results(out);
    expect(r.map((m) => m.seq)).toEqual([2]);
    expect(r[0]!.loadsConnected).toBe(false); // both halves of the cut were applied
    expect(r[0]!.floating.length).toBe(13 * 8 * 4);
  });

  it('a carve queued while init is loading is solved instead of seq 0', async () => {
    const { host, out } = setup(6);
    host.receive({ type: 'init', stage: buildDemoStage() });
    await Promise.resolve();
    host.receive({ type: 'carve', seq: 1, removed: [100], restored: [] });
    await host.idle();
    expect(results(out).map((m) => m.seq)).toEqual([1]);
  });

  // T-311 #2: cancellation must actually interrupt a running solve
  it('a carve arriving mid-solve: the running solve returns null and its seq never reports', async () => {
    const gate = new Gate();
    const outcomes: string[] = [];
    let clock = 0;
    const { host, out } = setup(spyingFactory(4, outcomes), { yieldFn: gate.wait, now: () => (clock += 100) });
    host.receive({ type: 'init', stage: buildDemoStage() });
    await until(() => gate.pending === 1); // seq 0 is paused between two chunks
    expect(out.map((m) => m.type)).toEqual(['ready', 'progress']);
    const mark = out.length;
    host.receive({ type: 'carve', seq: 1, removed: [100], restored: [] });
    await drain(host, gate);
    expect(outcomes).toEqual(['cancelled', 'done']);
    const later = out.slice(mark);
    expect(later.filter((m) => 'seq' in m && m.seq === 0)).toEqual([]);
    expect(results(out).map((m) => m.seq)).toEqual([1]);
    expect(later.some((m) => m.type === 'progress' && m.seq === 1)).toBe(true);
  });

  it('cancel mid-solve stops it; the next carve is solved normally', async () => {
    const gate = new Gate();
    const outcomes: string[] = [];
    const { host, out } = setup(spyingFactory(4, outcomes), { yieldFn: gate.wait });
    host.receive({ type: 'init', stage: buildDemoStage() });
    await until(() => gate.pending === 1);
    host.receive({ type: 'cancel' });
    await drain(host, gate);
    expect(outcomes).toEqual(['cancelled']);
    expect(results(out)).toEqual([]);
    host.receive({ type: 'carve', seq: 1, removed: [100], restored: [] });
    await drain(host, gate);
    expect(outcomes).toEqual(['cancelled', 'done']);
    expect(results(out).map((m) => m.seq)).toEqual([1]);
  });

  it('setSolid replaces the whole set; restore brings material back', async () => {
    const { host, out } = setup();
    const stage = buildDemoStage();
    host.receive({ type: 'init', stage });
    host.receive({ type: 'setSolid', seq: 1, solid: encodeBitmask(new Uint8Array(768)) });
    await host.idle();
    let r = results(out).at(-1)!;
    expect(r.seq).toBe(1);
    expect(r.loadsConnected).toBe(false);
    host.receive({ type: 'setSolid', seq: 2, solid: stage.solid });
    await host.idle();
    r = results(out).at(-1)!;
    expect(r.seq).toBe(2);
    expect(r.loadsConnected).toBe(true);
    expect(r.cases[0]!.maxUtilization).toBeGreaterThan(0);
  });

  // T-311 #5: the host's solid mirror must follow each applied setSolid call
  it('a rejected restore does not desync the solid mirror used for setSolid diffs', async () => {
    let backend: StrictBackend | null = null;
    const factory: Factory = () => (stage) => Promise.resolve((backend = new StrictBackend(stage)));
    const { host, out } = setup(factory);
    const stage = buildDemoStage();
    host.receive({ type: 'init', stage });
    host.receive({ type: 'carve', seq: 1, removed: [100], restored: [] });
    await host.idle();
    backend!.rejectNextRestore = true;
    // the removal of 200 is applied, the restore of 100 is rejected
    host.receive({ type: 'carve', seq: 2, removed: [200], restored: [100] });
    await host.idle();
    expect(out.find((m) => m.type === 'error')).toMatchObject({ seq: 2, message: 'restore rejected' });
    expect(backend!.solid[200]).toBe(0);
    // back to the authored solid set: both 100 and 200 must be restored in the backend
    host.receive({ type: 'setSolid', seq: 3, solid: stage.solid });
    await host.idle();
    expect([...backend!.solid].every((v) => v === 1)).toBe(true);
    expect(results(out).at(-1)!.seq).toBe(3);
  });

  it('cancel before the first solve starts suppresses its result', async () => {
    const { host, out } = setup(6);
    host.receive({ type: 'init', stage: buildDemoStage() });
    host.receive({ type: 'cancel' });
    await host.idle();
    expect(out.map((m) => m.type)).toEqual(['ready']);
  });

  it('reports errors with the request seq', async () => {
    const { host, out } = setup();
    host.receive({ type: 'carve', seq: 7, removed: [1], restored: [] });
    await host.idle();
    expect(out).toEqual([{ type: 'error', seq: 7, message: 'solver not initialised (send init first)' }]);
  });
});

/** Applies a setSolid batch fully or throws without applying it (like fem-wasm's Session). */
class StrictBackend implements Backend {
  readonly info;
  readonly solid: Uint8Array;
  rejectNextRestore = false;

  constructor(stage: Stage) {
    const n = stage.grid[0] * stage.grid[1] * stage.grid[2];
    this.info = { backend: 'mock' as const, elements: n, nodes: nodeCount(stage.grid), levels: 0 };
    this.solid = new Uint8Array(n).fill(1);
  }

  setSolid(indices: Uint32Array, solid: boolean): void {
    if (solid && this.rejectNextRestore) {
      this.rejectNextRestore = false;
      throw new Error('restore rejected');
    }
    for (const e of indices) this.solid[e] = solid ? 1 : 0;
  }

  solve(): Promise<SolveOutput> {
    return Promise.resolve({
      converged: true,
      iterations: 0,
      relResidual: 0,
      cases: [],
      floating: new Uint32Array(0),
      loadsConnected: true,
    });
  }

  dispose(): void {}
}
