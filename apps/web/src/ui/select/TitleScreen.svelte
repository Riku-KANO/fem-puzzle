<script lang="ts">
  // Title screen: logo, つづきから / ステージ選択, total stars, storage warnings.
  import type { ProgressHealth } from '../../game/progress/index.ts';
  import { storageWarning } from './selectView.ts';

  interface Props {
    stars: number;
    maxStars: number;
    /** title of the stage つづきから / はじめる opens; null hides the button */
    continueTitle: string | null;
    /** nothing played yet: the primary button reads はじめる */
    fresh: boolean;
    health: ProgressHealth;
    onContinue: () => void;
    onSelect: () => void;
  }

  let { stars, maxStars, continueTitle, fresh, health, onContinue, onSelect }: Props = $props();

  const warning = $derived(storageWarning(health));
  // Decorative carved cantilever: columns coloured by a fake utilisation gradient.
  const columns = [0.95, 0.85, 0.72, 0.6, 0.5, 0.42, 0.34, 0.26, 0.2, 0.14, 0.1, 0.08];
  // Tapered toward the loaded tip with one lightening hole, like a carved solution.
  const depth = [4, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1];
  const solid = (x: number, y: number) => y < (depth[x] ?? 0) && !(x === 5 && y === 1);
  const color = (u: number) => `hsl(${Math.round(240 * (1 - u))} 75% ${45 + 10 * (1 - u)}%)`;
</script>

<section class="title" aria-labelledby="title-heading">
  <svg class="beam" viewBox="0 -14 132 58" aria-hidden="true">
    <rect x="0" y="-2" width="6" height="46" fill="#4a505c" />
    {#each columns as u, x (x)}
      {#each [0, 1, 2, 3] as y (y)}
        {#if solid(x, y)}
          <rect x={8 + x * 10} y={2 + y * 10} width="9" height="9" rx="1" fill={color(u)} />
        {/if}
      {/each}
    {/each}
    <path d="M122.5 -13 L122.5 -1 M118.5 -5 L122.5 0 L126.5 -5" stroke="var(--accent)" stroke-width="1.6" fill="none" />
  </svg>
  <h1 id="title-heading">
    <span class="jp">応力彫刻</span>
    <span class="en">STRESS CARVE</span>
  </h1>
  <p class="tagline">荷重のかかったブロックを削り、壊れないギリギリの最軽量構造を彫り出す。</p>

  <div class="menu">
    {#if continueTitle !== null}
      <button class="primary" onclick={onContinue}>
        {fresh ? 'はじめる' : 'つづきから'}
        <small>{continueTitle}</small>
      </button>
    {/if}
    <button class:primary={continueTitle === null} onclick={onSelect}>ステージ選択</button>
  </div>

  <p class="stars" aria-label={`獲得した星 ${stars} / ${maxStars}`}>
    <span aria-hidden="true">★</span>
    {stars} / {maxStars}
  </p>
  {#if warning}
    <p class="warn" role="status">{warning}</p>
  {/if}
</section>

<style>
  .title {
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 2rem 16px;
    text-align: center;
    background: radial-gradient(ellipse at 50% 35%, #232833 0%, var(--bg) 70%);
  }
  .beam {
    width: min(360px, 80vw);
    height: auto;
  }
  h1 {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .jp {
    font-size: clamp(2.4rem, 8vw, 4rem);
    font-weight: 800;
    letter-spacing: 0.12em;
  }
  .en {
    font-size: 0.9rem;
    letter-spacing: 0.5em;
    color: var(--accent);
  }
  .tagline {
    margin: 0;
    max-width: 32rem;
    color: var(--muted);
    line-height: 1.6;
  }
  .menu {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    width: min(280px, 100%);
    margin-top: 0.5rem;
  }
  .menu button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.7rem 1rem;
    font-size: 1rem;
  }
  .menu small {
    font-size: 0.75rem;
    opacity: 0.8;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #1a1a1a;
    font-weight: 700;
  }
  .primary:hover:not(:disabled) {
    background: #f5b358;
  }
  .stars {
    margin: 0;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .stars span {
    color: var(--accent);
  }
  .warn {
    margin: 0;
    max-width: 30rem;
    padding: 0.5rem 0.8rem;
    border-radius: 6px;
    background: rgba(74, 58, 31, 0.9);
    color: #ffe2b0;
    font-size: 0.85rem;
  }
</style>
