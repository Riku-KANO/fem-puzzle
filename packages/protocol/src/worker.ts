// Main thread <-> solver worker messages. Normative spec: docs/specs/worker-protocol.md

import type { Bitmask, Stage } from './stage.ts';

export interface SolverOptionsMsg {
  /** relative residual target (default 1e-4 in the game) */
  tol?: number;
  maxIters?: number;
  preconditioner?: 'jacobi' | 'multigrid';
  /** how often to post `progress` during a solve (default 60 ms) */
  progressEveryMs?: number;
  /** force the JS mock backend (tests, or when WASM is unavailable) */
  backend?: 'wasm' | 'mock';
}

// --- main -> worker ---------------------------------------------------------

export interface InitMsg {
  type: 'init';
  stage: Stage;
  options?: SolverOptionsMsg;
}

export interface CarveMsg {
  type: 'carve';
  seq: number;
  removed: number[];
  restored: number[];
}

export interface SetSolidMsg {
  type: 'setSolid';
  seq: number;
  solid: Bitmask;
}

export interface CancelMsg {
  type: 'cancel';
}

export type ToWorker = InitMsg | CarveMsg | SetSolidMsg | CancelMsg;

// --- worker -> main ---------------------------------------------------------

export interface ReadyMsg {
  type: 'ready';
  elements: number;
  nodes: number;
  backend: 'wasm' | 'mock';
  /** multigrid levels; 0 = Jacobi PCG */
  levels: number;
}

export interface ProgressMsg {
  type: 'progress';
  seq: number;
  iteration: number;
  relResidual: number;
  /** per element, case 0 */
  utilization: Float32Array;
}

export interface CaseResult {
  name: string;
  /** per element, 0 for inactive */
  utilization: Float32Array;
  /** per node xyz, length 3 * nodeCount(grid) */
  displacement: Float32Array;
  /** judged maximum (active & !keep) */
  maxUtilization: number;
  /** max |u| over load-cell nodes (m) */
  loadDisplacement: number;
}

export interface ResultMsg {
  type: 'result';
  seq: number;
  converged: boolean;
  iterations: number;
  relResidual: number;
  elapsedMs: number;
  cases: CaseResult[];
  /** solid elements not connected to any support */
  floating: Uint32Array;
  loadsConnected: boolean;
}

export interface ErrorMsg {
  type: 'error';
  seq?: number;
  message: string;
}

export type FromWorker = ReadyMsg | ProgressMsg | ResultMsg | ErrorMsg;

/** Transferable buffers of a worker->main message (avoid copies). */
export function transferablesOf(msg: FromWorker): Transferable[] {
  switch (msg.type) {
    case 'progress':
      return [msg.utilization.buffer as ArrayBuffer];
    case 'result':
      return [
        msg.floating.buffer as ArrayBuffer,
        ...msg.cases.flatMap((c) => [c.utilization.buffer as ArrayBuffer, c.displacement.buffer as ArrayBuffer]),
      ];
    default:
      return [];
  }
}
