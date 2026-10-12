<script lang="ts">
  // Result screen (design doc スコア / 1ステージの流れ step 5): stars, volume, per-rule status,
  // "最適化解との差" with a badge when the player beats the optimiser, and the benchmark overlay
  // toggle. A card over the 3D view (not a modal) so the overlay and the camera turn stay visible.
  import type { Targets } from '@stress-carve/protocol';
  import { percent } from '../format.ts';
  import type { OverlayMode } from './benchmarkOverlay.ts';
  import type { ResultSession } from './resultSession.svelte.ts';
  import {
    benchmarkText,
    goalText,
    isNewBest,
    OUTCOME_TITLES,
    ruleValueText,
    STATUS_ICONS,
    STATUS_LABELS,
    type PreviousBest,
  } from './resultText.ts';

  interface Props {
    session: ResultSession;
    targets: Targets;
    /** the latest result still describes the submitted design; false closes the screen */
    current: boolean;
    /** overrides `session.previousBest` (the best read via `session.bestOf` before recording) */
    previousBest?: PreviousBest | null;
    onNext?: () => void;
    onSelect?: () => void;
  }

  let { session, targets, current, previousBest: bestProp = null, onNext, onSelect }: Props = $props();

  const previousBest = $derived(bestProp ?? session.previousBest);

  const j = $derived(session.submission?.judgement ?? null);
  const bench = $derived(j?.benchmark ? benchmarkText(j.benchmark, j.passed) : null);
  const newBest = $derived(j !== null && previousBest !== null && isNewBest(previousBest, j));
  const goal = $derived(j ? goalText(j, targets) : null);
  const thresholds = $derived([
    { stars: 1, value: targets.star1 },
    { stars: 2, value: targets.star2 },
    { stars: 3, value: targets.star3 },
  ]);
  const overlayModes: { id: OverlayMode; label: string }[] = [
    { id: 'off', label: '自分の形' },
    { id: 'overlay', label: '重ねて比較' },
    { id: 'only', label: '最適化解のみ' },
  ];

  // Any change to the design (undo, carving after closing…) makes the verdict stale.
  $effect(() => {
    if (!current) session.close();
  });

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && session.submission) {
      ev.preventDefault();
      session.close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if j}
  <section
    class="panel result"
    class:is-clear={j.outcome === 'clear'}
    class:is-fail={j.outcome === 'fail'}
    aria-labelledby="result-title"
    aria-live="polite"
  >
    <header>
      <div class="outcome">{OUTCOME_TITLES[j.outcome]}</div>
      <h2 id="result-title">{j.headline}</h2>
    </header>

    <div class="score">
      <div class="stars" aria-label={`星 ${j.stars}`}>
        {#each [1, 2, 3] as s (s)}
          <span class:on={s <= j.stars}>★</span>
        {/each}
      </div>
      <div class="volume">
        <span class="label">体積率</span>
        <strong>{percent(j.volumeFraction, 1)}</strong>
        {#if newBest}<span class="new-best">自己ベスト更新</span>{/if}
      </div>
    </div>

    <div class="targets">
      {#each thresholds as t (t.stars)}
        <span class:reached={j.volumeFraction <= t.value + 1e-9}>{'★'.repeat(t.stars)} {percent(t.value)}</span>
      {/each}
    </div>
    {#if goal}<p class="goal">{goal}</p>{/if}
    {#if previousBest && !newBest}
      <p class="muted small">自己ベスト {'★'.repeat(previousBest.stars) || '☆'} {percent(previousBest.volumeFraction, 1)}</p>
    {/if}

    <div class="bench">
      {#if j.benchmark && bench}
        <div class="bench-line">
          <span>最適化解 {percent(j.benchmark.volumeFraction, 1)}</span>
          <span
            class="delta"
            class:ahead={j.benchmark.relation === 'beaten'}
            class:behind={j.benchmark.relation === 'behind'}>{bench.text}</span
          >
        </div>
        {#if bench.badge}<div class="badge-beat" role="status">{bench.badge}</div>{/if}
        {#if session.hasBenchmark}
          <div class="group" role="group" aria-label="最適化解の表示">
            {#each overlayModes as m (m.id)}
              <button
                class:active={session.overlay === m.id}
                aria-pressed={session.overlay === m.id}
                onclick={() => session.setOverlay(m.id)}>{m.label}</button
              >
            {/each}
          </div>
        {/if}
      {:else}
        <span class="muted small">このステージには最適化解のデータがありません</span>
      {/if}
    </div>

    <ul class="rules" aria-label="判定">
      {#each j.rules as r (r.id)}
        {@const value = ruleValueText(r)}
        <li class="rule {r.status}">
          <span class="icon" aria-label={STATUS_LABELS[r.status]}>{STATUS_ICONS[r.status]}</span>
          <span class="name">{r.label}</span>
          <span class="msg">
            {r.message}
            {#if value}<span class="value">{value}</span>{/if}
          </span>
        </li>
      {/each}
    </ul>

    {#if j.cases.length > 1}
      <table class="cases">
        <thead><tr><th>荷重ケース</th><th>最大利用率</th></tr></thead>
        <tbody>
          {#each j.cases as c, i (i)}
            <tr class:over={!c.strength}><td>{c.name}</td><td>{percent(c.maxUtilization)}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <footer>
      <button onclick={() => session.close()} title="結果を閉じて削り続ける(Esc)">続けて削る</button>
      {#if onSelect}<button onclick={onSelect}>ステージ選択へ</button>{/if}
      {#if onNext && j.outcome === 'clear'}<button class="primary" onclick={onNext}>次のステージへ</button>{/if}
    </footer>
  </section>
{/if}

<style>
  .result {
    width: 360px;
    max-height: calc(100vh - 140px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    border-top: 3px solid #6b7280;
    animation: rise 220ms ease-out;
  }
  .result.is-clear {
    border-top-color: var(--accent);
  }
  .result.is-fail {
    border-top-color: #ff6b6b;
  }
  header .outcome {
    font-size: 0.75rem;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  .is-clear header .outcome {
    color: var(--accent);
  }
  .is-fail header .outcome {
    color: #ff8a8a;
  }
  h2 {
    margin: 0.1rem 0 0;
    font-size: 1.05rem;
    line-height: 1.35;
  }
  .score {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .stars {
    font-size: 2rem;
    letter-spacing: 0.08em;
    color: #3a3f49;
    line-height: 1;
  }
  .stars .on {
    color: var(--accent);
    text-shadow: 0 0 12px rgba(240, 162, 59, 0.45);
  }
  .volume {
    display: flex;
    flex-direction: column;
  }
  .volume .label {
    font-size: 0.72rem;
    color: var(--muted);
  }
  .volume strong {
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
  }
  .new-best {
    font-size: 0.7rem;
    color: #7bd88f;
  }
  .targets {
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
    color: var(--muted);
  }
  .targets .reached {
    color: var(--accent);
  }
  .goal {
    margin: 0;
    font-size: 0.78rem;
    color: #ffd27a;
  }
  .bench {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    background: rgba(92, 200, 255, 0.07);
    border: 1px solid rgba(92, 200, 255, 0.25);
  }
  .bench-line {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.4rem;
    font-size: 0.8rem;
  }
  .delta {
    font-variant-numeric: tabular-nums;
  }
  .delta.ahead {
    color: #7bd88f;
  }
  .delta.behind {
    color: #c9ced8;
  }
  .badge-beat {
    align-self: flex-start;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    background: linear-gradient(90deg, #5cc8ff, #b18cff);
    color: #10131a;
    font-weight: 700;
    font-size: 0.8rem;
  }
  .group {
    display: flex;
    gap: 2px;
  }
  .group button {
    flex: 1;
    padding: 0.3rem 0.2rem;
    font-size: 0.75rem;
  }
  .rules {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
  }
  .rules li {
    display: grid;
    grid-template-columns: 1.2rem 4.2rem 1fr;
    align-items: baseline;
  }
  .icon {
    font-weight: 700;
  }
  .rule.pass .icon {
    color: #7bd88f;
  }
  .rule.fail .icon {
    color: #ff6b6b;
  }
  .rule.unknown .icon,
  .rule.na .icon {
    color: var(--muted);
  }
  .rule.na,
  .rule.unknown {
    color: var(--muted);
  }
  .rule.fail .msg {
    color: #ffb4b4;
  }
  .value {
    display: block;
    font-size: 0.72rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .cases {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
  }
  .cases th {
    text-align: left;
    font-weight: 400;
    color: var(--muted);
  }
  .cases td:last-child,
  .cases th:last-child {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .cases tr.over td {
    color: #ff4fd8;
  }
  footer {
    display: flex;
    gap: 0.4rem;
    justify-content: flex-end;
  }
  .primary {
    background: var(--accent);
    color: #1a1a1a;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    margin: 0;
    font-size: 0.72rem;
  }
  @keyframes rise {
    from {
      transform: translateY(-8px);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .result {
      animation: none;
    }
  }
</style>
