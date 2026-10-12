// Backend choice from the page URL (`?backend=mock|wasm`). Read on the main thread (a
// dedicated worker cannot see the page URL) and sent as `SolverOptionsMsg.backend`:
//   (absent)  WASM, falling back to the mock if the .wasm cannot be loaded
//   wasm      WASM only — a load failure is reported as a solver error (e2e, benchmarks)
//   mock      the JS mock backend

import type { SolverOptionsMsg } from '@stress-carve/protocol';

export function backendFromUrl(search: string): Pick<SolverOptionsMsg, 'backend'> {
  const v = new URLSearchParams(search).get('backend');
  return v === 'mock' || v === 'wasm' ? { backend: v } : {};
}
