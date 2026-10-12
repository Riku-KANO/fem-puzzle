<script lang="ts">
  // Top-left: stage name, volume meter with star thresholds (design doc 画面構成).
  import type { Targets } from '@stress-carve/protocol';
  import { percent } from './format.ts';
  import type { HudState } from './hudState.svelte.ts';

  interface Props {
    title: string;
    world: number;
    targets: Targets;
    hud: HudState;
  }

  let { title, world, targets, hud }: Props = $props();

  const thresholds = $derived([
    { stars: 1, value: targets.star1 },
    { stars: 2, value: targets.star2 },
    { stars: 3, value: targets.star3 },
  ]);
  const earned = $derived(thresholds.filter((t) => hud.volumeFraction <= t.value + 1e-9).length);
</script>

<section class="panel stage" aria-label="ステージ情報">
  <div class="world">{world === 0 ? 'サンドボックス' : `ワールド ${world}`}</div>
  <h1>{title}</h1>
  <div class="meter-head">
    <span>体積率</span>
    <strong>{percent(hud.volumeFraction, 1)}</strong>
    <span class="stars" aria-label={`体積の星 ${earned}`}>
      {#each [1, 2, 3] as s (s)}
        <span class:on={s <= earned}>★</span>
      {/each}
    </span>
  </div>
  <div
    class="meter"
    role="meter"
    aria-label="体積率"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(hud.volumeFraction * 100)}
  >
    <div class="fill" style:width={`${hud.volumeFraction * 100}%`}></div>
    {#each thresholds as t (t.stars)}
      <div
        class="mark"
        class:reached={hud.volumeFraction <= t.value + 1e-9}
        style:left={`${t.value * 100}%`}
        title={`${'★'.repeat(t.stars)} ${percent(t.value)}`}
      ></div>
    {/each}
  </div>
  <div class="targets">
    {#each thresholds as t (t.stars)}
      <span>{'★'.repeat(t.stars)} {percent(t.value)}</span>
    {/each}
  </div>
</section>

<style>
  .stage {
    width: 280px;
  }
  .world {
    color: var(--muted);
    font-size: 0.75rem;
    letter-spacing: 0.08em;
  }
  h1 {
    margin: 0.1rem 0 0.6rem;
    font-size: 1.15rem;
    font-weight: 700;
  }
  .meter-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .meter-head strong {
    font-size: 1.3rem;
    font-variant-numeric: tabular-nums;
  }
  .stars {
    margin-left: auto;
    color: #4a4f59;
    letter-spacing: 0.1em;
  }
  .stars .on {
    color: var(--accent);
  }
  .meter {
    position: relative;
    height: 12px;
    margin: 0.4rem 0 0.5rem;
    border-radius: 6px;
    background: #2b3039;
    overflow: visible;
  }
  .fill {
    height: 100%;
    border-radius: 6px;
    background: linear-gradient(90deg, #8a93a3, #c9ced8);
    transition: width 120ms ease-out;
  }
  .mark {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 2px;
    background: #6b7280;
    transform: translateX(-1px);
  }
  .mark.reached {
    background: var(--accent);
  }
  .targets {
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
    color: var(--muted);
  }
</style>
