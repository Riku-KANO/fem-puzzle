// Main-thread side of the solver protocol: numbers requests with an increasing `seq`, drops
// replies for anything older than the newest request, and fans messages out to listeners.

import type {
  Bitmask,
  ErrorMsg,
  FromWorker,
  ProgressMsg,
  ReadyMsg,
  ResultMsg,
  SolverOptionsMsg,
  Stage,
  ToWorker,
} from '@stress-carve/protocol';

/** The subset of `Worker` the client needs (tests pass a fake). */
export interface WorkerPort {
  postMessage(message: ToWorker, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  terminate(): void;
}

export interface SolverListener {
  ready?(msg: ReadyMsg): void;
  progress?(msg: ProgressMsg): void;
  result?(msg: ResultMsg): void;
  error?(msg: ErrorMsg): void;
}

export function spawnSolverWorker(): WorkerPort {
  return new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'stress-carve-solver',
  }) as WorkerPort;
}

export class SolverClient {
  /** seq of the newest request sent (init = 0) */
  latestSeq = 0;
  /** seq of the newest result received (-1 = none yet) */
  lastResultSeq = -1;
  /** stale progress/result messages dropped so far */
  dropped = 0;
  ready: ReadyMsg | null = null;
  private listeners = new Set<SolverListener>();
  private disposed = false;

  constructor(private readonly port: WorkerPort) {
    port.onmessage = (ev) => this.receive(ev.data);
    port.onerror = (ev) => {
      ev.preventDefault?.();
      this.receive({ type: 'error', message: ev.message || 'solver worker crashed' });
    };
  }

  /** True while the newest request has not produced a result yet. */
  get solving(): boolean {
    return this.lastResultSeq < this.latestSeq;
  }

  subscribe(listener: SolverListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  init(stage: Stage, options?: SolverOptionsMsg): void {
    this.latestSeq = 0;
    this.lastResultSeq = -1;
    this.ready = null;
    this.send(options ? { type: 'init', stage, options } : { type: 'init', stage });
  }

  /** Send a diff; returns its seq. */
  carve(removed: number[], restored: number[]): number {
    const seq = ++this.latestSeq;
    this.send({ type: 'carve', seq, removed, restored });
    return seq;
  }

  /** Replace the whole solid set; returns its seq. */
  setSolid(solid: Bitmask): number {
    const seq = ++this.latestSeq;
    this.send({ type: 'setSolid', seq, solid });
    return seq;
  }

  cancel(): void {
    this.send({ type: 'cancel' });
  }

  /** Is `seq` older than the newest request? */
  isStale(seq: number): boolean {
    return seq < this.latestSeq;
  }

  /** Handle one worker message (public for tests). */
  receive(msg: FromWorker): void {
    if (this.disposed) return;
    switch (msg.type) {
      case 'ready':
        this.ready = msg;
        for (const l of this.listeners) l.ready?.(msg);
        return;
      case 'progress':
        if (this.isStale(msg.seq)) {
          this.dropped++;
          return;
        }
        for (const l of this.listeners) l.progress?.(msg);
        return;
      case 'result':
        if (this.isStale(msg.seq)) {
          this.dropped++;
          return;
        }
        this.lastResultSeq = msg.seq;
        for (const l of this.listeners) l.result?.(msg);
        return;
      case 'error':
        if (msg.seq !== undefined && this.isStale(msg.seq)) {
          this.dropped++;
          return;
        }
        if (msg.seq !== undefined) this.lastResultSeq = msg.seq;
        for (const l of this.listeners) l.error?.(msg);
        return;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.port.onmessage = null;
    this.port.onerror = null;
    this.port.terminate();
  }

  private send(msg: ToWorker): void {
    if (this.disposed) return;
    this.port.postMessage(msg, []);
  }
}
