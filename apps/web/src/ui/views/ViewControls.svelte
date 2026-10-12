<script lang="ts">
  // Controls of the section / X-ray views (design doc 断面ビュー: スライダー, 3軸切り替え;
  // X線モード: 低応力の要素を半透明に). Shown under the view-mode toggle in the side panel.
  import type { Axis } from '../../game/grid.ts';
  import type { HudState } from '../hudState.svelte.ts';
  import { AXES, type ViewSettings } from './viewSettings.svelte.ts';

  interface Props {
    hud: HudState;
    settings: ViewSettings;
    onAxis: (axis: Axis) => void;
  }

  let { hud, settings, onAxis }: Props = $props();

  const percentValue = $derived(Math.round(settings.threshold * 100));
</script>

{#if hud.viewMode === 'section'}
  <div class="controls" role="group" aria-label="断面の設定">
    <div class="row">
      <span class="label">軸</span>
      {#each AXES as a (a.id)}
        <button
          class:active={settings.axis === a.id}
          aria-pressed={settings.axis === a.id}
          title="{a.label}軸に垂直な断面"
          onclick={() => onAxis(a.id)}
        >
          {a.label}
        </button>
      {/each}
      <button
        class="flip"
        class:active={settings.flip}
        aria-pressed={settings.flip}
        title="反対側を表示"
        onclick={() => (settings.flip = !settings.flip)}
      >
        反転
      </button>
    </div>
    <label class="slider">
      <span class="label">位置 <strong>{settings.cut}</strong> / {settings.layers}</span>
      <input
        type="range"
        aria-label="断面の位置"
        aria-valuetext="{settings.cut} / {settings.layers}"
        min="0"
        max={settings.layers}
        step="1"
        bind:value={settings.cut}
      />
    </label>
    <p class="hint">断面をクリックすると内側から削れます</p>
  </div>
{:else if hud.viewMode === 'xray'}
  <div class="controls" role="group" aria-label="X線の設定">
    <label class="slider">
      <span class="label">しきい値 <strong>{percentValue}%</strong></span>
      <input
        type="range"
        aria-label="X線のしきい値"
        aria-valuetext="{percentValue}%"
        min="0"
        max="100"
        step="5"
        value={percentValue}
        oninput={(ev) => (settings.threshold = Number(ev.currentTarget.value) / 100)}
      />
    </label>
    <p class="hint">
      {#if hud.maxUtilization === null}
        解析結果を待っています
      {:else}
        利用率がしきい値未満の要素を半透明に表示
      {/if}
    </p>
  </div>
{/if}

<style>
  .controls {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    margin-top: -0.35rem;
    padding: 0.5rem;
    border-radius: 6px;
    background: #191c22;
    font-size: 0.72rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .row button {
    flex: 1;
    padding: 0.2rem 0;
    font-size: 0.72rem;
  }
  .row .flip {
    flex: 1.6;
    margin-left: 0.3rem;
  }
  .label {
    color: var(--muted);
  }
  .row .label {
    margin-right: 0.3rem;
  }
  .label strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .slider {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  input[type='range'] {
    width: 100%;
    margin: 0;
    accent-color: var(--accent);
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.68rem;
    line-height: 1.35;
  }
</style>
