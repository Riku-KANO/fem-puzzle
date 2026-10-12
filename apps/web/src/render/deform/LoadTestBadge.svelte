<script lang="ts">
  // HUD chip above the toolbar while the load test runs: exaggeration factor, outcome
  // (within limits / over-stressed elements breaking / pieces falling off).
  import { formatScale } from './deform.ts';
  import type { LoadTestStatus } from './loadTest.ts';

  interface Props {
    status: LoadTestStatus;
  }

  let { status }: Props = $props();

  const shown = $derived(status.state !== 'idle');
  const over = $derived(status.overstressed > 0);
  // the outcome is revealed once the load is fully applied (or at once without motion)
  const revealed = $derived(
    status.state === 'holding' || (status.phase !== null && !['lift', 'descend', 'load'].includes(status.phase)),
  );
</script>

{#if shown}
  <div class="panel badge" class:over={over && revealed} role="status" aria-live="polite">
    {#if status.state === 'waiting'}
      <span>載荷テスト: 解析の完了を待っています…</span>
    {:else}
      <span class="title">載荷テスト</span>
      <span class="scale" title="変形の誇張倍率(自動調整)">
        変形 {status.scale > 0 ? formatScale(status.scale) : 'なし'}
      </span>
      {#if status.caseName}
        <span class="muted">荷重ケース {status.caseName}</span>
      {/if}
      {#if revealed}
        {#if over}
          <span class="verdict over">
            許容応力超過 {status.overstressed}要素{status.broken > 0 ? ` · 破断 ${status.broken}` : ''}
          </span>
          {#if status.collapsed > 0}
            <span class="verdict over">崩壊 {status.collapsed}片が脱落</span>
          {/if}
        {:else}
          <span class="verdict ok">許容応力以内</span>
        {/if}
      {/if}
      {#if status.state === 'holding'}
        <span class="muted">スペースで終了</span>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .badge {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    pointer-events: none;
  }
  .title {
    font-weight: 600;
  }
  .scale {
    font-variant-numeric: tabular-nums;
    color: var(--accent);
  }
  .muted {
    color: var(--muted);
  }
  .verdict.ok {
    color: #6fd08c;
  }
  .verdict.over {
    color: #ff5ad9;
    font-weight: 600;
  }
  .badge.over {
    border-color: #ff2bd6;
  }
</style>
