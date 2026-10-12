<script lang="ts">
  // In-stage menu above the stage panel: back to the stage select (the carve is saved
  // automatically) and restart from the authored block (asks for a second press).
  import type { ResumeStatus } from '../../game/progress/index.ts';

  interface Props {
    /** how the open stage started (a new object per opened session); 'resumed' shows a notice */
    resume: { status: ResumeStatus };
    onSelect: () => void;
    onRestart: () => void;
  }

  let { resume, onSelect, onRestart }: Props = $props();

  let confirming = $state(false);
  let showResume = $state(false);

  $effect(() => {
    if (resume.status !== 'resumed') {
      showResume = false;
      return;
    }
    showResume = true;
    const timer = setTimeout(() => (showResume = false), 4000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => (confirming = false), 3000);
    return () => clearTimeout(timer);
  });

  function restart(): void {
    if (!confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    onRestart();
  }
</script>

<nav class="game-menu" aria-label="ゲームメニュー">
  <button onclick={onSelect} title="ステージ選択へ(削った形は自動で保存されます)">← ステージ選択</button>
  <button class:confirm={confirming} onclick={restart} title="削った形を捨てて最初からやり直す">
    {confirming ? 'もう一度押すとリセット' : '最初から'}
  </button>
  {#if showResume}
    <span class="note" role="status">前回の続きから再開しました</span>
  {/if}
</nav>

<style>
  .game-menu {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
    max-width: 280px;
  }
  button {
    background: var(--panel-alpha);
    backdrop-filter: blur(6px);
  }
  button.confirm {
    border-color: #c0504d;
    color: #ffb4b0;
  }
  .note {
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
