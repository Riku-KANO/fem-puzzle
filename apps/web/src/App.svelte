<script lang="ts">
  // Game screen (design doc 画面構成): 3D view in the centre, HUD overlays around it.
  // Kept thin — game wiring lives in game/boot.ts, HUD state in ui/hudState.svelte.ts.
  import { onMount } from 'svelte';
  import type { BrushSize } from './game/brush.ts';
  import { startGame, type GameSession } from './game/boot.ts';
  import { listStages, pickInitialStage } from './game/stages.ts';
  import type { PaletteId } from './render/colormap.ts';
  import { HudState, type ViewMode } from './ui/hudState.svelte.ts';
  import { shortcutFor } from './ui/shortcuts.ts';
  import SidePanel from './ui/SidePanel.svelte';
  import StagePanel from './ui/StagePanel.svelte';
  import Toast from './ui/Toast.svelte';
  import Toolbar from './ui/Toolbar.svelte';

  const { stage } = pickInitialStage(listStages(), window.location.search);
  const hud = new HudState();
  let viewport: HTMLDivElement;
  let game: GameSession | null = null;

  onMount(() => {
    game = startGame(viewport, stage, hud, hud.palette);
    return () => {
      game?.dispose();
      game = null;
    };
  });

  const actions = {
    brush: (size: BrushSize) => game?.controller.setBrush(size),
    undo: () => game?.controller.undo(),
    redo: () => game?.controller.redo(),
    palette: (id: PaletteId) => {
      hud.palette = id;
      game?.scene.setPalette(id);
    },
    viewMode: (mode: ViewMode) => {
      hud.viewMode = mode; // section / X-ray rendering: T-303
    },
  };

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
    const action = shortcutFor(ev);
    if (!action) return;
    ev.preventDefault();
    switch (action.kind) {
      case 'brush':
        actions.brush(action.size);
        break;
      case 'undo':
        actions.undo();
        break;
      case 'redo':
        actions.redo();
        break;
      case 'loadTest':
        break; // T-302
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<main class="game">
  <div class="viewport" bind:this={viewport}></div>
  <div class="hud">
    <div class="top-left">
      <StagePanel title={stage.title} world={stage.world} targets={stage.targets} {hud} />
    </div>
    <div class="right">
      <SidePanel {hud} onPalette={actions.palette} onViewMode={actions.viewMode} />
    </div>
    <div class="bottom">
      <Toast {hud} />
      <Toolbar {hud} onBrush={actions.brush} onUndo={actions.undo} onRedo={actions.redo} />
    </div>
  </div>
</main>

<style>
  .game {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .viewport {
    position: absolute;
    inset: 0;
  }
  .hud {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .hud > div > :global(*) {
    pointer-events: auto;
  }
  .hud :global(.toast-slot) {
    pointer-events: none;
  }
  .top-left {
    position: absolute;
    top: 16px;
    left: 16px;
  }
  .right {
    position: absolute;
    top: 16px;
    right: 16px;
  }
  .bottom {
    position: absolute;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }
</style>
