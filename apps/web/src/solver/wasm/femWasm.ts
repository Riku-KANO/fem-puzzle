// Typed view of the `fem-wasm` package (crates/fem-wasm/pkg, built by `pnpm build:wasm`,
// git-ignored) — only the part of the `Session` API (docs/specs/worker-protocol.md) the
// backend uses.
//
// The `fem-wasm` specifier is resolved by `vite.config.ts` (alias) and `tsconfig.json`
// (paths) to the real package when it has been built, else to `femWasmStub.ts`, so
// svelte-check, vitest and `vite build` never need wasm-pack. The typed assignment in
// `loadFemWasm` checks the real package's `.d.ts` against these interfaces whenever pkg/
// exists.

/** `Session.iterate` result (a plain object). */
export interface StepStatus {
  /** load case being solved (the last one once `done`) */
  case: number;
  /** PCG iterations since the last `begin()`, summed over all load cases */
  iterations: number;
  /** ‖r‖ / ‖Mf‖ of `case`; once `done`, the maximum over all cases */
  rel_residual: number;
  /** every case converged or stopped; converged ⇔ done && rel_residual <= tol */
  done: boolean;
}

export interface WasmSession {
  readonly elements: number;
  readonly nodes: number;
  readonly levels: number;
  /** throws (and applies nothing) on protected / out-of-domain / out-of-range cells */
  set_solid(indices: Uint32Array, solid: boolean): void;
  begin(): void;
  /** at most `maxIters` iterations; begins implicitly when the solid set changed */
  iterate(maxIters: number): StepStatus;
  case_count(): number;
  case_name(caseIdx: number): string;
  /** fresh copies (own buffers, safe to transfer) */
  utilization(caseIdx: number): Float32Array;
  displacement(caseIdx: number): Float32Array;
  judged_max_utilization(caseIdx: number): number;
  load_displacement(caseIdx: number): number;
  floating(): Uint32Array;
  loads_connected(): boolean;
  /** release the WASM-side memory */
  free(): void;
}

export interface FemWasmModule {
  /** async init: fetches `fem_wasm_bg.wasm` next to the JS glue (browser) */
  default(): Promise<unknown>;
  /** sync init from bytes (Node / tests) */
  initSync(input: { module: BufferSource | WebAssembly.Module }): unknown;
  Session: new (stageJson: string, optionsJson: string) => WasmSession;
}

let loading: Promise<FemWasmModule> | null = null;

/**
 * Load and instantiate the package once per worker. A failure is not cached, so the next
 * `init` (e.g. another stage) tries again.
 */
export function loadFemWasm(): Promise<FemWasmModule> {
  loading ??= (async () => {
    const mod: FemWasmModule = await import('fem-wasm');
    await mod.default();
    return mod;
  })().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}
