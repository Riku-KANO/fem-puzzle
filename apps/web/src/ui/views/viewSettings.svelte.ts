// Section / X-ray settings behind the view-mode toggle (Svelte 5 runes). The mode itself is
// `hud.viewMode`; `viewSpecFor(mode, settings, grid)` (render/views) turns both into the view
// the scene draws.

import type { Vec3 } from '@stress-carve/protocol';
import type { Axis } from '../../game/grid.ts';
import { DEFAULT_XRAY_THRESHOLD, type ViewSettingsLike } from '../../render/views/visibility.ts';

export const AXES: readonly { id: Axis; label: string }[] = [
  { id: 0, label: 'X' },
  { id: 1, label: 'Y' },
  { id: 2, label: 'Z' },
];

export class ViewSettings implements ViewSettingsLike {
  axis = $state<Axis>(0);
  /** cut plane position along `axis`, in layers (0..dims[axis]) */
  cut = $state(0);
  flip = $state(false);
  /** X-ray threshold, utilisation fraction */
  threshold = $state(DEFAULT_XRAY_THRESHOLD);
  /** grid dimensions of the current stage */
  dims = $state.raw<Vec3>([1, 1, 1]);

  constructor(dims: Vec3) {
    this.setStage(dims);
  }

  /** layer count along the current axis (slider maximum) */
  get layers(): number {
    return this.dims[this.axis];
  }

  /** New stage: keep axis and threshold, re-centre the cut. */
  setStage(dims: Vec3): void {
    this.dims = dims;
    this.cut = Math.round(dims[this.axis] / 2);
  }

  /** Switch the section axis: cut through the middle, kept side as given (facing the camera). */
  chooseAxis(axis: Axis, flip: boolean): void {
    this.axis = axis;
    this.cut = Math.round(this.dims[axis] / 2);
    this.flip = flip;
  }
}
