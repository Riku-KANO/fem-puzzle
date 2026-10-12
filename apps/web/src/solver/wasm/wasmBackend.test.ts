// T-205: WASM backend. The first block runs everywhere (fake Session, fallback logic, URL
// option, HUD notice); the second drives the real `fem-wasm` package through the worker
// message handler (`SolverHost`) and is skipped when crates/fem-wasm/pkg is not built.

import { encodeBitmask, type FromWorker, type ProgressMsg, type ResultMsg, type Stage } from '@stress-carve/protocol';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CarveState } from '../../game/carveState.ts';
import { GameController, MESSAGES, type HudModel, type ViewPort } from '../../game/controller.ts';
import { buildDemoStage } from '../../game/demoStage.ts';
import { cellIndex, makeGrid } from '../../game/grid.ts';
import type { SolveHooks } from '../backend.ts';
import { SolverClient, type WorkerPort } from '../client.ts';
import { SolverHost, type HostOptions } from '../host.ts';
import { MockBackend } from '../mockBackend.ts';
import type { FemWasmModule, StepStatus, WasmSession } from './femWasm.ts';
import * as stub from './femWasmStub.ts';
import { backendFromUrl } from './options.ts';
import {
  FIRST_CHUNK,
  MAX_CHUNK,
  WasmBackend,
  chunkSize,
  wasmBackendFactory,
  wasmWithFallback,
  type FemWasmLoader,
  type WasmBackendOptions,
} from './wasmBackend.ts';

const REPO = new URL('../../../../../', import.meta.url);
const WASM_FILE = fileURLToPath(new URL('crates/fem-wasm/pkg/fem_wasm_bg.wasm', REPO));
const PKG_BUILT = existsSync(WASM_FILE) && existsSync(fileURLToPath(new URL('crates/fem-wasm/pkg/fem_wasm.js', REPO)));

const results = (out: FromWorker[]) => out.filter((m): m is ResultMsg => m.type === 'result');
const progresses = (out: FromWorker[]) => out.filter((m): m is ProgressMsg => m.type === 'progress');
const mockFactory = () => (stage: Stage) => Promise.resolve(new MockBackend(stage, { steps: 2 }));

function hostWith(factory: ReturnType<typeof wasmBackendFactory>, opts: HostOptions = {}) {
  const out: FromWorker[] = [];
  const transfers: Transferable[][] = [];
  const host = new SolverHost(
    (msg, transfer) => {
      // like a real postMessage: transferred buffers are detached, so a result array that
      // aliased WASM memory or was transferred twice would throw here
      out.push(structuredClone(msg, { transfer }));
      transfers.push(transfer);
    },
    () => factory,
    opts,
  );
  return { host, out, transfers };
}

// --- fake Session: chunk loop, cancellation, progress, flags --------------------------

class FakeSession implements WasmSession {
  readonly elements = 4;
  readonly nodes = 18;
  readonly levels = 0;
  calls: number[] = [];
  freed = 0;
  private iterations = 0;
  private dirty = true;

  constructor(
    /** iterations until done */
    private readonly needed: number,
    /** residual once done (> tol = mechanism / stall) */
    private readonly finalResidual = 1e-6,
    /** simulated clock, advanced by `msPerIter` per iteration */
    private readonly clock = { t: 0, msPerIter: 0.5 },
  ) {}

  set_solid(): void {
    this.dirty = true;
  }
  begin(): void {
    this.iterations = 0;
    this.dirty = false;
  }
  iterate(maxIters: number): StepStatus {
    if (this.dirty) this.begin();
    this.calls.push(maxIters);
    const n = Math.min(maxIters, this.needed - this.iterations);
    this.iterations += n;
    this.clock.t += n * this.clock.msPerIter;
    const done = this.iterations >= this.needed;
    return { case: 0, iterations: this.iterations, rel_residual: done ? this.finalResidual : 1 / (1 + this.iterations), done };
  }
  case_count(): number {
    return 1;
  }
  case_name(): string {
    return 'default';
  }
  utilization(): Float32Array {
    return new Float32Array(this.elements).fill(this.iterations);
  }
  displacement(): Float32Array {
    return new Float32Array(3 * this.nodes);
  }
  judged_max_utilization(): number {
    return 0.5;
  }
  load_displacement(): number {
    return 1e-4;
  }
  floating(): Uint32Array {
    return new Uint32Array(0);
  }
  loads_connected(): boolean {
    return true;
  }
  free(): void {
    this.freed++;
  }
}

