// T-315: leaving a stage right after a carve (inside the 500 ms autosave interval) must show
// 途中 on the select screen. The select screen snapshots the records when it mounts, which
// happens before the session effect's cleanup saves on close — so the App flushes the carve in
// `router.onBeforeChange`. This drives the real router, runner and snapshot in that order.

import type { Stage } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { CarveState } from '../src/game/carveState.ts';
import { buildDemoStage } from '../src/game/demoStage.ts';
import { ProgressStore } from '../src/game/progress/records.ts';
import { StageRunner, type ProgressSession, type RunnerEnv } from '../src/game/progress/session.ts';
import { MemoryStore } from '../src/game/progress/storage.ts';
import type { StageCatalogue } from '../src/game/stages.ts';
import { menuSnapshot } from '../src/ui/select/menuSnapshot.ts';
import { HashRouter } from '../src/ui/select/router.svelte.ts';
import { FakeWindow } from './fakeWindow.ts';

const stage: Stage = { ...buildDemoStage(), id: 'w1-01', world: 1 };
const catalogue: StageCatalogue = { stages: [{ stage, source: 'test' }], rejected: [] };

function session(s: Stage): ProgressSession {
  return {
    controller: { state: new CarveState(s) },
    scene: { solidChanged: () => {} },
    solver: { carve: () => 0 },
    dispose: () => {},
  };
}

/** Timers that never fire on their own: the autosave interval has not run yet. */
const frozenEnv: RunnerEnv = { setInterval: () => 1, clearInterval: () => {}, now: () => 1 };

function carveRightNow(runner: StageRunner<ProgressSession>): number {
  const state = runner.session!.controller.state;
  const cells: number[] = [];
  for (let e = 0; e < state.solid.length && cells.length < 9; e++) if (state.solid[e] && !state.keep[e]) cells.push(e);
  state.carve(cells);
  state.endStroke();
  return state.volumeFraction;
}

/**
 * Mimic the app: the select screen mounts (snapshot) as soon as the route leaves the stage,
 * and the session is closed afterwards (effect cleanup order in Svelte).
 */
function playLeave(withFlushHook: boolean) {
  const win = new FakeWindow();
  const store = new ProgressStore(new MemoryStore());
  const runner = new StageRunner(store, session, frozenEnv);
  const router = new HashRouter(win as unknown as Window, (id) => id === stage.id);
  if (withFlushHook) router.onBeforeChange = () => runner.save();
  router.navigate({ kind: 'stage', id: stage.id });
  runner.open(stage);
  const volume = carveRightNow(runner);

  router.navigate({ kind: 'select', world: 1 }); // ← ステージ選択, within 500 ms of the carve
  const shown = menuSnapshot(catalogue, store); // MenuScreen mounts
  runner.close(); // session effect cleanup
  return { volume, shown: shown.info.get(stage.id)?.inProgress ?? null, store };
}

describe('leaving a stage right after a carve (T-315)', () => {
  it('the select screen sees the carve when the router flushes it before switching', () => {
    const { volume, shown, store } = playLeave(true);
    expect(volume).toBeLessThan(1);
    expect(shown).toBeCloseTo(volume, 12);
    expect(store.loadCarve(stage.id)?.volume).toBeCloseTo(volume, 12);
  });

  it('without the flush the snapshot misses it (the race the hook fixes)', () => {
    const { shown, store } = playLeave(false);
    expect(shown).toBeNull();
    expect(store.loadCarve(stage.id)).not.toBeNull(); // saved on close, too late for the screen
  });

  it('flushing is a no-op without an open stage or without changes', () => {
    const store = new ProgressStore(new MemoryStore());
    const runner = new StageRunner(store, session, frozenEnv);
    expect(runner.save()).toBe(false);
    runner.open(stage);
    expect(runner.save()).toBe(false);
    carveRightNow(runner);
    expect(runner.save()).toBe(true);
    expect(runner.save()).toBe(false);
  });
});
