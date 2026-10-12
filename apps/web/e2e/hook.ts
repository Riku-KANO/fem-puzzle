// The part of the `window.__stressCarve` test hook (a `GameSession`, see src/game/boot.ts)
// that the e2e specs read. Exposed only in dev and in the e2e build (`vite build --mode e2e`).
// The type check below fails `pnpm --filter @stress-carve/web typecheck` as soon as a
// refactor breaks a field the specs depend on, instead of at e2e run time.

import type { Face, FromWorker, ResultMsg, Vec3 } from '@stress-carve/protocol';
import type { GameSession } from '../src/game/boot.ts';

/** A ray hit as the pointer input hands it to the controller (`render/picking.ts` VoxelHit). */
export interface E2EHit {
  element: number;
  cell: Vec3;
  face: Face;
  t: number;
  point: Vec3;
}

export interface E2EHook {
  controller: {
    latestResult: ResultMsg | null;
    state: {
      stage: { id: string; grid: Vec3 };
      volumeFraction: number;
      solidCount: number;
      canUndo: boolean;
      canRedo: boolean;
      /** 1 = protected (keep ∪ support ∪ load cells) */
      keep: Uint8Array;
      block: Uint8Array;
      solid: Uint8Array;
    };
    // the calls the pointer input makes (render/input.ts → game/boot.ts)
    strokeStart(hit: E2EHit | null): void;
    strokeEnd(): unknown;
  };
  solver: {
    latestSeq: number;
    ready: { backend: string; levels: number } | null;
    /** worker message entry point (public for tests): lets a spec inject a result */
    receive(msg: FromWorker): void;
  };
  scene: {
    canvas: HTMLCanvasElement;
    renderer: { info: { render: { triangles: number } } };
    pick(clientX: number, clientY: number): { element: number } | null;
    /** T-303: the view spec the scene currently renders */
    views: {
      view: { section: { axis: number; cut: number; flip: boolean } | null; xray: number | null };
      sectionMask: Uint8Array | null;
    };
    /** T-310 workshop environment + debris (render/env/workshop.ts) */
    workshop: {
      /** the glTF bench / room / jigs replaced the placeholders */
      readonly envReady: boolean;
      loadJigs(): unknown[];
      debris: { readonly stats: E2EDebrisStats };
    };
    /** T-302 load test */
    loadTest: {
      readonly active: boolean;
      readonly current: { state: string; phase: string | null; scale: number; overstressed: number; runs: number };
      /** pin the show at this time (s) instead of the clock */
      freezeAt: number | null;
    };
  };
}

/** `scene.workshop.debris.stats` (render/env/debris/debris.ts `DebrisStats`), the fields specs read. */
export interface E2EDebrisStats {
  mode: 'physics' | 'fade' | 'off';
  ready: boolean;
  failed: boolean;
  /** chips simulated now */
  live: number;
  queued: number;
  /** chips drawn in the static pile */
  pile: number;
  spawned: number;
  /** cumulative: settled into the pile / shrank away / fell off */
  piled: number;
  faded: number;
  lost: number;
  liveCap: number;
}

/** Compile-time guard: the real session must satisfy the hook shape. */
type Satisfies<T extends E2EHook> = T;
export type CheckedSession = Satisfies<GameSession>;

declare global {
  interface Window {
    __stressCarve?: E2EHook;
  }
}
