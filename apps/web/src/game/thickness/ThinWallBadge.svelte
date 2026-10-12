<script lang="ts">
  // Thin-wall warning pill (design doc リスク: 最小肉厚2ボクセル、下回ると警告表示). Hidden
  // while nothing is thin; a click toggles the dot tint on the model. Not a failure rule.
  import type { ThinWallHud } from './thinWallHud.svelte.ts';

  let { hud }: { hud: ThinWallHud } = $props();

  const tip =
    '肉厚が2ボクセル未満の部分です。細すぎる部材は応力の計算精度が下がります(判定には影響しません)。クリックで模様の表示を切り替え';
</script>

{#if hud.count > 0}
  <button
    class="thin-walls"
    class:off={!hud.tint}
    aria-pressed={hud.tint}
    aria-label={`薄い部分 ${hud.count} ボクセル。模様を${hud.tint ? '隠す' : '表示'}`}
    title={tip}
    onclick={() => hud.toggleTint()}
  >
    <span class="swatch" aria-hidden="true"></span>
    <span>薄い部分</span>
    <strong>{hud.count}</strong>
    <span class="unit">ボクセル</span>
  </button>
{/if}

<style>
  .thin-walls {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.5rem;
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    border-color: #5a4a2c;
    background: rgba(43, 37, 28, 0.88);
    color: #f3d7a6;
    font-size: 0.75rem;
  }
  .thin-walls:hover:not(:disabled) {
    background: rgba(58, 49, 34, 0.92);
  }
  strong {
    font-variant-numeric: tabular-nums;
  }
  .unit {
    color: var(--muted);
  }
  .swatch {
    width: 12px;
    height: 12px;
    border-radius: 2px;
    background-color: #c4c8cf;
    background-image: radial-gradient(circle, #3b3d42 1.4px, transparent 1.6px);
    background-size: 4px 4px;
    background-position: 0 0;
  }
  .off .swatch {
    background-image: none;
  }
  .off {
    opacity: 0.7;
  }
</style>
