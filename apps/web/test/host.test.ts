import { encodeBitmask, type FromWorker, type ResultMsg } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { buildDemoStage } from '../src/game/demoStage.ts';
import { cellIndex, makeGrid } from '../src/game/grid.ts';
import { SolverHost } from '../src/solver/host.ts';
import { MockBackend } from '../src/solver/mockBackend.ts';

function setup(steps = 3) {
  const out: FromWorker[] = [];
  const transfers: Transferable[][] = [];
  const host = new SolverHost(
    (msg, transfer) => {
      out.push(msg);
      transfers.push(transfer);
    },
    () => (stage, opts) => Promise.resolve(new MockBackend(stage, { ...opts, steps })),
  );
  return { host, out, transfers };
}

const results = (out: FromWorker[]) => out.filter((m): m is ResultMsg => m.type === 'result');

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

  it('a newer carve supersedes the running solve, but every diff is applied', async () => {
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

  it('a carve arriving mid-solve cancels it at the next chunk', async () => {
    const { host, out } = setup(6);
    host.receive({ type: 'init', stage: buildDemoStage() });
    await Promise.resolve();
    host.receive({ type: 'carve', seq: 1, removed: [100], restored: [] });
    await host.idle();
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

  it('cancel stops the current solve without a result', async () => {
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
