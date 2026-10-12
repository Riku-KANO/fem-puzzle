import { describe, expect, it } from 'vitest';
import {
  buildCampaign,
  clearsToUnlockNext,
  continueStageId,
  nextStageId,
  nextUnlockedStageId,
  worldName,
  type StageRef,
} from '../src/game/progress/campaign.ts';
import type { StageRecord, Stars } from '../src/game/progress/records.ts';
import { listStages } from '../src/game/stages.ts';

const refs = (spec: Record<number, number>): StageRef[] =>
  Object.entries(spec).flatMap(([w, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `w${w}-0${i + 1}`, world: Number(w) })),
  );

const rec = (stars: Stars): StageRecord => ({
  stars,
  volume: 0.5,
  beatBenchmark: false,
  clears: 1,
  firstAt: 0,
  lastAt: 0,
  solid: '',
});

const lookup = (records: Record<string, Stars>) => (id: string) =>
  records[id] !== undefined ? rec(records[id]!) : null;

const unlocked = (stages: StageRef[], records: Record<string, Stars>): string[] =>
  buildCampaign(stages, lookup(records))
    .worlds.flatMap((w) => w.stages)
    .filter((s) => s.unlocked)
    .map((s) => s.id);

describe('campaign unlocks', () => {
  const stages = refs({ 1: 3, 2: 3 });

  it('a new player has only the first stage open', () => {
    const c = buildCampaign(stages, () => null);
    expect(unlocked(stages, {})).toEqual(['w1-01']);
    expect(c.worlds.map((w) => [w.world, w.unlocked])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(c.worlds[0]).toMatchObject({ name: '工房入門', cleared: 0, needed: 3, stars: 0, maxStars: 9 });
  });

  it('clearing a stage (≥ 1 star) opens the next one; a 0-star pass does not', () => {
    expect(unlocked(stages, { 'w1-01': 1 })).toEqual(['w1-01', 'w1-02']);
    expect(unlocked(stages, { 'w1-01': 0 })).toEqual(['w1-01']);
    expect(unlocked(stages, { 'w1-01': 3, 'w1-02': 2 })).toEqual(['w1-01', 'w1-02', 'w1-03']);
  });

  it('the next world opens after ceil(75 %) of the previous world is cleared', () => {
    expect(clearsToUnlockNext(3)).toBe(3);
    expect(clearsToUnlockNext(4)).toBe(3);
    expect(clearsToUnlockNext(8)).toBe(6);
    expect(clearsToUnlockNext(10)).toBe(8);
    const four = refs({ 1: 4, 2: 2 });
    const cleared3 = { 'w1-01': 1, 'w1-02': 1, 'w1-03': 1 } as const;
    expect(unlocked(four, cleared3)).toEqual(['w1-01', 'w1-02', 'w1-03', 'w1-04', 'w2-01']);
    expect(unlocked(four, { 'w1-01': 1, 'w1-02': 1 })).toEqual(['w1-01', 'w1-02', 'w1-03']);
  });

  it('records in a locked world do not open it (no skipping via old saves)', () => {
    expect(unlocked(stages, { 'w2-01': 3, 'w2-02': 3 })).toEqual(['w1-01']);
  });

  it('a world 2 stage cleared before W2 opened still shows as cleared', () => {
    const c = buildCampaign(stages, lookup({ 'w2-01': 3 }));
    expect(c.byId.get('w2-01')).toMatchObject({ unlocked: false, cleared: true, stars: 3, number: 1 });
  });

  it('world 0 (demo / sandbox) is always open and outside the chain', () => {
    const withDemo = [{ id: 'demo', world: 0 }, ...stages];
    expect(unlocked(withDemo, {})).toEqual(['demo', 'w1-01']);
    expect(worldName(0)).toBe('その他');
    expect(worldName(9)).toBe('ワールド 9');
  });

  it('every bundled stage file: the first stage is open, all others locked for a new player', () => {
    const cat = listStages();
    const all = cat.stages.map((e) => ({ id: e.stage.id, world: e.stage.world }));
    const open = unlocked(all, {});
    expect(open[0]).toBe(all[0]!.id);
    expect(open.filter((id) => all.find((s) => s.id === id)!.world > 0).length).toBeLessThanOrEqual(1);
  });
});

describe('next / continue', () => {
  const stages = refs({ 1: 3, 2: 2 });

  it('nextStageId walks play order across worlds and ends with null', () => {
    expect(nextStageId(stages, 'w1-01')).toBe('w1-02');
    expect(nextStageId(stages, 'w1-03')).toBe('w2-01');
    expect(nextStageId(stages, 'w2-02')).toBeNull();
    expect(nextStageId(stages, 'nope')).toBeNull();
  });

  it('nextUnlockedStageId is null when the next stage is still locked', () => {
    const c1 = buildCampaign(stages, lookup({ 'w1-01': 1 }));
    expect(nextUnlockedStageId(c1, stages, 'w1-01')).toBe('w1-02');
    const c2 = buildCampaign(stages, lookup({ 'w1-01': 1, 'w1-02': 1 }));
    expect(nextUnlockedStageId(c2, stages, 'w1-03')).toBeNull(); // W2 needs 3 clears
    const c3 = buildCampaign(stages, lookup({ 'w1-01': 1, 'w1-02': 1, 'w1-03': 1 }));
    expect(nextUnlockedStageId(c3, stages, 'w1-03')).toBe('w2-01');
  });

  it('continueStageId prefers the last opened unfinished stage, then the next open one', () => {
    const none = buildCampaign(stages, () => null);
    expect(continueStageId(none, null)).toBe('w1-01');
    const some = buildCampaign(stages, lookup({ 'w1-01': 2 }));
    expect(continueStageId(some, 'w1-02')).toBe('w1-02');
    expect(continueStageId(some, 'w1-01')).toBe('w1-02');
    expect(continueStageId(some, 'unknown')).toBe('w1-02');
    const all = buildCampaign(stages, lookup({ 'w1-01': 3, 'w1-02': 3, 'w1-03': 3, 'w2-01': 3, 'w2-02': 3 }));
    expect(continueStageId(all, 'w1-02')).toBe('w1-02');
    expect(continueStageId(all, null)).toBe('w1-01');
  });
});