function fakeHooks(over: Partial<SolveHooks> = {}) {
  const progress: { iteration: number; relResidual: number; utilization: Float32Array }[] = [];
  let yields = 0;
  const hooks: SolveHooks = {
    cancelled: () => false,
    progressDue: () => false,
    progress: (iteration, relResidual, utilization) => progress.push({ iteration, relResidual, utilization }),
    yield: async () => {
      yields++;
    },
    ...over,
  };
  return { hooks, progress, yields: () => yields };
}

describe('WasmBackend chunk loop (fake Session)', () => {
  it('sizes chunks from the measured cost per iteration', () => {
    expect(chunkSize(0)).toBe(FIRST_CHUNK);
    expect(chunkSize(Number.NaN)).toBe(FIRST_CHUNK);
    expect(chunkSize(0.1, 8)).toBe(80);
    expect(chunkSize(50, 8)).toBe(1);
    expect(chunkSize(1e-9, 8)).toBe(MAX_CHUNK);

    const clock = { t: 0, msPerIter: 0.5 };
    const session = new FakeSession(40, 1e-6, clock);
    const backend = new WasmBackend(session, 1e-4, { now: () => clock.t, chunkTargetMs: 8 });
    const { hooks, yields } = fakeHooks();
    return backend.solve(hooks).then((out) => {
      // iterate(0) = implicit begin, then FIRST_CHUNK, then 8 ms / 0.5 ms = 16 per chunk
      expect(session.calls).toEqual([0, FIRST_CHUNK, 16, 16]);
      expect(yields()).toBe(3); // once up front, then between chunks (not after the last)
      expect(backend.msPerIter).toBeCloseTo(0.5);
      expect(out).toMatchObject({ converged: true, iterations: 40, relResidual: 1e-6, loadsConnected: true });
      expect(out!.cases).toHaveLength(1);
      expect(out!.cases[0]).toMatchObject({ name: 'default', maxUtilization: 0.5, loadDisplacement: 1e-4 });
    });
  });

  it('posts progress (case 0 utilisation, cumulative iterations) only when due', async () => {
    const clock = { t: 0, msPerIter: 1 };
    const session = new FakeSession(30, 1e-6, clock);
    const backend = new WasmBackend(session, 1e-4, { now: () => clock.t, chunkTargetMs: 8 });
    let due = false;
    const { hooks, progress } = fakeHooks({ progressDue: () => (due = !due) });
    await backend.solve(hooks);
    // chunks end at 8, 16, 24, 30 (done → no progress); due on every other check
    expect(progress.map((p) => p.iteration)).toEqual([8, 24]);
    expect(progress[0]!.utilization).toEqual(new Float32Array(4).fill(8));
    expect(progress[0]!.relResidual).toBeCloseTo(1 / 9);
  });

  it('a request already waiting before the first chunk skips the solve entirely', async () => {
    const session = new FakeSession(100);
    const backend = new WasmBackend(session, 1e-4, { now: () => 0 });
    let yielded = 0;
    const { hooks } = fakeHooks({ cancelled: () => yielded > 0, yield: async () => void yielded++ });
    expect(await backend.solve(hooks)).toBeNull();
    expect(session.calls).toEqual([]);
  });

  it('returns null at the next chunk boundary once a newer request is waiting', async () => {
    const session = new FakeSession(100);
    const backend = new WasmBackend(session, 1e-4, { now: () => 0 });
    let yielded = 0;
    const { hooks } = fakeHooks({ cancelled: () => yielded > 1, yield: async () => void yielded++ });
    expect(await backend.solve(hooks)).toBeNull();
    expect(session.calls).toEqual([0, FIRST_CHUNK]);
    // an unchanged solid set continues the interrupted solve instead of restarting it
    const again = await backend.solve(fakeHooks().hooks);
    expect(again!.iterations).toBe(100);
    // [0, 8 | 0, then only the remaining 92 iterations in chunks of 8]
    expect(session.calls.length).toBe(3 + Math.ceil(92 / FIRST_CHUNK));
  });

  it('done with a large residual (mechanism / stall) is not converged', async () => {
    const backend = new WasmBackend(new FakeSession(5, 0.3), 1e-4, { now: () => 0 });
    const out = await backend.solve(fakeHooks().hooks);
    expect(out).toMatchObject({ converged: false, relResidual: 0.3 });
  });

  it('reports info from the session and frees it once', () => {
    const session = new FakeSession(1);
    const backend = new WasmBackend(session, 1e-4);
    expect(backend.info).toEqual({ backend: 'wasm', elements: 4, nodes: 18, levels: 0 });
    backend.dispose();
    backend.dispose();
    expect(session.freed).toBe(1);
  });
});

