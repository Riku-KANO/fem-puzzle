# Worker protocol & WASM binding (contract)

> **Contract file.** Types live in `packages/protocol/src/worker.ts`; the WASM side is
> `crates/fem-wasm`. The web app talks to the solver **only** through these messages,
> so a mock backend (`apps/web/src/solver/mockBackend.ts`) and the WASM backend are
> interchangeable.

## Threads

```
main thread (Svelte UI + Three.js)  ──postMessage──▶  solver worker (fem-wasm)
        ▲                                                   │
        └────────── progress / result (transferables) ◀─────┘
```

The main thread sends only **diffs** (changed voxel indices). Every request carries a
monotonically increasing `seq`; the worker drops work for an older `seq` as soon as a
newer request arrives (it checks between `iterate` chunks), and the UI ignores
messages whose `seq` is older than the latest it sent.

## Messages

Main → worker (`ToWorker`):

| type | fields | meaning |
| --- | --- | --- |
| `init` | `stage: Stage`, `options?: SolverOptionsMsg` | build the problem; replies `ready` then a `result` for seq 0 |
| `carve` | `seq`, `removed: number[]`, `restored: number[]` | apply a diff, then re-solve (warm start) |
| `setSolid` | `seq`, `solid: string` (bitmask) | replace the whole solid set (undo-to-start, sandbox) |
| `cancel` | – | stop the current solve |

Worker → main (`FromWorker`):

| type | fields |
| --- | --- |
| `ready` | `elements`, `nodes`, `backend: 'wasm' \| 'mock'`, `levels` (MG levels, 0 = Jacobi) |
| `progress` | `seq`, `iteration`, `relResidual`, `utilization: Float32Array` (per element) |
| `result` | `SolveResultMsg` (below) |
| `error` | `seq?`, `message` |

`SolveResultMsg`:

```ts
{
  type: 'result', seq, converged, iterations, relResidual, elapsedMs,
  cases: Array<{
    name: string,
    utilization: Float32Array,   // per element, 0 for inactive
    displacement: Float32Array,  // per node xyz, length 3*(nx+1)(ny+1)(nz+1)
    maxUtilization: number,      // judged: active & !keep
    loadDisplacement: number,    // m
  }>,
  floating: Uint32Array,         // solid elements not connected to any support
  loadsConnected: boolean,
}
```

Progress messages are posted every ~`progressEveryMs` (default 60 ms) during a solve so
the colour map visibly "settles" (design doc: 逐次表示).

## WASM binding (`crates/fem-wasm`, wasm-bindgen)

```ts
class Session {
  constructor(stageJson: string, optionsJson: string);   // throws on bad stage
  readonly elements: number; readonly nodes: number; readonly levels: number;
  set_solid(indices: Uint32Array, solid: boolean): void;
  begin(): void;
  iterate(maxIters: number): StepStatus;                    // {case, iterations, rel_residual, done}
  case_count(): number; case_name(i: number): string;
  utilization(caseIdx: number): Float32Array;
  displacement(caseIdx: number): Float32Array;
  judged_max_utilization(caseIdx: number): number;
  load_displacement(caseIdx: number): number;
  floating(): Uint32Array;
  loads_connected(): boolean;
}
```

Built with `wasm-pack build crates/fem-wasm --release --target web` (`pnpm build:wasm`).
The output `crates/fem-wasm/pkg/` is git-ignored; `apps/web` resolves it through the
Vite/TS alias `fem-wasm` → `crates/fem-wasm/pkg/fem_wasm.js`. The mock backend keeps
the web app runnable (and its tests green) when the package has not been built.
