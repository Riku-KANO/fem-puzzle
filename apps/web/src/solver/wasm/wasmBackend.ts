// WASM backend: the real Hex8 FEM solver (`fem-wasm` `Session`) behind the `Backend`
// interface. The host (`../host.ts`) owns seq/cancel/progress throttling; this file only
// maps the protocol onto `set_solid` / `iterate(chunk)` / result readback.
//
// Solves run in time-boxed iteration chunks (~`CHUNK_TARGET_MS` each, sized from the
// measured cost per iteration and carried over between solves). Between chunks the backend
// checks for newer requests, posts a `progress` snapshot when one is due and yields to the
// worker event loop. With multigrid a W1/W2 solve usually fits into one or two chunks.

import type { SolverOptionsMsg, Stage } from '@stress-carve/protocol';
import type { Backend, BackendFactory, BackendInfo, SolveHooks, SolveOutput } from '../backend.ts';
import { loadFemWasm, type FemWasmModule, type StepStatus, type WasmSession } from './femWasm.ts';

/** The Session's own default tolerance (crates/fem-wasm/src/options.rs), to judge `converged`. */
export const DEFAULT_TOL = 1e-4;
/** Compute time per iteration chunk before checking for newer requests. */
export const CHUNK_TARGET_MS = 8;
/** Chunk size while the cost per iteration is still unknown. */
export const FIRST_CHUNK = 8;
export const MAX_CHUNK = 4096;

export interface WasmBackendOptions {
  now?: () => number;
  chunkTargetMs?: number;
}

export type FemWasmLoader = () => Promise<FemWasmModule>;

/** Iterations for the next chunk given the measured ms per iteration (0 = unknown). */
export function chunkSize(msPerIter: number, targetMs = CHUNK_TARGET_MS): number {
  if (!(msPerIter > 0)) return FIRST_CHUNK;
  return Math.min(MAX_CHUNK, Math.max(1, Math.floor(targetMs / msPerIter)));
}

export class WasmBackend implements Backend {
  readonly info: BackendInfo;
  /** smoothed cost of one iteration in ms (0 until measured) */
  msPerIter = 0;
  private disposed = false;
  private readonly now: () => number;
  private readonly targetMs: number;

  constructor(
    private readonly session: WasmSession,
    /** relative residual target the session was built with */
    private readonly tol: number,
    opts: WasmBackendOptions = {},
  ) {
    this.info = {
      backend: 'wasm',
      elements: session.elements,
      nodes: session.nodes,
      levels: session.levels,
    };
    this.now = opts.now ?? (() => performance.now());
    this.targetMs = opts.chunkTargetMs ?? CHUNK_TARGET_MS;
  }

  setSolid(indices: Uint32Array, solid: boolean): void {
    this.session.set_solid(indices, solid);
  }

  async solve(hooks: SolveHooks): Promise<SolveOutput | null> {
    const s = this.session;
    // iterate(0) runs the implicit begin() (active set, preconditioner, warm start) when
    // the solid set changed, without iterating — keeps that setup out of the per-iteration
    // estimate. Unchanged set after a cancelled solve: continues where it stopped.
    let st = s.iterate(0);
    while (!st.done) {
      if (hooks.cancelled()) return null;
      const before = st.iterations;
      const t0 = this.now();
      st = s.iterate(chunkSize(this.msPerIter, this.targetMs));
      this.measure(st.iterations - before, this.now() - t0);
      if (st.done) break;
      if (hooks.progressDue()) hooks.progress(st.iterations, st.rel_residual, s.utilization(0));
      await hooks.yield();
    }
    if (hooks.cancelled()) return null;
    return this.readResult(st);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.free();
  }

  private measure(iterations: number, ms: number): void {
    if (iterations <= 0) return;
    const sample = ms / iterations;
    this.msPerIter = this.msPerIter > 0 ? 0.5 * this.msPerIter + 0.5 * sample : sample;
  }

  private readResult(st: StepStatus): SolveOutput {
    const s = this.session;
    const cases: SolveOutput['cases'] = [];
    for (let c = 0; c < s.case_count(); c++) {
      cases.push({
        name: s.case_name(c),
        utilization: s.utilization(c),
        displacement: s.displacement(c),
        maxUtilization: s.judged_max_utilization(c),
        loadDisplacement: s.load_displacement(c),
      });
    }
    return {
      // a mechanism or a stalled CG stops with done = true but a large residual (solver.md)
      converged: st.done && st.rel_residual <= this.tol,
      iterations: st.iterations,
      relResidual: st.rel_residual,
      cases,
      floating: s.floating(),
      loadsConnected: s.loads_connected(),
    };
  }
}

/** Build a backend from a loaded package. Throws (with the solver's message) on a bad stage. */
export function createWasmBackend(
  mod: FemWasmModule,
  stage: Stage,
  options: SolverOptionsMsg,
  opts?: WasmBackendOptions,
): WasmBackend {
  const sessionOptions: SolverOptionsMsg = {};
  if (options.tol !== undefined) sessionOptions.tol = options.tol;
  if (options.maxIters !== undefined) sessionOptions.maxIters = options.maxIters;
  if (options.preconditioner !== undefined) sessionOptions.preconditioner = options.preconditioner;
  const session = new mod.Session(JSON.stringify(stage), JSON.stringify(sessionOptions));
  return new WasmBackend(session, options.tol ?? DEFAULT_TOL, opts);
}

/** WASM only: a load failure rejects, so the host replies with an `error`. */
export function wasmBackendFactory(load: FemWasmLoader = loadFemWasm, opts?: WasmBackendOptions): BackendFactory {
  return async (stage, options) => createWasmBackend(await load(), stage, options, opts);
}

/**
 * WASM when the package loads, else `fallback` (the mock; `ready.backend` tells the UI).
 * Only *loading* falls back — a stage the solver rejects is still reported as an error.
 */
export function wasmWithFallback(
  fallback: BackendFactory,
  load: FemWasmLoader = loadFemWasm,
  onFallback: (error: unknown) => void = warnFallback,
): BackendFactory {
  return async (stage, options) => {
    let mod: FemWasmModule;
    try {
      mod = await load();
    } catch (e) {
      onFallback(e);
      return fallback(stage, options);
    }
    return createWasmBackend(mod, stage, options);
  };
}

function warnFallback(error: unknown): void {
  console.warn('[solver] WASM backend unavailable, using the mock:', error);
}
