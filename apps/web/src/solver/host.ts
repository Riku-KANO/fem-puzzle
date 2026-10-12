// Worker-side protocol handler (docs/specs/worker-protocol.md). DOM/Worker-free so it runs
// in vitest: `worker.ts` only forwards `onmessage` here and posts what this emits.
//
// Messages are queued and processed in order. Solid diffs are always applied (never
// dropped); only the *solve* of an outdated `seq` is abandoned: while a solve runs,
// `hooks.cancelled()` turns true as soon as another message is queued or `cancel` arrives.

import {
  decodeBitmask,
  transferablesOf,
  type FromWorker,
  type SolverOptionsMsg,
  type ToWorker,
} from '@stress-carve/protocol';
import type { Backend, BackendFactory, SolveHooks } from './backend.ts';

export type PostFn = (msg: FromWorker, transfer: Transferable[]) => void;

export interface HostOptions {
  now?: () => number;
  /** yield to the event loop (default: setTimeout 0) */
  yieldFn?: () => Promise<void>;
}

const DEFAULT_PROGRESS_MS = 60;

export class SolverHost {
  private queue: ToWorker[] = [];
  private pumping: Promise<void> = Promise.resolve();
  private running = false;
  private cancelRequested = false;
  private backend: Backend | null = null;
  private options: SolverOptionsMsg = {};
  /** mirror of the backend's solid set, to turn `setSolid` bitmasks into diffs */
  private solid: Uint8Array | null = null;
  private readonly now: () => number;
  private readonly yieldFn: () => Promise<void>;

  constructor(
    private readonly post: PostFn,
    private readonly selectFactory: (options: SolverOptionsMsg) => BackendFactory,
    opts: HostOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.yieldFn = opts.yieldFn ?? (() => new Promise((r) => setTimeout(r, 0)));
  }

  receive(msg: ToWorker): void {
    if (msg.type === 'cancel') {
      this.cancelRequested = true;
      return;
    }
    // a new request supersedes an earlier cancel
    this.cancelRequested = false;
    this.queue.push(msg);
    if (!this.running) {
      this.running = true;
      this.pumping = this.pump();
    }
  }

  /** Resolves once every queued message has been processed (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.pumping;
  }

  private emit(msg: FromWorker): void {
    this.post(msg, transferablesOf(msg));
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        let solveSeq: number | null = null;
        while (this.queue.length > 0) {
          const msg = this.queue.shift()!;
          try {
            const seq = await this.apply(msg);
            if (seq !== null) solveSeq = seq;
          } catch (e) {
            this.emit({ type: 'error', seq: 'seq' in msg ? msg.seq : undefined, message: errorMessage(e) });
          }
        }
        if (solveSeq === null || !this.backend || this.cancelRequested) return;
        await this.solve(this.backend, solveSeq);
      }
    } finally {
      // runs synchronously after the last empty-queue check, so a message arriving later
      // always starts a new pump
      this.running = false;
    }
  }

  /** Apply one message; returns the seq that now needs solving, if any. */
  private async apply(msg: ToWorker): Promise<number | null> {
    switch (msg.type) {
      case 'init': {
        this.backend?.dispose();
        this.backend = null;
        this.options = msg.options ?? {};
        const backend = await this.selectFactory(this.options)(msg.stage, this.options);
        this.backend = backend;
        this.solid = decodeBitmask(msg.stage.solid, backend.info.elements);
        this.emit({ type: 'ready', ...backend.info });
        return 0;
      }
      case 'carve': {
        this.requireBackend();
        this.applySolid(Uint32Array.from(msg.removed), false);
        this.applySolid(Uint32Array.from(msg.restored), true);
        return msg.seq;
      }
      case 'setSolid': {
        this.requireBackend();
        const solid = this.solid!;
        const next = decodeBitmask(msg.solid, solid.length);
        const removed: number[] = [];
        const restored: number[] = [];
        for (let e = 0; e < next.length; e++) {
          if (next[e] === solid[e]) continue;
          (next[e] ? restored : removed).push(e);
        }
        this.applySolid(Uint32Array.from(removed), false);
        this.applySolid(Uint32Array.from(restored), true);
        return msg.seq;
      }
      default:
        return null;
    }
  }

  /**
   * One `backend.setSolid` batch, mirrored only once it succeeded: if a later batch of the
   * same message throws, the mirror still matches what the backend actually holds.
   */
  private applySolid(indices: Uint32Array, solid: boolean): void {
    if (indices.length === 0) return;
    this.requireBackend().setSolid(indices, solid);
    const mirror = this.solid!;
    const v = solid ? 1 : 0;
    for (const e of indices) if (e < mirror.length) mirror[e] = v;
  }

  private requireBackend(): Backend {
    if (!this.backend) throw new Error('solver not initialised (send init first)');
    return this.backend;
  }

  private async solve(backend: Backend, seq: number): Promise<void> {
    const start = this.now();
    const every = this.options.progressEveryMs ?? DEFAULT_PROGRESS_MS;
    let lastProgress = start;
    const hooks: SolveHooks = {
      cancelled: () => this.cancelRequested || this.queue.length > 0,
      progressDue: () => this.now() - lastProgress >= every,
      progress: (iteration, relResidual, utilization) => {
        lastProgress = this.now();
        this.emit({ type: 'progress', seq, iteration, relResidual, utilization });
      },
      yield: this.yieldFn,
    };
    try {
      const out = await backend.solve(hooks);
      if (out) this.emit({ type: 'result', seq, elapsedMs: this.now() - start, ...out });
    } catch (e) {
      this.emit({ type: 'error', seq, message: errorMessage(e) });
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
