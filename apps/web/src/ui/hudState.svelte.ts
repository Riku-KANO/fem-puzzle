// Reactive HUD state (Svelte 5 runes). The controller writes the `HudModel` fields; the UI
// components read them and own the purely visual settings (palette, view mode).

import type { BrushSize } from '../game/brush.ts';
import type { HudModel } from '../game/controller.ts';
import type { PaletteId } from '../render/colormap.ts';

/** normal / section / X-ray — section and X-ray are implemented by T-303 */
export type ViewMode = 'normal' | 'section' | 'xray';

export class HudState implements HudModel {
  volumeFraction = $state(1);
  solidCount = $state(0);
  canUndo = $state(false);
  canRedo = $state(false);
  brush = $state<BrushSize>(1);
  solving = $state(true);
  iteration = $state(0);
  relResidual = $state(Number.NaN);
  backend = $state<HudModel['backend']>(null);
  maxUtilization = $state<number | null>(null);
  loadsConnected = $state(true);
  converged = $state(false);
  resultCurrent = $state(false);
  error = $state<string | null>(null);
  toast = $state<HudModel['toast']>(null);

  palette = $state<PaletteId>('stress');
  viewMode = $state<ViewMode>('normal');
}
