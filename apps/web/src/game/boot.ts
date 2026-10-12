// Wires one stage into a running game: carve state + 3D scene + pointer input + solver
// worker + controller. The only module that touches all of DOM, Three.js and the worker.
// T-304 (stage select) creates/disposes one `GameSession` per stage.

import type { Stage } from '@stress-carve/protocol';
import type { PaletteId } from '../render/colormap.ts';
import { attachPointerInput } from '../render/input.ts';
import { StageScene } from '../render/scene.ts';
import { SolverClient, spawnSolverWorker } from '../solver/client.ts';
import { CarveState } from './carveState.ts';
import { GameController, type HudModel } from './controller.ts';

export interface GameSession {
  controller: GameController;
  scene: StageScene;
  solver: SolverClient;
  dispose(): void;
}

export function startGame(host: HTMLElement, stage: Stage, hud: HudModel, palette: PaletteId): GameSession {
  const state = new CarveState(stage);
  const scene = new StageScene(host, state, palette);
  const solver = new SolverClient(spawnSolverWorker());
  const controller = new GameController(state, solver, scene, hud, { tol: 1e-4 });
  scene.onFrame = () => controller.flush();
  const detach = attachPointerInput(scene.canvas, {
    pick: (x, y) => scene.pick(x, y),
    hover: (hit) => controller.hover(hit),
    strokeStart: (hit) => controller.strokeStart(hit),
    strokeMove: (hit) => controller.strokeMove(hit),
    strokeEnd: () => controller.strokeEnd(),
    undo: () => controller.undo(),
    revert: (entry) => controller.revert(entry),
    retarget: (hit) => scene.retarget(hit),
  });
  const session: GameSession = {
    controller,
    scene,
    solver,
    dispose() {
      detach();
      controller.dispose();
      solver.dispose();
      scene.dispose();
      if (debugWindow().__stressCarve === session) delete debugWindow().__stressCarve;
    },
  };
  // Console handle in dev, test hook in the e2e build (`vite build --mode e2e`, T-306);
  // never in production (MODE === 'production' folds this to false).
  if (import.meta.env.DEV || import.meta.env.MODE === 'e2e') debugWindow().__stressCarve = session;
  return session;
}

function debugWindow(): { __stressCarve?: GameSession } {
  return window as unknown as { __stressCarve?: GameSession };
}
