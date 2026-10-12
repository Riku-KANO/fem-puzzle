// The part of the `window.__stressCarve` test hook (a `GameSession`, see src/game/boot.ts)
// that the e2e specs read. Exposed only in dev and in the e2e build (`vite build --mode e2e`).
// The type check below fails `pnpm --filter @stress-carve/web typecheck` as soon as a
// refactor breaks a field the specs depend on, instead of at e2e run time.

import type { GameSession } from '../src/game/boot.ts';

export interface E2EHook {
  controller: {
    latestResult: { seq: number; converged: boolean; loadsConnected: boolean } | null;
    state: {
      stage: { id: string };
      volumeFraction: number;
      solidCount: number;
      canUndo: boolean;
      canRedo: boolean;
      /** 1 = protected (keep ∪ support ∪ load cells) */
      keep: Uint8Array;
      block: Uint8Array;
    };
  };
  solver: {
    latestSeq: number;
    ready: { backend: string } | null;
  };
  scene: {
    canvas: HTMLCanvasElement;
    renderer: { info: { render: { triangles: number } } };
    pick(clientX: number, clientY: number): { element: number } | null;
  };
}

/** Compile-time guard: the real session must satisfy the hook shape. */
type Satisfies<T extends E2EHook> = T;
export type CheckedSession = Satisfies<GameSession>;

declare global {
  interface Window {
    __stressCarve?: E2EHook;
  }
}
