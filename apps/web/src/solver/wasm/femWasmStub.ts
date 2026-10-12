// Stand-in for the `fem-wasm` package while crates/fem-wasm/pkg has not been built (see
// femWasm.ts). Same export shape as the wasm-bindgen glue; every entry point fails with a
// clear message, so the worker falls back to the mock backend (or reports the error when
// `backend: 'wasm'` was forced).

import type { WasmSession } from './femWasm.ts';

export const FEM_WASM_MISSING = 'fem-wasm is not built (run `pnpm build:wasm`, then restart Vite)';

// The wasm-bindgen glue's async init is its default export; mirror it (the one non-Svelte
// default export in the app, required by the module shape).
export default function init(): Promise<never> {
  return Promise.reject(new Error(FEM_WASM_MISSING));
}

export function initSync(): never {
  throw new Error(FEM_WASM_MISSING);
}

export const Session = class {
  constructor() {
    throw new Error(FEM_WASM_MISSING);
  }
} as unknown as new (stageJson: string, optionsJson: string) => WasmSession;
