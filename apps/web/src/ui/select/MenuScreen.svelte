<script lang="ts">
  // Everything outside a stage: title (#/) and stage select (#/select[/w<n>]).
  // Records are read when this screen mounts, i.e. every time the player leaves a stage; the
  // App flushes the open stage's carve in `router.onBeforeChange`, before this mounts (T-315).
  import { untrack } from 'svelte';
  import type { StageCatalogue } from '../../game/stages.ts';
  import type { ProgressStore } from '../../game/progress/index.ts';
  import { menuSnapshot } from './menuSnapshot.ts';
  import type { HashRouter } from './router.svelte.ts';
  import { initialWorld } from './selectView.ts';
  import StageSelect from './StageSelect.svelte';
  import TitleScreen from './TitleScreen.svelte';

  interface Props {
    router: HashRouter;
    catalogue: StageCatalogue;
    progress: ProgressStore;
  }

  let { router, catalogue, progress }: Props = $props();

  // Snapshot per mount (records only change while a stage is open).
  const snapshot = untrack(() => menuSnapshot(catalogue, progress));

  const route = $derived(router.route);
  const world = $derived(initialWorld(snapshot.campaign, route.kind === 'select' ? route.world : null));
  const stars = $derived(snapshot.campaign.worlds.reduce((s, w) => s + w.stars, 0));
  const maxStars = $derived(snapshot.campaign.worlds.reduce((s, w) => s + w.maxStars, 0));
  const continueTitle = $derived(
    snapshot.continueId === null ? null : (snapshot.info.get(snapshot.continueId)?.title ?? snapshot.continueId),
  );
</script>

{#if route.kind === 'select'}
  <StageSelect
    campaign={snapshot.campaign}
    info={snapshot.info}
    {world}
    health={snapshot.health}
    notice={router.notice}
    onWorld={(w) => router.navigate({ kind: 'select', world: w }, { replace: true })}
    onStage={(id) => router.navigate({ kind: 'stage', id })}
    onTitle={() => router.navigate({ kind: 'title' })}
  />
{:else}
  <TitleScreen
    {stars}
    {maxStars}
    {continueTitle}
    fresh={snapshot.fresh}
    health={snapshot.health}
    onContinue={() => snapshot.continueId !== null && router.navigate({ kind: 'stage', id: snapshot.continueId })}
    onSelect={() => router.navigate({ kind: 'select', world: null })}
  />
{/if}
