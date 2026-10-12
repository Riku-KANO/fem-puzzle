<script lang="ts">
  // Game screen (design doc 画面構成): 3D view in the centre, HUD overlays around it.
  // Kept thin — game wiring lives in game/boot.ts, HUD state in ui/hudState.svelte.ts.
  // Routing (T-304, ui/select/): #/ title, #/select stage select, #/stage/<id> this screen;
  // one GameSession per opened stage (null on the menus), carve saved by the StageRunner.
  import { untrack } from 'svelte';
  import type { BrushSize } from './game/brush.ts';
  import { startGame, type GameSession } from './game/boot.ts';
  import { submitGate } from './game/judge/index.ts';
  import {
    browserRunnerEnv,
    buildCampaign,
    createProgressStore,
    nextUnlockedStageId,
    StageRunner,
    type ResumeStatus,
    type StageClear,
  } from './game/progress/index.ts';
  import { listStages } from './game/stages.ts';
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
  import GameMenu from './ui/select/GameMenu.svelte';
  import MenuScreen from './ui/select/MenuScreen.svelte';
  import { HashRouter } from './ui/select/router.svelte.ts';
  import { screenOf } from './ui/select/routes.ts';

  const catalogue = listStages();
  const stageRefs = catalogue.stages.map((e) => ({ id: e.stage.id, world: e.stage.world }));
  const progress = createProgressStore();
  const router = new HashRouter(window, (id) => stageRefs.some((s) => s.id === id));
  /** the open stage, null on the title / select screens */
  const entry = $derived.by(() => {
    const r = router.route;
    return r.kind === 'stage' ? (catalogue.stages.find((e) => e.stage.id === r.id) ?? null) : null;
  });
  const stage = $derived((entry ?? catalogue.stages[0]!).stage);
  const hud = new HudState();
  const result = new ResultSession();
  const gate = $derived(submitGate(hud));
  const thinWalls = new ThinWallHud();
  let viewport: HTMLDivElement;
  let game = $state.raw<GameSession | null>(null);
  let opened = $state.raw<{ status: ResumeStatus }>({ status: 'fresh' });
  const runner = new StageRunner(progress, (s) => startGame(viewport, s, hud, hud.palette), browserRunnerEnv(window));

  /** Make `session` the current game (after open / restart). */
  function bindSession(session: GameSession): void {
    game = session;
    opened = { status: runner.resume };
    thinWalls.attach(session.scene);
  }

  $effect(() => {
    const current = entry;
    if (!current) return;
    untrack(() => bindSession(runner.open(current.stage)));
    return () => {
      result.close(); // before the session (and its scene) is disposed
      thinWalls.detach();
      runner.close();
      game = null;
    };
  });

  // Passed submissions go to the local records; the previous best is read first (自己ベスト).
  result.onClear = (c) => actions.clear(c);
  result.bestOf = (id) => {
    const r = progress.record(id);
    return r ? { stars: r.stars, volumeFraction: r.volume } : null;
  };
  $effect(() => () => result.dispose());

  $effect(() => {
    document.documentElement.dataset.screen = entry ? 'stage' : screenOf(router.route);
  });

  $effect(() => () => router.dispose());

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
    // Campaign (T-304). `clear`/`next`/`select` are the hooks for the result screen (T-301).
    select: () => router.navigate({ kind: 'select', world: stage.world }),
    restart: () => {
      result.close();
      thinWalls.detach();
      const session = runner.restart();
      if (session) bindSession(session);
    },
    clear: (c: StageClear) => progress.recordClear(c),
    next: () => {
      const campaign = buildCampaign(stageRefs, (id) => progress.record(id));
      const id = nextUnlockedStageId(campaign, stageRefs, stage.id);
      router.navigate(id !== null ? { kind: 'stage', id } : { kind: 'select', world: stage.world });
    },
  };

  function onKeydown(ev: KeyboardEvent): void {
    if (!game) return; // title / select screens: keep Space/Enter for buttons
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

<main class="game" hidden={!entry}>
  <div class="viewport" bind:this={viewport}></div>
  <div class="hud">
    <div class="top-left">
      <GameMenu resume={opened} onSelect={actions.select} onRestart={actions.restart} />
      <StagePanel title={stage.title} world={stage.world} targets={stage.targets} {hud} />
      <ThinWallBadge hud={thinWalls} />
    </div>
    {#if result.submission}
      <div class="result-slot">
        <ResultScreen
          session={result}
          targets={stage.targets}
          current={hud.resultCurrent}
          onNext={actions.next}
          onSelect={actions.select}
        />
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
        submitHint={gate.problem}
        onSubmit={actions.submit}
      />
    </div>
  </div>
</main>
{#if !entry}
  <MenuScreen {router} {catalogue} {progress} />
{/if}

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
