<script lang="ts">
  // Brief feedback line (e.g. 保護領域は削れません).
  import type { HudState } from './hudState.svelte.ts';

  let { hud }: { hud: HudState } = $props();

  let visible = $state<{ text: string; id: number } | null>(null);

  $effect(() => {
    const t = hud.toast;
    if (!t) return;
    visible = t;
    const timer = setTimeout(() => {
      if (visible?.id === t.id) visible = null;
    }, 1600);
    return () => clearTimeout(timer);
  });
</script>

<div class="toast-slot" aria-live="assertive">
  {#if visible}
    {#key visible.id}
      <div class="toast">{visible.text}</div>
    {/key}
  {/if}
</div>

<style>
  .toast-slot {
    min-height: 2rem;
    display: flex;
    justify-content: center;
  }
  .toast {
    padding: 0.4rem 0.9rem;
    border-radius: 999px;
    background: rgba(74, 31, 37, 0.92);
    color: #ffd2d2;
    font-size: 0.85rem;
    animation: pop 160ms ease-out;
  }
  @keyframes pop {
    from {
      transform: translateY(6px);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