// --- selection, fallback, URL option, HUD notice ------------------------------------

describe('backend selection and fallback', () => {
  const failing: FemWasmLoader = () => Promise.reject(new Error('no wasm here'));

  it('?backend= picks mock or wasm; anything else means the default', () => {
    expect(backendFromUrl('?backend=mock')).toEqual({ backend: 'mock' });
    expect(backendFromUrl('?stage=w1-01&backend=wasm')).toEqual({ backend: 'wasm' });
    expect(backendFromUrl('?backend=gpu')).toEqual({});
    expect(backendFromUrl('')).toEqual({});
  });

  it('falls back to the mock when the package fails to load', async () => {
    const reasons: unknown[] = [];
    const { host, out } = hostWith(wasmWithFallback(mockFactory(), failing, (e) => reasons.push(e)));
    host.receive({ type: 'init', stage: buildDemoStage() });
    await host.idle();
    expect(out[0]).toMatchObject({ type: 'ready', backend: 'mock' });
    expect(results(out)).toHaveLength(1);
    expect(String(reasons[0])).toContain('no wasm here');
  });

  it('forced wasm reports a load failure as an error instead of falling back', async () => {
    const { host, out } = hostWith(wasmBackendFactory(failing));
    host.receive({ type: 'init', stage: buildDemoStage() });
    await host.idle();
    expect(out).toEqual([{ type: 'error', seq: undefined, message: 'no wasm here' }]);
  });

  it('a stage the solver rejects is an error, not a silent fallback', async () => {
    const rejecting = {
      default: () => Promise.resolve(),
      initSync: () => undefined,
      Session: stub.Session, // throws like a bad stage would
    } satisfies FemWasmModule;
    const { host, out } = hostWith(wasmWithFallback(mockFactory(), () => Promise.resolve(rejecting), () => {}));
    host.receive({ type: 'init', stage: buildDemoStage() });
    await host.idle();
    expect(out).toEqual([{ type: 'error', seq: undefined, message: stub.FEM_WASM_MISSING }]);
  });

  it('the stub (package not built) fails with a clear message', async () => {
    await expect(stub.default()).rejects.toThrow('pnpm build:wasm');
    expect(() => stub.initSync()).toThrow('pnpm build:wasm');
  });

  it('the HUD shows a notice when the worker fell back to the mock', () => {
    const notice = (requested: 'wasm' | 'mock' | undefined, got: 'wasm' | 'mock') => {
      const port: WorkerPort = { postMessage() {}, onmessage: null, onerror: null, terminate() {} };
      const client = new SolverClient(port);
      const hud = newHud();
      const view: ViewPort = {
        solidChanged() {},
        setUtilization() {},
        setResult() {},
        elementsRemoved() {},
        showBrush() {},
      };
      new GameController(new CarveState(buildDemoStage()), client, view, hud, requested ? { backend: requested } : {});
      client.receive({ type: 'ready', backend: got, elements: 768, nodes: 1125, levels: 0 });
      return hud.toast?.text ?? null;
    };
    expect(notice(undefined, 'mock')).toBe(MESSAGES.wasmFallback);
    expect(notice('mock', 'mock')).toBeNull();
    expect(notice(undefined, 'wasm')).toBeNull();
  });
});

function newHud(): HudModel {
  return {
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
  };
}

// --- the real fem-wasm package through the worker message handler ---------------------

