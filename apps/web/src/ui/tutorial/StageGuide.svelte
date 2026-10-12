<script lang="ts">
  // Below the stage panel: the step-by-step tutorial on w1-01 (design doc リスク: W1を
  // チュートリアル化), otherwise the stage's hints. In W1 the player can let low-stress
  // surface cells glow in the 3D view (低応力域を光らせるヒント).
  import type { Stage } from '@stress-carve/protocol';
  import { onDestroy, untrack } from 'svelte';
  import type { GameSession } from '../../game/boot.ts';
  import { envelope } from '../../render/colormap.ts';
  import type { HudState } from '../hudState.svelte.ts';
  import { HintGlow } from './glow.ts';
  import { hintThreshold, lowStressCells } from './lowStress.ts';
  import { markTutorialSeen, tutorialSeen } from './seen.ts';
  import {
    advance,
    currentStep,
    isFinished,
    observe,
    startTutorial,
    STEPS,
    TUTORIAL_STAGE_ID,
    type TutorialSignals,
    type TutorialState,
  } from './steps.ts';

  interface Props {
    stage: Stage;
    hud: HudState;
    /** the running game; a getter because App keeps the session outside reactive state */
    session: () => GameSession | null;
    /** load-test shows started so far (T-302 `loadTest.runs`) */
    loadTestRuns?: number;
    /** the result screen is open (T-301 `result.submission !== null`) */
    resultOpen?: boolean;
  }

  let { stage, hud, session, loadTestRuns, resultOpen = false }: Props = $props();

  const signals: TutorialSignals = $derived({
    solidCount: hud.solidCount,
    volumeFraction: hud.volumeFraction,
    maxUtilization: hud.maxUtilization,
    settled: hud.resultCurrent && !hud.solving,
    loadTestRuns,
    resultOpen,
  });

  const hasTutorial = $derived(stage.id === TUTORIAL_STAGE_ID);
  const hints = $derived(stage.hints ?? []);

  let tutorial = $state<TutorialState | null>(null);
  let hintIndex = $state(0);
  let hintsOpen = $state(true);
  let glowOn = $state(false);

  // New stage: start the tutorial (first visit) or show its hints.
  $effect(() => {
    const id = stage.id;
    const world = stage.world;
    untrack(() => {
      tutorial = id === TUTORIAL_STAGE_ID && !tutorialSeen() ? startTutorial(signals) : null;
      hintIndex = 0;
      hintsOpen = world === 1;
      glowOn = false;
    });
  });

  // Auto-advance on HUD changes.
  $effect(() => {
    const now = signals;
    untrack(() => {
      if (!tutorial) return;
      const next = observe(tutorial, now, stage.targets);
      if (next !== tutorial) setTutorial(next);
    });
  });

  const step = $derived(tutorial ? currentStep(tutorial) : null);
  const stepBody = $derived(
    step && tutorial
      ? step.body({ targets: stage.targets, startUtilization: tutorial.startUtilization, signals })
      : [],
  );
  const isLastStep = $derived(tutorial !== null && tutorial.step === STEPS.length - 1);

  function setTutorial(next: TutorialState): void {
    if (isFinished(next)) {
      markTutorialSeen();
      tutorial = null;
    } else {
      tutorial = next;
    }
  }

  function nextStep(): void {
    if (tutorial) setTutorial(advance(tutorial, signals));
  }

  function skipTutorial(): void {
    markTutorialSeen();
    tutorial = null;
  }

  function restartTutorial(): void {
    tutorial = startTutorial(signals);
  }

  // --- low-stress glow ---------------------------------------------------------

  const glowWanted = $derived(step ? step.highlight : glowOn && stage.world === 1);
  let glow: HintGlow | null = null;
  let glowSession: GameSession | null = null;

  function reducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function hintCells(s: GameSession, maxUtilization: number): number[] {
    const r = s.controller.latestResult;
    const u = r ? envelope(r.cases.map((c) => c.utilization)) : null;
    if (!u) return [];
    const st = s.controller.state;
    return lowStressCells({
      grid: st.grid,
      solid: st.solid,
      keep: st.keep,
      utilization: u,
      threshold: hintThreshold(maxUtilization),
    });
  }

  $effect(() => {
    const wanted = glowWanted && !resultOpen;
    // re-evaluate whenever a result arrives or the solid set changes
    const maxU = hud.maxUtilization;
    void hud.solidCount;
    void hud.resultCurrent;
    untrack(() => {
      const s = session();
      if (glow && glowSession !== s) {
        glow.dispose();
        glow = null;
      }
      if (!s || !wanted || maxU === null) {
        glow?.set([]);
        return;
      }
      glow ??= new HintGlow(s.scene.domain, s.controller.state.grid, reducedMotion());
      glowSession = s;
      glow.set(hintCells(s, maxU));
    });
  });

  onDestroy(() => glow?.dispose());
