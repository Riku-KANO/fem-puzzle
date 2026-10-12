<script lang="ts">
  // Bottom toolbar (design doc 画面構成): brush size, undo/redo, load test (T-302),
  // submit (T-301).
  import { BRUSH_SIZES, type BrushSize } from '../game/brush.ts';
  import type { HudState } from './hudState.svelte.ts';

  interface Props {
    hud: HudState;
    onBrush: (size: BrushSize) => void;
    onUndo: () => void;
    onRedo: () => void;
    /** load test (T-302): a result exists / the test is running / start-stop */
    canLoadTest?: boolean;
    loadTestActive?: boolean;
    onLoadTest?: () => void;
    /** submit gate (T-301: game/judge `submitGate`) */
    canSubmit?: boolean;
    submitTitle?: string;
    /** a blocking reason shown next to the button (e.g. 構造が安定していません) */
    submitHint?: string | null;
    onSubmit?: () => void;
  }

  let {
    hud,
    onBrush,
    onUndo,
    onRedo,
    canLoadTest = false,
    loadTestActive = false,
    onLoadTest,
    canSubmit = false,
    submitTitle = '提出',
    submitHint = null,
    onSubmit,
  }: Props = $props();

  const brushLabel = (s: BrushSize) => `${s}×${s}`;
</script>

<nav class="panel toolbar" aria-label="ツールバー">
  <div class="group" role="group" aria-label="ブラシサイズ">
    {#each BRUSH_SIZES as s, i (s)}
      <button
        class:active={hud.brush === s}
        aria-pressed={hud.brush === s}
        title={`ブラシ ${brushLabel(s)}(キー ${i + 1})`}
        onclick={() => onBrush(s)}
      >
        <span class="key">{i + 1}</span>{brushLabel(s)}
      </button>
    {/each}
  </div>
  <div class="sep"></div>
  <button disabled={!hud.canUndo} title="元に戻す(Ctrl/⌘+Z・右クリック)" onclick={onUndo}>↶ 元に戻す</button>
  <button disabled={!hud.canRedo} title="やり直す(Shift+Ctrl/⌘+Z)" onclick={onRedo}>↷ やり直す</button>
  <div class="sep"></div>
  <button
    class:active={loadTestActive}
    aria-pressed={loadTestActive}
    disabled={!onLoadTest || (!canLoadTest && !loadTestActive)}
    title={loadTestActive ? '載荷テストを終了(スペース)' : '載荷テスト(スペース)'}
    onclick={() => onLoadTest?.()}
  >
    載荷テスト
  </button>
  {#if submitHint}<span class="hint" role="status">{submitHint}</span>{/if}
  <button class="primary" disabled={!canSubmit} title={submitTitle} onclick={() => onSubmit?.()}>提出</button>
</nav>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .group {
    display: flex;
    gap: 2px;
  }
  .key {
    display: inline-block;
    margin-right: 0.3rem;
    padding: 0 0.25rem;
    border-radius: 3px;
    background: #2b3039;
    color: var(--muted);
    font-size: 0.65rem;
  }
  .sep {
    width: 1px;
    align-self: stretch;
    background: #333843;
    margin: 0 0.2rem;
  }
  .hint {
    font-size: 0.72rem;
    color: #ffb4b4;
    white-space: nowrap;
  }
  .primary:not(:disabled) {
    background: var(--accent);
    color: #1a1a1a;
  }
</style>