const SKIP_REASON = 'skipped: crates/fem-wasm/pkg is not built (run `pnpm build:wasm`)';
if (!PKG_BUILT) console.warn(`[T-205] real-WASM backend tests ${SKIP_REASON}`);

describe.skipIf(!PKG_BUILT)(`WASM backend through SolverHost (real fem-wasm)${PKG_BUILT ? '' : ` — ${SKIP_REASON}`}`, () => {
  let mod: FemWasmModule;
  const load: FemWasmLoader = () => Promise.resolve(mod);

  beforeAll(async () => {
    mod = await import('fem-wasm');
    mod.initSync({ module: readFileSync(WASM_FILE) });
  });

  const setup = (opts: HostOptions = {}, backendOpts?: WasmBackendOptions) =>
    hostWith(wasmBackendFactory(load, backendOpts), opts);

  /** solve a stage from scratch with a bare Session (reference for warm-started solves) */
  function coldSolve(stage: Stage): { util: Float32Array; max: number } {
    const s = new mod.Session(JSON.stringify(stage), '{}');
    try {
      let st = s.iterate(1000);
      while (!st.done) st = s.iterate(1000);
      return { util: s.utilization(0), max: s.judged_max_utilization(0) };
    } finally {
      s.free();
    }
  }

  const demo = buildDemoStage();
  const g = makeGrid(demo.grid);
  /** the demo beam's full cross-section at x = 10, split into two halves */
  const cut: [number[], number[]] = [[], []];
  for (let y = 0; y < 8; y++) for (let z = 0; z < 4; z++) cut[y < 4 ? 0 : 1].push(cellIndex(g, 10, y, z));

  it('init replies ready (wasm, multigrid) then a converged result for seq 0', async () => {
    const { host, out, transfers } = setup();
    host.receive({ type: 'init', stage: demo });
    await host.idle();
    expect(out[0]).toMatchObject({ type: 'ready', backend: 'wasm', elements: 768, nodes: 25 * 9 * 5 });
    expect((out[0] as { levels: number }).levels).toBeGreaterThan(0);
    const [r] = results(out);
    expect(r).toMatchObject({ seq: 0, converged: true, loadsConnected: true });
    expect(r!.relResidual).toBeLessThanOrEqual(1e-4);
    const c = r!.cases[0]!;
    expect(c.utilization).toHaveLength(768);
    expect(c.displacement).toHaveLength(3 * 25 * 9 * 5);
    expect(c.utilization.every(Number.isFinite)).toBe(true);
    expect(c.maxUtilization).toBeGreaterThan(0);
    expect(c.loadDisplacement).toBeGreaterThan(0);
    // the loaded top edge of the free end moves down, along the force
    expect(c.displacement[3 * (24 + 25 * 8) + 1]).toBeLessThan(0);
    expect(r!.floating).toHaveLength(0);
    expect(transfers.at(-1)).toHaveLength(3);
  });

  it('a warm-started carve matches a cold solve of the carved geometry', async () => {
    const { host, out } = setup();
    host.receive({ type: 'init', stage: demo });
    const carved: number[] = [];
    for (let x = 11; x < 14; x++) for (let z = 0; z < 3; z++) carved.push(cellIndex(g, x, 7, z));
    host.receive({ type: 'carve', seq: 1, removed: carved, restored: [] });
    await host.idle();
    const r = results(out).at(-1)!;
    expect(r).toMatchObject({ seq: 1, converged: true });
    const solid = new Uint8Array(768).fill(1);
    for (const e of carved) solid[e] = 0;
    const ref = coldSolve({ ...demo, solid: encodeBitmask(solid) });
    expect(r.cases[0]!.maxUtilization).toBeCloseTo(ref.max, 3);
    for (const e of carved) expect(r.cases[0]!.utilization[e]).toBe(0);
    let worst = 0;
    ref.util.forEach((u, e) => (worst = Math.max(worst, Math.abs(u - r.cases[0]!.utilization[e]!))));
    expect(worst / ref.max).toBeLessThan(1e-2);
  });

  it('a newer carve supersedes the queued solve, but every diff is applied', async () => {
    const { host, out } = setup();
    host.receive({ type: 'init', stage: demo });
    await host.idle();
    out.length = 0;
    host.receive({ type: 'carve', seq: 1, removed: cut[0], restored: [] });
    host.receive({ type: 'carve', seq: 2, removed: cut[1], restored: [] });
    await host.idle();
    const r = results(out);
    expect(r.map((m) => m.seq)).toEqual([2]);
    expect(r[0]!.loadsConnected).toBe(false);
    expect(r[0]!.floating).toHaveLength(13 * 8 * 4);
  });

  it('progress: a Jacobi solve posts case-0 snapshots for its seq, then the result', async () => {
    const { host, out } = setup({}, { chunkTargetMs: 0.05 });
    host.receive({ type: 'init', stage: demo, options: { preconditioner: 'jacobi', progressEveryMs: 0 } });
    await host.idle();
    expect(out[0]).toMatchObject({ type: 'ready', backend: 'wasm', levels: 0 });
    const p = progresses(out);
    expect(p.length).toBeGreaterThanOrEqual(2);
    expect(p.every((m) => m.seq === 0 && m.utilization.length === 768)).toBe(true);
    expect(p.every((m) => m.relResidual > 1e-4)).toBe(true);
    for (let i = 1; i < p.length; i++) expect(p[i]!.iteration).toBeGreaterThan(p[i - 1]!.iteration);
    const r = results(out);
    expect(r).toHaveLength(1);
    expect(out.at(-1)).toBe(r[0]);
    expect(r[0]).toMatchObject({ seq: 0, converged: true });
    expect(r[0]!.iterations).toBeGreaterThan(p.at(-1)!.iteration);
  });

  it('a burst of carves delivered one task apart is solved once, for the newest seq', async () => {
    const { host, out } = setup();
    host.receive({ type: 'init', stage: demo });
    await host.idle();
    out.length = 0;
    // like worker messages: each carve arrives as its own event-loop task
    host.receive({ type: 'carve', seq: 1, removed: [cellIndex(g, 12, 7, 0)], restored: [] });
    setTimeout(() => host.receive({ type: 'carve', seq: 2, removed: [cellIndex(g, 13, 7, 0)], restored: [] }), 0);
    setTimeout(() => host.receive({ type: 'carve', seq: 3, removed: [cellIndex(g, 14, 7, 0)], restored: [] }), 0);
    await new Promise((r) => setTimeout(r, 5));
    await host.idle();
    expect(results(out).map((m) => m.seq)).toEqual([3]);
    expect(results(out)[0]!.converged).toBe(true);
  });

  /** host yield that runs `inject` once, on the `nth` yield (1 = before the first chunk) */
  const injectOnYield = (nth: number, inject: () => void) => {
    let n = 0;
    return async () => {
      if (++n === nth) inject();
      await new Promise((r) => setTimeout(r, 0));
    };
  };

  it('a carve arriving mid-solve cancels it at the next chunk', async () => {
    let injected = false; // the 2nd yield follows the first Jacobi chunk (8 of ~140 iterations)
    const ctx = setup({
      yieldFn: injectOnYield(2, () => {
        injected = true;
        ctx.host.receive({ type: 'carve', seq: 1, removed: [cellIndex(g, 12, 7, 0)], restored: [] });
      }),
    });
    ctx.host.receive({ type: 'init', stage: demo, options: { preconditioner: 'jacobi' } });
    await ctx.host.idle();
    expect(injected).toBe(true);
    expect(results(ctx.out).map((m) => m.seq)).toEqual([1]);
    expect(results(ctx.out)[0]!.converged).toBe(true);
  });

  it('cancel mid-solve posts no result; the next request continues the solve', async () => {
    const ctx = setup({ yieldFn: injectOnYield(2, () => ctx.host.receive({ type: 'cancel' })) });
    ctx.host.receive({ type: 'init', stage: demo, options: { preconditioner: 'jacobi' } });
    await ctx.host.idle();
    expect(ctx.out.map((m) => m.type)).toEqual(['ready']);
    // same solid set → nothing to apply → the interrupted solve finishes
    ctx.host.receive({ type: 'setSolid', seq: 1, solid: demo.solid });
    await ctx.host.idle();
    expect(results(ctx.out)).toHaveLength(1);
    expect(results(ctx.out)[0]).toMatchObject({ seq: 1, converged: true });
  });

  it('setSolid round trip: cut, then restore gives the cold solution back', async () => {
    const { host, out } = setup();
    host.receive({ type: 'init', stage: demo });
    await host.idle();
    const cold = results(out)[0]!.cases[0]!.maxUtilization;
    const solid = new Uint8Array(768).fill(1);
    for (const e of [...cut[0], ...cut[1]]) solid[e] = 0;
    host.receive({ type: 'setSolid', seq: 1, solid: encodeBitmask(solid) });
    await host.idle();
    expect(results(out).at(-1)).toMatchObject({ seq: 1, loadsConnected: false });
    host.receive({ type: 'setSolid', seq: 2, solid: demo.solid });
    await host.idle();
    const r = results(out).at(-1)!;
    expect(r).toMatchObject({ seq: 2, converged: true, loadsConnected: true });
    expect(r.cases[0]!.maxUtilization).toBeCloseTo(cold, 3);
  });

  it('carving a protected cell is an error for that seq; the session stays usable', async () => {
    const { host, out } = setup();
    host.receive({ type: 'init', stage: demo });
    host.receive({ type: 'carve', seq: 1, removed: [cellIndex(g, 0, 3, 1)], restored: [] }); // clamped face
    await host.idle();
    const err = out.find((m) => m.type === 'error');
    expect(err).toMatchObject({ type: 'error', seq: 1 });
    host.receive({ type: 'carve', seq: 2, removed: [cellIndex(g, 12, 7, 0)], restored: [] });
    await host.idle();
    expect(results(out).at(-1)).toMatchObject({ seq: 2, converged: true });
  });

  // Committed W1/W2 stages: cold solve + five 3×3 top-surface carves, timed through the host.
  const STAGE_IDS = ['w1-01', 'w2-01'];
  for (const id of STAGE_IDS) {
    const file = fileURLToPath(new URL(`stages/${id}.json`, REPO));
    it.skipIf(!existsSync(file))(`${id}: converged cold solve and 3×3 carves`, async () => {
      const stage = JSON.parse(readFileSync(file, 'utf8')) as Stage;
      const state = new CarveState(stage);
      const sg = state.grid;
      const { host, out } = setup();
      const t0 = performance.now();
      host.receive({ type: 'init', stage });
      await host.idle();
      const loadMs = performance.now() - t0;
      const ready = out[0] as { levels: number };
      const cold = results(out)[0]!;
      expect(cold).toMatchObject({ seq: 0, converged: true, loadsConnected: true });
      const max0 = cold.cases[0]!.maxUtilization;
      expect(max0).toBeGreaterThan(0);
      expect(max0).toBeLessThan(1);

      const top = sg.ny - 1;
      const z0 = Math.max(0, Math.floor(sg.nz / 2) - 1);
      const times: { ms: number; it: number }[] = [];
      for (let k = 0; k < 5; k++) {
        const x0 = 5 + 3 * k;
        const cells: number[] = [];
        for (let x = x0; x < x0 + 3; x++)
          for (let z = z0; z < Math.min(sg.nz, z0 + 3); z++) {
            const e = cellIndex(sg, x, top, z);
            if (state.solid[e] && !state.keep[e]) cells.push(e);
          }
        expect(cells.length).toBeGreaterThan(0);
        host.receive({ type: 'carve', seq: k + 1, removed: cells, restored: [] });
        await host.idle();
        const r = results(out).at(-1)!;
        expect(r).toMatchObject({ seq: k + 1, converged: true });
        expect(r.cases[0]!.maxUtilization).toBeGreaterThan(0);
        times.push({ ms: r.elapsedMs, it: r.iterations });
      }
      const sorted = times.map((t) => t.ms).sort((a, b) => a - b);
      console.log(
        `[T-205] ${id} ${sg.nx}×${sg.ny}×${sg.nz} levels ${ready.levels}: load+cold ${loadMs.toFixed(1)} ms ` +
          `(${cold.iterations} it, max util ${max0.toFixed(3)}); carve median ${sorted[2]!.toFixed(1)} / ` +
          `max ${sorted[4]!.toFixed(1)} ms (it ${times.map((t) => t.it).join(',')})`,
      );
    });
  }
});
