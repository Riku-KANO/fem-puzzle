import { describe, expect, it } from 'vitest';
import { CarveState } from '../src/game/carveState.ts';
import { buildDemoStage } from '../src/game/demoStage.ts';
import { cellIndex } from '../src/game/grid.ts';
import { History } from '../src/game/history.ts';

describe('History', () => {
  it('undo/redo walk the stack and a new push clears redo', () => {
    const h = new History<string>();
    expect(h.canUndo).toBe(false);
    h.push('a');
    h.push('b');
    expect(h.undo()).toBe('b');
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe('b');
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBeUndefined();
    expect(h.redoDepth).toBe(2);
    h.push('c');
    expect(h.canRedo).toBe(false);
    expect(h.peek()).toBe('c');
    expect(h.discardTop()).toBe('c');
    expect(h.canRedo).toBe(false);
  });
});

describe('CarveState', () => {
  const stage = buildDemoStage();
  const total = 24 * 8 * 4;

  it('one stroke = one history entry; undo/redo restore the exact solid set', () => {
    const s = new CarveState(stage);
    const g = s.grid;
    const initial = s.toBitmask();
    expect(s.volumeFraction).toBe(1);

    s.beginStroke();
    s.carve([cellIndex(g, 5, 7, 0), cellIndex(g, 5, 7, 1)]);
    s.carve([cellIndex(g, 6, 7, 0), cellIndex(g, 5, 7, 0)]); // duplicate is ignored
    expect(s.endStroke()?.carved).toHaveLength(3);
    expect(s.solidCount).toBe(total - 3);
    const afterFirst = s.toBitmask();

    s.carve([cellIndex(g, 10, 0, 0)]); // implicit stroke
    s.endStroke();
    expect(s.history.undoDepth).toBe(2);

    expect(s.undo()?.restored).toEqual([cellIndex(g, 10, 0, 0)]);
    expect(s.toBitmask()).toBe(afterFirst);
    expect(s.undo()?.restored).toHaveLength(3);
    expect(s.toBitmask()).toBe(initial);
    expect(s.undo()).toBeNull();

    expect(s.redo()?.removed).toHaveLength(3);
    expect(s.toBitmask()).toBe(afterFirst);
    expect(s.canRedo).toBe(true);
    s.carve([cellIndex(g, 0, 0, 0)]);
    s.endStroke();
    expect(s.canRedo).toBe(false);
  });

  it('protected cells cannot be carved', () => {
    const s = new CarveState(stage);
    const load = cellIndex(s.grid, 23, 7, 0);
    expect(s.keep[load]).toBe(1);
    expect(s.carve([load])).toEqual([]);
    expect(s.solid[load]).toBe(1);
    expect(s.endStroke()).toBeNull();
  });

  it('floating debris joins the open stroke, else the newest entry, and undo restores it', () => {
    const s = new CarveState(stage);
    const g = s.grid;
    s.carve([cellIndex(g, 1, 0, 0)]);
    s.removeFloating([cellIndex(g, 2, 0, 0)]);
    const entry = s.endStroke()!;
    expect(entry.floating).toEqual([cellIndex(g, 2, 0, 0)]);

    // result arrives after the stroke closed → amends the newest entry
    s.removeFloating(Uint32Array.of(cellIndex(g, 3, 0, 0), cellIndex(g, 2, 0, 0)));
    expect(entry.floating).toEqual([cellIndex(g, 2, 0, 0), cellIndex(g, 3, 0, 0)]);
    expect(s.solidCount).toBe(total - 3);

    const diff = s.undo()!;
    expect(diff.restored.sort((a, b) => a - b)).toEqual([1, 2, 3].map((x) => cellIndex(g, x, 0, 0)));
    expect(s.solidCount).toBe(total);
    expect(s.redo()?.removed).toHaveLength(3);
    expect(s.solidCount).toBe(total - 3);
  });

  it('discard reverts the newest entry without making it redoable', () => {
    const s = new CarveState(stage);
    s.carve([cellIndex(s.grid, 4, 7, 0)]);
    const entry = s.endStroke()!;
    expect(s.discard(entry)?.restored).toEqual([cellIndex(s.grid, 4, 7, 0)]);
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
    expect(s.discard(entry)).toBeNull();
  });
});
