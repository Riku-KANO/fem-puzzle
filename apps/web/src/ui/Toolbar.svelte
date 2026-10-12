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
  }

  let { hud, onBrush, onUndo, onRedo }: Props = $props();

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
  <button disabled title="載荷テスト(準備中)">載荷テスト</button>
  <button class="primary" disabled title="提出(準備中)">提出</button>
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
  .primary:not(:disabled) {
    background: var(--accent);
    color: #1a1a1a;
  }
</style>
