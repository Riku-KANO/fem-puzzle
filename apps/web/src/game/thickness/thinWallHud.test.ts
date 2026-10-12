import { describe, expect, it } from 'vitest';
import { FLAG_KEEP, FLAG_OVER, FLAG_THIN, linearPalette, NEUTRAL, KEEP_TINT, paintQuads, PALETTES } from '../../render/colormap.ts';
import { cellIndex, makeGrid } from '../grid.ts';
import { ThinWallHud } from './thinWallHud.svelte.ts';
import { ThinWallMap } from './thinWalls.ts';

function plateView() {
  const g = makeGrid([6, 6, 6]);
  const solid = new Uint8Array(g.n);
  for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) for (const y of [2, 3]) solid[cellIndex(g, x, y, z)] = 1;
  const thinWalls = new ThinWallMap(g, solid, new Uint8Array(g.n));
  const tint: (Uint8Array | null)[] = [];
  const view = { thinWalls, voxels: { setThin: (t: Uint8Array | null) => void tint.push(t) } };
  return { g, solid, thinWalls, view, tint };
}

describe('thin-wall HUD state', () => {
  it('follows the count, toggles the tint and stops after detach', () => {
    const { g, solid, thinWalls, view, tint } = plateView();
    const hud = new ThinWallHud();
    const detach = hud.attach(view);
    expect(hud.count).toBe(0);
    expect(tint.at(-1)).toBe(thinWalls.thin);

    // carve the upper layer of one row: the lower layer under it becomes 1 thick
    const row: number[] = [];
    for (let x = 0; x < 6; x++) row.push(cellIndex(g, x, 3, 2));
    for (const e of row) solid[e] = 0;
    thinWalls.update(row);
    expect(hud.count).toBe(thinWalls.count);
    expect(hud.count).toBeGreaterThan(0);

    hud.toggleTint();
    expect(hud.tint).toBe(false);
    expect(tint.at(-1)).toBeNull();
    hud.toggleTint();
    expect(tint.at(-1)).toBe(thinWalls.thin);

    detach();
    for (const e of row) solid[e] = 1;
    thinWalls.update(row);
    expect(thinWalls.count).toBe(0);
    expect(hud.count).toBeGreaterThan(0); // no longer following
  });

  it('attaching a new view replaces the old one; a stale detach is a no-op', () => {
    const a = plateView();
    const b = plateView();
    const hud = new ThinWallHud();
    const detachA = hud.attach(a.view);
    hud.attach(b.view);
    detachA(); // must not detach b
    const e = cellIndex(b.g, 0, 3, 0);
    b.solid[e] = 0;
    b.thinWalls.update([e]);
    expect(hud.count).toBe(b.thinWalls.count);
    expect(hud.count).toBeGreaterThan(0);
  });
});

describe('thin-wall vertex flag', () => {
  it('paintQuads sets FLAG_THIN on thin, unprotected cells only, alongside the other bits', () => {
    const quadElement = new Uint32Array([0, 1, 2, 3]);
    const keep = new Uint8Array([0, 0, 1, 0]);
    const thin = new Uint8Array([1, 0, 1, 1]);
    const utilization = new Float32Array([0.5, 0.5, 0.5, 1.5]);
    const colors = new Float32Array(4 * 12);
    const flags = new Uint8Array(4 * 4);
    const input = {
      palette: linearPalette(PALETTES.stress),
      neutral: NEUTRAL,
      keepTint: KEEP_TINT,
      utilization,
      keep,
      thin,
    };
    paintQuads(quadElement, input, colors, flags);
    expect(Array.from(flags)).toEqual([
      ...Array(4).fill(FLAG_THIN),
      ...Array(4).fill(0),
      ...Array(4).fill(FLAG_KEEP), // protected: never thin-tinted
      ...Array(4).fill(FLAG_OVER | FLAG_THIN),
    ]);
    paintQuads(quadElement, { ...input, thin: null }, colors, flags);
    expect(Array.from(flags).some((f) => f & FLAG_THIN)).toBe(false);
  });
});
