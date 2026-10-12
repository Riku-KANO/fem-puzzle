import { validateStage } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { buildDemoStage, DEMO_STAGE_ID } from '../src/game/demoStage.ts';
import { buildCatalogue, listStages, pickInitialStage } from '../src/game/stages.ts';
import { loadArrows, supportPatches } from '../src/render/jigs.ts';
import { MockBackend } from '../src/solver/mockBackend.ts';

describe('stage catalogue', () => {
  it('the demo stage is valid', () => {
    expect(validateStage(buildDemoStage())).toEqual([]);
  });

  it('falls back to the demo stage when no stage files exist', () => {
    const cat = buildCatalogue({});
    expect(cat.stages.map((s) => s.stage.id)).toEqual([DEMO_STAGE_ID]);
  });

  it('rejects invalid files and sorts by world, then id', () => {
    const a = { ...buildDemoStage(), id: 'w2-01', world: 2 };
    const b = { ...buildDemoStage(), id: 'w1-02', world: 1 };
    const c = { ...buildDemoStage(), id: 'w1-01', world: 1 };
    const cat = buildCatalogue({ a, b, c, bad: { ...buildDemoStage(), solid: 'AA==' }, junk: 42 });
    expect(cat.stages.map((s) => s.stage.id)).toEqual(['w1-01', 'w1-02', 'w2-01']);
    expect(cat.rejected.map((r) => r.source).sort()).toEqual(['bad', 'junk']);
  });

  it('picks ?stage=<id> or the first stage', () => {
    const cat = buildCatalogue({
      a: { ...buildDemoStage(), id: 'w1-01', world: 1 },
      b: { ...buildDemoStage(), id: 'w1-02', world: 1 },
    });
    expect(pickInitialStage(cat, '?stage=w1-02').stage.id).toBe('w1-02');
    expect(pickInitialStage(cat, '?stage=nope').stage.id).toBe('w1-01');
    expect(pickInitialStage(cat, '').stage.id).toBe('w1-01');
  });

  it('every bundled stage (stages/*.json) is valid and playable with the mock solver', () => {
    const cat = listStages();
    expect(cat.rejected).toEqual([]);
    expect(cat.stages.length).toBeGreaterThan(0);
    for (const { stage } of cat.stages) {
      const r = new MockBackend(stage).computeNow();
      expect(r.loadsConnected, stage.id).toBe(true);
      expect(r.floating.length, stage.id).toBe(0);
      for (const c of r.cases) {
        expect(Number.isFinite(c.maxUtilization), stage.id).toBe(true);
        expect(c.maxUtilization, stage.id).toBeGreaterThan(0);
      }
      expect(supportPatches(stage).length, stage.id).toBeGreaterThan(0);
      expect(loadArrows(stage).length, stage.id).toBeGreaterThan(0);
    }
  });
});
