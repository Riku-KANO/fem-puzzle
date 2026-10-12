// Reactive HUD state of the thin-wall warning (T-308): the thin-cell count and whether the
// dot tint is shown. Bound to one game session's view with `attach`.

import type { ThinWallMap } from './thinWalls.ts';

/** What the warning needs from the 3D view (implemented by `render/scene.ts`). */
export interface ThinWallView {
  readonly thinWalls: ThinWallMap;
  readonly voxels: { setThin(thin: Uint8Array | null): void };
}

export class ThinWallHud {
  /** solid, unprotected cells thinner than 2 voxels */
  count = $state(0);
  /** dot tint on the model (the count stays visible either way) */
  tint = $state(true);

  private view: ThinWallView | null = null;
  private unsubscribe: (() => void) | null = null;

  /** Follow `view` (replacing any previous one); returns a detach function. */
  attach(view: ThinWallView): () => void {
    this.detach();
    this.view = view;
    this.count = view.thinWalls.count;
    this.unsubscribe = view.thinWalls.subscribe((n) => {
      this.count = n;
    });
    this.applyTint();
    return () => {
      if (this.view === view) this.detach();
    };
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.view = null;
  }

  toggleTint(): void {
    this.tint = !this.tint;
    this.applyTint();
  }

  private applyTint(): void {
    const v = this.view;
    v?.voxels.setThin(this.tint ? v.thinWalls.thin : null);
  }
}
