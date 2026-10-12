import { encodeBitmask, type Stage } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { CarveState } from '../src/game/carveState.ts';
import { buildDemoStage } from '../src/game/demoStage.ts';
import { ProgressStore } from '../src/game/progress/records.ts';
import {
  AUTOSAVE_INTERVAL_MS,
  applyResume,
  resumeCells,
  StageRunner,
  type ProgressSession,
  type RunnerEnv,
} from '../src/game/progress/session.ts';
import { MemoryStore } from '../src/game/progress/storage.ts';

class FakeSession implements ProgressSession {
  readonly controller: { state: CarveState };
  readonly changed: number[][] = [];
  readonly sent: { removed: number[]; restored: number[] }[] = [];
  disposed = false;
  readonly scene = { solidChanged: (cells: readonly number[]) => void this.changed.push([...cells]) };
  readonly solver = {
    carve: (removed: number[], restored: number[]) => this.sent.push({ removed, restored }),
  };
  constructor(stage: Stage) {
    this.controller = { state: new CarveState(stage) };
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakeEnv implements RunnerEnv {
  t = 100;
  intervals = new Map<number, { fn: () => void; ms: number }>();
  hideListeners = new Set<() => void>();
  private next = 1;
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.intervals.set(id, { fn, ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }
  now(): number {
    return (this.t += 1);
  }
  onPageHide(fn: () => void): () => void {
    this.hideListeners.add(fn);
    return () => this.hideListeners.delete(fn);
  }
  tick(): void {
    for (const { fn } of this.intervals.values()) fn();
  }
  hide(): void {
    for (const fn of this.hideListeners) fn();
  }
}

/** The first `count` carvable (solid, unprotected) cells of a state. */
function carvable(state: CarveState, count: number): number[] {
  const out: number[] = [];
  for (let e = 0; e < state.solid.length && out.length < count; e++) {
    if (state.solid[e] && !state.keep[e]) out.push(e);
  }
  return out;
}

function setup(storage = new MemoryStore()) {
  const stage = buildDemoStage();
  const env = new FakeEnv();
  const store = new ProgressStore(storage);
  const sessions: FakeSession[] = [];
  const runner = new StageRunner(store, (s) => {
    const session = new FakeSession(s);
    sessions.push(session);
    return session;
  }, env);
  return { stage, env, store, runner, sessions, storage };
}

describe('resumeCells / applyResume', () => {
  const stage = buildDemoStage();

  it('removes exactly the unprotected cells missing from the saved mask', () => {
    const state = new CarveState(stage);
    const cells = carvable(state, 5);
    const saved = Uint8Array.from(state.solid);
    for (const e of cells) saved[e] = 0;
    expect(resumeCells(state.solid, state.keep, encodeBitmask(saved))).toEqual(cells);
  });

  it('never removes protected cells and ignores extra material', () => {
    const state = new CarveState(stage);
    const keepCell = state.keep.findIndex((k) => k === 1);
    expect(keepCell).toBeGreaterThanOrEqual(0);
    const saved = new Uint8Array(state.solid.length).fill(1); // more than the stage has
    saved[keepCell] = 0;
    expect(resumeCells(state.solid, state.keep, encodeBitmask(saved))).toEqual([]);
  });

  it('rejects a mask of the wrong size or invalid base64', () => {
    const state = new CarveState(stage);
    expect(resumeCells(state.solid, state.keep, 'AA==')).toBeNull();
    expect(resumeCells(state.solid, state.keep, '***')).toBeNull();
  });

  it('applies without undo history and notifies the view and the solver once', () => {
    const session = new FakeSession(stage);
    const state = session.controller.state;
    const cells = carvable(state, 4);
    const saved = Uint8Array.from(state.solid);
    for (const e of cells) saved[e] = 0;
    expect(applyResume(session, encodeBitmask(saved))).toEqual(cells);
    expect(state.solidCount).toBe(state.initialCount - 4);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.strokeActive).toBe(false);
    expect(session.changed).toEqual([cells]);
    expect(session.sent).toEqual([{ removed: cells, restored: [] }]);
  });
});

describe('StageRunner', () => {
  it('opens fresh, autosaves changes on the interval and resumes after a reload', () => {
    const a = setup();
    const s1 = a.runner.open(a.stage);
    expect(a.runner.resume).toBe('fresh');
    expect(a.store.lastStage).toBe(a.stage.id);
    expect([...a.env.intervals.values()].map((i) => i.ms)).toEqual([AUTOSAVE_INTERVAL_MS]);

    a.env.tick();
    expect(a.store.loadCarve(a.stage.id)).toBeNull(); // nothing carved yet

    const state = s1.controller.state;
    const cells = carvable(state, 6);
    state.carve(cells);
    state.endStroke();
    a.env.tick();
    const saved = a.store.loadCarve(a.stage.id);
    expect(saved?.solid).toBe(state.toBitmask());
    expect(saved?.volume).toBeCloseTo(state.volumeFraction, 12);
    expect(a.runner.save()).toBe(false); // unchanged → no write

    // "Reload": a new runner and store on the same storage.
    const b = setup(a.storage);
    const s2 = b.runner.open(b.stage);
    expect(b.runner.resume).toBe('resumed');
    expect(s2.controller.state.toBitmask()).toBe(state.toBitmask());
    expect(s2.controller.state.canUndo).toBe(false);
    expect(s2.sent).toEqual([{ removed: cells, restored: [] }]);
  });

  it('undoing back to the authored block deletes the saved carve', () => {
    const t = setup();
    const state = t.runner.open(t.stage).controller.state;
    state.carve(carvable(state, 3));
    state.endStroke();
    t.env.tick();
    expect(t.store.loadCarve(t.stage.id)).not.toBeNull();
    state.undo();
    t.env.tick();
    expect(t.store.loadCarve(t.stage.id)).toBeNull();
  });

  it('saves on page hide and on close, then disposes the session and stops timers', () => {
    const t = setup();
    const session = t.runner.open(t.stage);
    const state = session.controller.state;
    state.carve(carvable(state, 2));
    t.env.hide();
    expect(t.store.loadCarve(t.stage.id)?.solid).toBe(state.toBitmask());

    state.carve(carvable(state, 2));
    t.runner.close();
    expect(t.store.loadCarve(t.stage.id)?.solid).toBe(state.toBitmask());
    expect(session.disposed).toBe(true);
    expect(t.runner.session).toBeNull();
    expect(t.env.intervals.size).toBe(0);
    expect(t.env.hideListeners.size).toBe(0);
    t.runner.close(); // idempotent
  });

  it('opening another stage closes (and saves) the previous one', () => {
    const t = setup();
    const first = t.runner.open(t.stage);
    first.controller.state.carve(carvable(first.controller.state, 2));
    const other: Stage = { ...t.stage, id: 'w9-01' };
    t.runner.open(other);
    expect(first.disposed).toBe(true);
    expect(t.store.loadCarve(t.stage.id)).not.toBeNull();
    expect(t.runner.stageId).toBe('w9-01');
    expect(t.env.intervals.size).toBe(1);
  });

  it('restart discards the saved carve and reopens the authored block', () => {
    const t = setup();
    const first = t.runner.open(t.stage);
    first.controller.state.carve(carvable(first.controller.state, 3));
    t.runner.save();
    const second = t.runner.restart();
    expect(first.disposed).toBe(true);
    expect(second).not.toBe(first);
    expect(t.runner.resume).toBe('fresh');
    expect(second!.controller.state.solidCount).toBe(second!.controller.state.initialCount);
    expect(t.store.loadCarve(t.stage.id)).toBeNull();
    expect(t.env.intervals.size).toBe(1);
  });

  it('an unusable saved carve is dropped and the stage starts fresh', () => {
    const t = setup();
    t.store.saveCarve(t.stage.id, { solid: 'AA==', volume: 0.5, savedAt: 1 });
    const session = t.runner.open(t.stage);
    expect(t.runner.resume).toBe('invalid');
    expect(session.controller.state.solidCount).toBe(session.controller.state.initialCount);
    expect(t.store.loadCarve(t.stage.id)).toBeNull();
  });

  it('works with unavailable storage (in-memory for the session)', () => {
    const stage = buildDemoStage();
    const store = new ProgressStore(null);
    const runner = new StageRunner(store, (s) => new FakeSession(s), new FakeEnv());
    const state = runner.open(stage).controller.state;
    state.carve(carvable(state, 2));
    runner.close();
    expect(runner.open(stage).controller.state.solidCount).toBe(state.solidCount);
    expect(runner.resume).toBe('resumed');
  });
});
