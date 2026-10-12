<script lang="ts">
  // Utilisation colour legend (design doc 応力の可視化).
  import { cssColor, legendGradient, PALETTES, type PaletteId } from '../render/colormap.ts';

  let { palette }: { palette: PaletteId } = $props();

  const p = $derived(PALETTES[palette]);
  const ticks = [100, 75, 50, 25, 0];
</script>

<div class="legend" aria-label="利用率の凡例">
  <div class="over">
    <span class="swatch blink" style:background={cssColor(p.over)}></span>
    <span>100%超</span>
  </div>
  <div class="scale">
    <div class="bar" style:background={legendGradient(p)}></div>
    <div class="ticks">
      {#each ticks as t (t)}
        <span>{t}%</span>
      {/each}
    </div>
  </div>
  <div class="note"><span class="swatch keep"></span>保護領域</div>
</div>

<style>
  .legend {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.72rem;
    color: var(--muted);
  }
  .over,
  .note {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .swatch {
    display: inline-block;
    width: 14px;
    height: 14px;
    border-radius: 3px;
  }
  .blink {
    animation: blink 0.9s ease-in-out infinite alternate;
  }
  .keep {
    background: repeating-linear-gradient(135deg, #8f97a6 0 3px, #5c6270 3px 6px);
  }
  .scale {
    display: flex;
    gap: 0.4rem;
    height: 130px;
  }
  .bar {
    width: 14px;
    border-radius: 3px;
  }
  .ticks {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
  @keyframes blink {
    from {
      opacity: 1;
    }
    to {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .blink {
      animation: none;
    }
  }
</style>
