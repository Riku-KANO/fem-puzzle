<script lang="ts">
  // Game screen (design doc 画面構成): 3D view in the centre, HUD overlays around it.
  // Kept thin — game wiring lives in game/boot.ts, HUD state in ui/hudState.svelte.ts.
  import { onMount } from 'svelte';
  import type { BrushSize } from './game/brush.ts';
  import { startGame, type GameSession } from './game/boot.ts';
  import { submitGate } from './game/judge/index.ts';
  import { listStages, pickInitialStage } from './game/stages.ts';
  import ThinWallBadge from './game/thickness/ThinWallBadge.svelte';
  import { ThinWallHud } from './game/thickness/thinWallHud.svelte.ts';
  import type { PaletteId } from './render/colormap.ts';
  import { HudState, type ViewMode } from './ui/hudState.svelte.ts';
  import { shortcutFor } from './ui/shortcuts.ts';
  import SidePanel from './ui/SidePanel.svelte';
  import StagePanel from './ui/StagePanel.svelte';
  import Toast from './ui/Toast.svelte';
  import Toolbar from './ui/Toolbar.svelte';
  import ResultScreen from './ui/result/ResultScreen.svelte';
  import { ResultSession } from './ui/result/resultSession.svelte.ts';

  const { stage } = pickInitialStage(listStages(), window.location.search);
  const hud = new HudState();
  const result = new ResultSession(); // T-304: result.onClear = (c) => progress.recordClear(c)
  const gate = $derived(submitGate(hud));
  const thinWalls = new ThinWallHud();
  let viewport: HTMLDivElement;
  let game: GameSession | null = null;

  onMount(() => {
    game = startGame(viewport, stage, hud, hud.palette);
    const detachThinWalls = thinWalls.attach(game.scene);
    return () => {
      result.dispose();
      detachThinWalls();
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
    submit: () => {
      if (game) result.open(game, hud);
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
      <ThinWallBadge hud={thinWalls} />
    </div>
    {#if result.submission}
      <div class="result-slot">
        <ResultScreen session={result} targets={stage.targets} current={hud.resultCurrent} />
      </div>
    {/if}
    <div class="right">
      <SidePanel {hud} onPalette={actions.palette} onViewMode={actions.viewMode} />
    </div>
    <div class="bottom">
      <Toast {hud} />
      <Toolbar
        {hud}
        onBrush={actions.brush}
        onUndo={actions.undo}
        onRedo={actions.redo}
        canSubmit={gate.enabled && !result.submission}
        submitTitle={gate.reason}
        submitHint={gate.problem ? gate.reason : null}
        onSubmit={actions.submit}
      />
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
  .result-slot {
    /* over the stage panel (the card repeats its volume / targets), leaves the model visible */
    position: absolute;
    top: 16px;
    left: 16px;
    z-index: 1;
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
