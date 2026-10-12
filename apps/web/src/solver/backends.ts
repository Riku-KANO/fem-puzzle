// Backend selection inside the worker (`SolverOptionsMsg.backend`, set from `?backend=` by
// the main thread — see `wasm/options.ts`): absent → WASM with automatic fallback to the
// mock if the .wasm cannot be loaded; 'wasm' → WASM only; 'mock' → the JS mock.

import type { SolverOptionsMsg } from '@stress-carve/protocol';
import type { BackendFactory } from './backend.ts';
import { MockBackend } from './mockBackend.ts';
import { wasmBackendFactory, wasmWithFallback } from './wasm/wasmBackend.ts';

/** Mock latency per simulated iteration chunk in the browser, so progress is visible. */
const MOCK_STEP_DELAY_MS = 16;

export function selectBackendFactory(options: SolverOptionsMsg): BackendFactory {
  const mock: BackendFactory = (stage, opts) =>
    Promise.resolve(new MockBackend(stage, { ...opts, stepDelayMs: MOCK_STEP_DELAY_MS }));
  switch (options.backend) {
    case 'mock':
      return mock;
    case 'wasm':
      return wasmBackendFactory();
    default:
      return wasmWithFallback(mock);
  }
}
