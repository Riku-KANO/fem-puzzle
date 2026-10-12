// Backend selection inside the worker. T-205 adds the WASM backend here
// (`options.backend` / `?backend=` with fallback to the mock).

import type { SolverOptionsMsg } from '@stress-carve/protocol';
import type { BackendFactory } from './backend.ts';
import { MockBackend } from './mockBackend.ts';

/** Mock latency per simulated iteration chunk in the browser, so progress is visible. */
const MOCK_STEP_DELAY_MS = 16;

export function selectBackendFactory(options: SolverOptionsMsg): BackendFactory {
  void options; // only the mock exists so far
  return (stage, opts) =>
    Promise.resolve(new MockBackend(stage, { ...opts, stepDelayMs: MOCK_STEP_DELAY_MS }));
}
