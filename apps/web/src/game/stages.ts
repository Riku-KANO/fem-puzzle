// Stage catalogue: every `stages/*.json` at the repo root (bundled by Vite at build time),
// falling back to the built-in demo stage while none exist. T-304 builds the stage select
// on top of `listStages()`.

import { validateStage, type Stage } from '@stress-carve/protocol';
import { buildDemoStage } from './demoStage.ts';

export interface StageEntry {
  stage: Stage;
  /** where it came from, for error messages */
  source: string;
}

export interface StageCatalogue {
  stages: StageEntry[];
  /** files that failed validation (skipped) */
  rejected: { source: string; errors: string[] }[];
}

// Path is relative to this file: src/game → apps/web/src → apps/web → apps → repo root.
const stageModules = import.meta.glob<unknown>('../../../../stages/*.json', {
  eager: true,
  import: 'default',
});

/** Validate raw modules into a sorted catalogue (world, then id). Pure; exported for tests. */
export function buildCatalogue(modules: Record<string, unknown>): StageCatalogue {
  const stages: StageEntry[] = [];
  const rejected: StageCatalogue['rejected'] = [];
  for (const [source, raw] of Object.entries(modules)) {
    const errors = looksLikeStage(raw) ? validateStage(raw) : ['not a stage object'];
    if (errors.length > 0) rejected.push({ source, errors });
    else stages.push({ stage: raw as Stage, source });
  }
  stages.sort((a, b) => a.stage.world - b.stage.world || a.stage.id.localeCompare(b.stage.id));
  if (stages.length === 0) stages.push({ stage: buildDemoStage(), source: 'built-in demo' });
  return { stages, rejected };
}

function looksLikeStage(raw: unknown): raw is Stage {
  if (typeof raw !== 'object' || raw === null) return false;
  const s = raw as Partial<Stage>;
  return (
    typeof s.id === 'string' &&
    Array.isArray(s.grid) &&
    s.grid.length === 3 &&
    typeof s.solid === 'string' &&
    typeof s.keep === 'string' &&
    Array.isArray(s.supports) &&
    Array.isArray(s.loads) &&
    typeof s.targets === 'object' &&
    typeof s.material === 'object'
  );
}

let cached: StageCatalogue | null = null;

/** All playable stages (never empty). */
export function listStages(): StageCatalogue {
  cached ??= buildCatalogue(stageModules);
  return cached;
}

/** `?stage=<id>` if it exists, else the first stage. T-304 replaces this with hash routing. */
export function pickInitialStage(catalogue: StageCatalogue, search: string): StageEntry {
  const wanted = new URLSearchParams(search).get('stage');
  const first = catalogue.stages[0];
  if (!first) throw new Error('stage catalogue is empty');
  return catalogue.stages.find((s) => s.stage.id === wanted) ?? first;
}
