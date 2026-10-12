<script lang="ts">
  // World / stage select: world tabs (progressive unlock), stage cards with best stars and
  // volume, benchmark badge and in-progress carve.
  import type { Campaign, ProgressHealth } from '../../game/progress/index.ts';
  import { percent } from '../format.ts';
  import {
    cardAriaLabel,
    lockedWorldHint,
    stageLabel,
    starString,
    storageWarning,
    worldSummary,
  } from './selectView.ts';

  interface StageInfo {
    title: string;
    grid: readonly [number, number, number];
    /** volume fraction of the saved in-progress carve, null = none */
    inProgress: number | null;
  }

  interface Props {
    campaign: Campaign;
    info: ReadonlyMap<string, StageInfo>;
    world: number | null;
    health: ProgressHealth;
    notice: string | null;
    onWorld: (world: number) => void;
    onStage: (id: string) => void;
    onTitle: () => void;
  }

  let { campaign, info, world, health, notice, onWorld, onStage, onTitle }: Props = $props();

  const worlds = $derived(campaign.worlds);
  const activeIndex = $derived(Math.max(0, worlds.findIndex((w) => w.world === world)));
  const active = $derived(worlds[activeIndex]);
  const next = $derived(worlds[activeIndex + 1]);
  const totalStars = $derived(worlds.reduce((s, w) => s + w.stars, 0));
  const maxStars = $derived(worlds.reduce((s, w) => s + w.maxStars, 0));
  const warning = $derived(storageWarning(health));

  function onTabKey(ev: KeyboardEvent): void {
    const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    ev.preventDefault();
    const target = worlds[(activeIndex + step + worlds.length) % worlds.length];
    if (target) onWorld(target.world);
  }
</script>

