<script lang="ts">
  // Right: legend, max utilisation, palette and view-mode toggles, solver status
  // (design doc 画面構成). Section / X-ray settings: ui/views/ViewControls (T-303).
  import type { Axis } from '../game/grid.ts';
  import { PALETTES, type PaletteId } from '../render/colormap.ts';
  import { percent, sci } from './format.ts';
  import type { HudState, ViewMode } from './hudState.svelte.ts';
  import Legend from './Legend.svelte';
  import ViewControls from './views/ViewControls.svelte';
  import type { ViewSettings } from './views/viewSettings.svelte.ts';

  interface Props {
    hud: HudState;
    onPalette: (id: PaletteId) => void;
    onViewMode: (mode: ViewMode) => void;
    views: ViewSettings;
    onSectionAxis: (axis: Axis) => void;
  }

  let { hud, onPalette, onViewMode, views, onSectionAxis }: Props = $props();

  const modes: { id: ViewMode; label: string; ready: boolean }[] = [
    { id: 'normal', label: '通常', ready: true },
    { id: 'section', label: '断面', ready: true },
    { id: 'xray', label: 'X線', ready: true },
  ];
  const over = $derived(hud.maxUtilization !== null && hud.maxUtilization > 1);
</script>

<section class="panel side" aria-label="応力表示">
  <div class="max" class:over>
    <span class="label">最大利用率</span>
    <strong>{hud.maxUtilization === null ? '—' : percent(hud.maxUtilization)}</strong>
  </div>

  <Legend palette={hud.palette} />

  <div class="group" role="group" aria-label="カラーパレット">
    {#each Object.values(PALETTES) as p (p.id)}
      <button class:active={hud.palette === p.id} aria-pressed={hud.palette === p.id} onclick={() => onPalette(p.id)}>
        {p.label}
      </button>
    {/each}
  </div>

  <div class="group" role="group" aria-label="表示モード">
    {#each modes as m (m.id)}
      <button
        class:active={hud.viewMode === m.id}
        aria-pressed={hud.viewMode === m.id}
        disabled={!m.ready}
        title={m.ready ? m.label : `${m.label}(準備中)`}
        onclick={() => onViewMode(m.id)}
      >
        {m.label}
      </button>
    {/each}
  </div>
  <ViewControls {hud} settings={views} onAxis={onSectionAxis} />

  <div class="status" aria-live="polite">
    {#if hud.error}
      <span class="error">解析エラー: {hud.error}</span>
    {:else if hud.solving}
      <span class="spinner" aria-hidden="true"></span>
      <span>解析中… 反復 {hud.iteration} · 残差 {sci(hud.relResidual)}</span>
    {:else}
      <span class="done">解析完了</span>
      <span class="muted">反復 {hud.iteration}</span>
    {/if}
    {#if hud.backend}
      <span class="badge" title="ソルバー">{hud.backend}</span>
    {/if}
  </div>

  {#if !hud.loadsConnected}
    <div class="warn" role="alert">荷重点が支点につながっていません</div>
  {/if}
</section>

<style>
  .side {
    width: 180px;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }
  .max {
    display: flex;
    flex-direction: column;
  }
  .max .label {
    font-size: 0.75rem;
    color: var(--muted);
  }
  .max strong {
    font-size: 1.6rem;
    font-variant-numeric: tabular-nums;
  }
  .max.over strong {
    color: #ff4fd8;
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
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.72rem;
    min-height: 2.2em;
  }
  .done {
    color: #7bd88f;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: #ff7a7a;
  }
  .badge {
    margin-left: auto;
    padding: 0 0.35rem;
    border-radius: 3px;
    background: #2b3039;
    color: var(--muted);
  }
  .spinner {
    width: 10px;
    height: 10px;
    border: 2px solid #4a4f59;
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .warn {
    font-size: 0.75rem;
    color: #ffb4b4;
    background: #4a1f25;
    border-radius: 4px;
    padding: 0.35rem 0.5rem;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
