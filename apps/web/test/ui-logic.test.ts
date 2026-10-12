import { describe, expect, it } from 'vitest';
import {
  colorAt,
  envelope,
  FLAG_KEEP,
  FLAG_OVER,
  legendGradient,
  paintQuads,
  PALETTES,
  srgbToLinear,
} from '../src/render/colormap.ts';
import { ClickTracker, DoubleClickDetector } from '../src/render/gesture.ts';
import { DiffBatcher } from '../src/solver/diffBatcher.ts';
import { shortcutFor, type KeyLike } from '../src/ui/shortcuts.ts';

const key = (k: Partial<KeyLike> & { key: string }): KeyLike => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...k,
});

describe('colour maps', () => {
  it('0 → blue, 1 → red, > 1 → magenta; viridis ends are purple/yellow', () => {
    const c = [0, 0, 0];
    colorAt(PALETTES.stress, 0, c);
    expect(c[2]).toBeGreaterThan(c[0]!);
    colorAt(PALETTES.stress, 1, c);
    expect(c[0]).toBeGreaterThan(0.8);
    expect(c[1]).toBeLessThan(0.3);
    colorAt(PALETTES.stress, 1.0001, c);
    expect(c).toEqual([...PALETTES.stress.over]);
    colorAt(PALETTES.stress, Number.NaN, c);
    expect(c).toEqual([...PALETTES.stress.over]);
    colorAt(PALETTES.viridis, 1, c);
    expect(c).toEqual([...PALETTES.viridis.stops.at(-1)!]);
    colorAt(PALETTES.viridis, -1, c);
    expect(c).toEqual([...PALETTES.viridis.stops[0]!]);
  });

  it('paints 4 vertices per quad with keep/over flags', () => {
    const quadElement = Uint32Array.of(0, 1, 2);
    const colors = new Float32Array(3 * 12);
    const flags = new Uint8Array(3 * 4);
    paintQuads(
      quadElement,
      {
        palette: PALETTES.stress,
        neutral: [0.5, 0.5, 0.5],
        keepTint: [0.3, 0.3, 0.3],
        utilization: Float32Array.of(0.2, 1.5, 0.9),
        keep: Uint8Array.of(1, 0, 0),
      },
      colors,
      flags,
    );
    expect([...flags]).toEqual([FLAG_KEEP, FLAG_KEEP, FLAG_KEEP, FLAG_KEEP, FLAG_OVER, FLAG_OVER, FLAG_OVER, FLAG_OVER, 0, 0, 0, 0]);
    expect([...colors.slice(0, 3)]).toEqual([0.30000001192092896, 0.30000001192092896, 0.30000001192092896]);
    expect(colors[12]).toBeCloseTo(PALETTES.stress.over[0], 6);
  });

  it('envelope takes the element-wise max over load cases; linearisation is monotone', () => {
    expect(envelope([])).toBeNull();
    expect([...envelope([Float32Array.of(0.1, 0.9), Float32Array.of(0.5, 0.2)])!]).toEqual([
      0.5, 0.8999999761581421,
    ]);
    const lin = srgbToLinear([0.2, 0.5, 1]);
    expect(lin[0]).toBeLessThan(lin[1]);
    expect(lin[2]).toBeCloseTo(1, 9);
    expect(legendGradient(PALETTES.stress)).toMatch(/^linear-gradient\(to top, rgb\(/);
  });
});

describe('gestures', () => {
  it('right click vs right drag', () => {
    const t = new ClickTracker();
    t.down({ x: 10, y: 10, t: 0 });
    t.move({ x: 12, y: 11 });
    expect(t.up({ x: 12, y: 11 })).toBe(true);
    t.down({ x: 10, y: 10, t: 0 });
    t.move({ x: 40, y: 10 });
    t.move({ x: 11, y: 10 }); // coming back does not make it a click again
    expect(t.up({ x: 11, y: 10 })).toBe(false);
    expect(t.up({ x: 11, y: 10 })).toBe(false); // no press active
  });

  it('double-click: second press near the first click within the window', () => {
    const d = new DoubleClickDetector(350, 5);
    expect(d.isSecondPress({ x: 0, y: 0, t: 0 })).toBe(false);
    d.clicked({ x: 100, y: 100, t: 1000 });
    expect(d.isSecondPress({ x: 120, y: 100, t: 1100 })).toBe(false); // too far
    d.clicked({ x: 100, y: 100, t: 1000 });
    expect(d.isSecondPress({ x: 102, y: 101, t: 1500 })).toBe(false); // too late
    d.clicked({ x: 100, y: 100, t: 1000 });
    expect(d.isSecondPress({ x: 102, y: 101, t: 1200 })).toBe(true);
    expect(d.isSecondPress({ x: 102, y: 101, t: 1250 })).toBe(false); // consumed
    d.clicked({ x: 100, y: 100, t: 2000 });
    d.reset();
    expect(d.isSecondPress({ x: 100, y: 100, t: 2010 })).toBe(false);
  });
});

describe('keyboard shortcuts', () => {
  it('maps the design-doc keys', () => {
    expect(shortcutFor(key({ key: '1', code: 'Digit1' }))).toEqual({ kind: 'brush', size: 1 });
    expect(shortcutFor(key({ key: '2', code: 'Digit2' }))).toEqual({ kind: 'brush', size: 3 });
    expect(shortcutFor(key({ key: '3' }))).toEqual({ kind: 'brush', size: 5 });
    expect(shortcutFor(key({ key: 'z', ctrlKey: true }))).toEqual({ kind: 'undo' });
    expect(shortcutFor(key({ key: 'z', metaKey: true }))).toEqual({ kind: 'undo' });
    expect(shortcutFor(key({ key: 'Z', metaKey: true, shiftKey: true }))).toEqual({ kind: 'redo' });
    expect(shortcutFor(key({ key: 'y', ctrlKey: true }))).toEqual({ kind: 'redo' });
    expect(shortcutFor(key({ key: ' ', code: 'Space' }))).toEqual({ kind: 'loadTest' });
    expect(shortcutFor(key({ key: 'z' }))).toBeNull();
    expect(shortcutFor(key({ key: '1', code: 'Digit1', ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key({ key: 'c', metaKey: true }))).toBeNull();
  });
});

describe('DiffBatcher', () => {
  it('coalesces diffs and cancels remove-then-restore', () => {
    const b = new DiffBatcher();
    expect(b.take()).toBeNull();
    b.add({ removed: [5, 3], restored: [] });
    b.add({ removed: [], restored: [3] }); // undo of 3 before the flush
    b.add({ removed: [9], restored: [] });
    expect(b.pending).toBe(true);
    expect(b.take()).toEqual({ removed: [5, 9], restored: [] });
    expect(b.pending).toBe(false);
    b.add({ removed: [], restored: [5] });
    b.add({ removed: [5], restored: [] });
    expect(b.pending).toBe(false);
    expect(b.take()).toBeNull();
  });
});
