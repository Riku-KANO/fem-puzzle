// Solver backend interface — what runs inside the worker behind the protocol in
// docs/specs/worker-protocol.md. `mockBackend.ts` (JS heuristic) implements it today;
// the WASM backend (T-205, `src/solver/wasm/`) wraps `fem-wasm`'s `Session` the same way.
//
// The worker host (`host.ts`) owns everything protocol-related: message queueing, `seq`
// bookkeeping, cancellation, progress throttling, timing and transferables. A backend only
// knows how to mutate its solid set and how to solve it progressively.

import type { ResultMsg, SolverOptionsMsg, Stage } from '@stress-carve/protocol';

export interface BackendInfo {
  backend: 'wasm' | 'mock';
  /** element count nx*ny*nz */
  elements: number;
  /** node count (nx+1)(ny+1)(nz+1) */
  nodes: number;
  /** multigrid levels; 0 = Jacobi PCG (the mock reports 0) */
  levels: number;
}

/** Callbacks the host hands to `Backend.solve`. */
export interface SolveHooks {
  /**
   * True once a newer request (or `cancel`) is waiting. Check between iteration chunks and
   * return `null` promptly — the host will apply the new diff and start a fresh solve.
   */
  cancelled(): boolean;
  /** True when a `progress` snapshot is due (every `progressEveryMs`, default 60 ms). */
  progressDue(): boolean;
  /**
   * Post an intermediate snapshot. `utilization` is per element for load case 0 and is
   * transferred to the main thread (pass a fresh array, do not reuse it).
   */
  progress(iteration: number, relResidual: number, utilization: Float32Array): void;
  /** Yield to the worker event loop so newer messages can be received. */
  yield(): Promise<void>;
}

/** A finished solve: `ResultMsg` without the fields the host fills in. */
export type SolveOutput = Omit<ResultMsg, 'type' | 'seq' | 'elapsedMs'>;

export interface Backend {
  readonly info: BackendInfo;
  /**
   * Mark elements solid (`true`) or empty (`false`) — maps to `Session.set_solid`.
   * The host calls this only between solves, never while `solve` is pending.
   */
  setSolid(indices: Uint32Array, solid: boolean): void;
  /**
   * Solve the current solid set (warm start from the previous solution), posting progress
   * through `hooks`. Resolves `null` if `hooks.cancelled()` became true. Typed arrays in the
   * output are transferred to the main thread, so they must not be retained or reused.
   */
  solve(hooks: SolveHooks): Promise<SolveOutput | null>;
  /** Free native resources (WASM memory). The backend is not used afterwards. */
  dispose(): void;
}

/** Builds a backend for a stage; may load code lazily (e.g. the `.wasm`). Throws on bad stages. */
export type BackendFactory = (stage: Stage, options: SolverOptionsMsg) => Promise<Backend>;
