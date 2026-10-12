// Solver worker entry (module worker). All logic lives in `host.ts`; this file only binds it
// to the worker global scope. Spawned by `spawnSolverWorker()` in `client.ts`.

import type { ToWorker } from '@stress-carve/protocol';
import { selectBackendFactory } from './backends.ts';
import { SolverHost } from './host.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const host = new SolverHost(
  (msg, transfer) => scope.postMessage(msg, transfer),
  selectBackendFactory,
);
scope.onmessage = (ev: MessageEvent<ToWorker>) => host.receive(ev.data);