<section class="select" aria-labelledby="select-heading">
  <header>
    <button class="back" onclick={onTitle} title="タイトルへ戻る">← タイトル</button>
    <h1 id="select-heading">ステージ選択</h1>
    <span class="total" aria-label={`獲得した星 ${totalStars} / ${maxStars}`}>
      <span aria-hidden="true">★</span>
      {totalStars} / {maxStars}
    </span>
  </header>

  {#if notice}
    <p class="banner" role="alert">{notice}</p>
  {/if}
  {#if warning}
    <p class="banner warn" role="status">{warning}</p>
  {/if}

  <div class="tabs" role="tablist" aria-label="ワールド" tabindex="-1" onkeydown={onTabKey}>
    {#each worlds as w, i (w.world)}
      <button
        role="tab"
        id={`world-tab-${w.world}`}
        aria-selected={i === activeIndex}
        aria-controls="world-panel"
        tabindex={i === activeIndex ? 0 : -1}
        class:active={i === activeIndex}
        class:locked={!w.unlocked}
        onclick={() => onWorld(w.world)}
      >
        <span class="wnum">{w.world > 0 ? `W${w.world}` : '—'}</span>
        <span class="wname">{w.name}</span>
        {#if w.unlocked}
          <span class="wstars">★ {w.stars}/{w.maxStars}</span>
        {:else}
          <svg class="lock" viewBox="0 0 16 16" aria-label="未解放" role="img">
            <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
            <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.6" fill="none" />
          </svg>
        {/if}
      </button>
    {/each}
  </div>

  {#if active}
    <div class="world" id="world-panel" role="tabpanel" aria-labelledby={`world-tab-${active.world}`}>
      <div class="world-head">
        <h2>{active.world > 0 ? `ワールド${active.world}` : ''} {active.name}</h2>
        <span class="summary">
          {active.unlocked ? worldSummary(active, next) : lockedWorldHint(worlds[activeIndex - 1])}
        </span>
      </div>
      <ul class="cards">
        {#each active.stages as s (s.id)}
          {@const meta = info.get(s.id)}
          {@const title = meta?.title ?? s.id}
          {@const inProgress = meta?.inProgress ?? null}
          <li>
            <button
              class="card"
              class:cleared={s.cleared}
              class:locked={!s.unlocked}
              disabled={!s.unlocked}
              aria-label={cardAriaLabel(s, title, inProgress)}
              onclick={() => onStage(s.id)}
            >
              <span class="row top">
                <span class="num">{stageLabel(s)}</span>
                {#if s.unlocked}
                  <span class="stars" class:none={s.stars === 0}>{starString(s.stars)}</span>
                {:else}
                  <svg class="lock" viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
                    <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.6" fill="none" />
                  </svg>
                {/if}
              </span>
              <span class="name">{title}</span>
              {#if !s.unlocked}
                <span class="meta">前のステージをクリアで解放</span>
              {:else}
                <span class="row meta">
                  {#if s.record}
                    <span>最良 <strong>{percent(s.record.volume, 1)}</strong></span>
                  {:else}
                    <span>未クリア</span>
                  {/if}
                  {#if meta}
                    <span class="grid">{meta.grid.join('×')}</span>
                  {/if}
                </span>
                <span class="row badges">
                  {#if s.record?.beatBenchmark}
                    <span class="badge bench">最適化解超え</span>
                  {/if}
                  {#if inProgress !== null}
                    <span class="badge progress">途中 {percent(inProgress, 1)}</span>
                  {/if}
                </span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  .select {
    height: 100%;
    box-sizing: border-box;
    overflow-y: auto;
    padding: 1.25rem 16px 2rem;
    max-width: 960px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  h1 {
    margin: 0;
    font-size: 1.3rem;
  }
  .total {
    margin-left: auto;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .total span {
    color: var(--accent);
  }
  .banner {
    margin: 0;
    padding: 0.5rem 0.8rem;
    border-radius: 6px;
    background: rgba(74, 31, 37, 0.92);
    color: #ffd2d2;
    font-size: 0.85rem;
  }
  .banner.warn {
    background: rgba(74, 58, 31, 0.9);
    color: #ffe2b0;
  }
  .tabs {
    display: flex;
    gap: 0.4rem;
    overflow-x: auto;
    padding-bottom: 2px;
  }
  .tabs button {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.5rem 0.8rem;
  }
  .tabs button.locked {
    color: var(--muted);
  }
  .wnum {
    font-weight: 700;
  }
  .wstars {
    font-size: 0.75rem;
    color: var(--muted);
  }
  .lock {
    width: 14px;
    height: 14px;
    flex: none;
  }
  .world-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem 1rem;
    margin-bottom: 0.75rem;
  }
  h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .summary {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(210px, 100%), 1fr));
    gap: 0.75rem;
  }
  .card {
    width: 100%;
    height: 100%;
    min-height: 7.5rem;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.35rem;
    padding: 0.75rem 0.85rem;
    text-align: left;
    white-space: normal;
    background: var(--panel);
    border: 1px solid #2c313b;
    border-radius: 8px;
  }
  .card:hover:not(:disabled) {
    background: #262b34;
    border-color: #4a505c;
  }
  .card.cleared {
    border-color: #5a4a2c;
  }
  .card.locked {
    opacity: 0.55;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .num {
    font-weight: 700;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .stars {
    color: var(--accent);
    letter-spacing: 0.08em;
  }
  .stars.none {
    color: #4a4f59;
  }
  .name {
    font-size: 0.95rem;
    font-weight: 600;
    line-height: 1.35;
  }
  .meta {
    font-size: 0.78rem;
    color: var(--muted);
  }
  .meta strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .grid {
    font-variant-numeric: tabular-nums;
  }
  .badges {
    justify-content: flex-start;
    flex-wrap: wrap;
    margin-top: auto;
  }
  .badge {
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.7rem;
  }
  .badge.bench {
    background: rgba(240, 162, 59, 0.18);
    color: var(--accent);
  }
  .badge.progress {
    background: #2b3039;
    color: #b9c2d0;
  }
</style>