</script>

{#if !resultOpen}
  {#if tutorial && step}
    <section class="panel guide" aria-label="チュートリアル">
      <div class="head">
        <span class="badge">チュートリアル {tutorial.step + 1}/{STEPS.length}</span>
        <button class="link" onclick={skipTutorial}>スキップ</button>
      </div>
      <h2>{step.title}</h2>
      <div aria-live="polite">
        {#each stepBody as text, i (i)}
          <p>{text}</p>
        {/each}
      </div>
      <div class="foot">
        <span class="dots" aria-hidden="true">
          {#each STEPS as s, i (s.id)}
            <span class="dot" class:on={i <= tutorial.step}></span>
          {/each}
        </span>
        <button class="primary" onclick={nextStep}>{isLastStep ? '完了' : '次へ'}</button>
      </div>
    </section>
  {:else if hints.length > 0 || hasTutorial}
    <section class="panel guide" aria-label="ヒント">
      <div class="head">
        <button class="link" aria-expanded={hintsOpen} onclick={() => (hintsOpen = !hintsOpen)}>
          {hintsOpen ? '▾' : '▸'} ヒント{hints.length > 1 ? ` ${hintIndex + 1}/${hints.length}` : ''}
        </button>
        {#if hintsOpen && hints.length > 1}
          <span class="pager">
            <button aria-label="前のヒント" disabled={hintIndex === 0} onclick={() => (hintIndex -= 1)}>‹</button>
            <button aria-label="次のヒント" disabled={hintIndex >= hints.length - 1} onclick={() => (hintIndex += 1)}>›</button>
          </span>
        {/if}
      </div>
      {#if hintsOpen}
        {#if hints[hintIndex]}
          <p>{hints[hintIndex]}</p>
        {/if}
        <div class="tools">
          {#if stage.world === 1}
            <button class:active={glowOn} aria-pressed={glowOn} onclick={() => (glowOn = !glowOn)}>
              低応力を光らせる
            </button>
          {/if}
          {#if hasTutorial}
            <button onclick={restartTutorial}>チュートリアル</button>
          {/if}
        </div>
      {/if}
    </section>
  {/if}
{/if}

<style>
  .guide {
    width: 280px;
    margin-top: 0.6rem;
    font-size: 0.85rem;
    line-height: 1.55;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .badge {
    color: var(--accent);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
  }
  h2 {
    margin: 0.3rem 0 0.2rem;
    font-size: 1rem;
  }
  p {
    margin: 0.35rem 0;
  }
  .link {
    padding: 0.1rem 0.3rem;
    border: none;
    background: none;
    color: var(--muted);
    font-size: 0.78rem;
  }
  .link:hover:not(:disabled) {
    background: none;
    color: var(--text);
  }
  .pager {
    display: flex;
    gap: 2px;
  }
  .pager button {
    padding: 0.05rem 0.5rem;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.5rem;
  }
  .dots {
    display: flex;
    gap: 4px;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #3a404c;
  }
  .dot.on {
    background: var(--accent);
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #1a1a1a;
  }
  .primary:hover:not(:disabled) {
    background: #f4b55e;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.4rem;
  }
  .tools button {
    font-size: 0.75rem;
    padding: 0.25rem 0.55rem;
  }
</style>
