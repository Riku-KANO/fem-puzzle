// T-303 section / X-ray views: visibility + picking predicates, masked meshing (cap faces),
// the Three.js layers, and carving through the cut face.

import type { FromWorker, ResultMsg, ToWorker } from '@stress-carve/protocol';
import { describe, expect, it } from 'vitest';
import { brushSelect } from '../src/game/brush.ts';
import { CarveState } from '../src/game/carveState.ts';
import { GameController, type HudModel, type ViewPort } from '../src/game/controller.ts';
import { buildDemoStage } from '../src/game/demoStage.ts';
import { cellIndex, makeGrid, type Grid } from '../src/game/grid.ts';
import { countSurfaceQuads } from '../src/render/mesher.ts';
import { raycastGrid } from '../src/render/picking.ts';
import { ViewLayers } from '../src/render/views/viewLayers.ts';
import {
  cellLook,
  clampCut,
  DEFAULT_XRAY_THRESHOLD,
  defaultAxis,
  facingFlip,
  hiddenByView,
  isGhost,
  keptBySection,
  NORMAL_VIEW,
  pickPredicate,
  viewMasks,
  viewSpecFor,
  type ViewSpec,
} from '../src/render/views/visibility.ts';
import { VoxelMesh } from '../src/render/voxelMesh.ts';
import { SolverClient, type WorkerPort } from '../src/solver/client.ts';

const surface = (nx: number, ny: number, nz: number) => 2 * (nx * ny + ny * nz + nz * nx);
const g = makeGrid([24, 8, 4]);
const full = () => new Uint8Array(g.n).fill(1);
const none = () => new Uint8Array(g.n);
const at = (x: number, y: number, z: number) => cellIndex(g, x, y, z);
const settings = { axis: 0 as const, cut: 10, flip: false, threshold: 0.3 };
const sectionX = (cut: number, flip = false): ViewSpec => ({ section: { axis: 0, cut, flip }, xray: null });
const quads = (m: VoxelMesh) => m.meshes().reduce((s, c) => s + c.data.quadCount, 0);
/** utilisation rising along x: cell x has u = x / 24 */
const rampU = (grid: Grid) => {
  const u = new Float32Array(grid.n);
  for (let e = 0; e < grid.n; e++) u[e] = (e % grid.nx) / grid.nx;
  return u;
};

describe('view spec from the mode toggle', () => {
  it('normal / section / X-ray; settings are clamped', () => {
    expect(viewSpecFor('normal', settings, g)).toBe(NORMAL_VIEW);
    expect(viewSpecFor('section', settings, g)).toEqual({ section: { axis: 0, cut: 10, flip: false }, xray: null });
    expect(viewSpecFor('section', { ...settings, axis: 1, cut: 99 }, g).section?.cut).toBe(8);
    expect(viewSpecFor('xray', settings, g)).toEqual({ section: null, xray: 0.3 });
    expect(viewSpecFor('xray', { ...settings, threshold: 7 }, g).xray).toBe(1);
    expect(viewSpecFor('xray', { ...settings, threshold: Number.NaN }, g).xray).toBe(DEFAULT_XRAY_THRESHOLD);
  });

  it('cut snaps to a layer boundary inside the grid', () => {
    expect(clampCut(g, 0, -3)).toBe(0);
    expect(clampCut(g, 0, 2.6)).toBe(3);
    expect(clampCut(g, 2, 9)).toBe(4);
    expect(clampCut(g, 1, Number.NaN)).toBe(4);
  });

  it('first section axis cuts across the thinnest dimension (ties → z, y)', () => {
    expect(defaultAxis([24, 8, 4])).toBe(2);
    expect(defaultAxis([32, 8, 8])).toBe(2);
    expect(defaultAxis([32, 6, 8])).toBe(1);
    expect(defaultAxis([4, 8, 8])).toBe(0);
    expect(defaultAxis([12, 12, 12])).toBe(2);
  });

  it('default kept side turns the cut face towards the camera', () => {
    // camera on the + side → keep the low half (cap looks towards +axis), and vice versa
    expect(facingFlip(g, 0, [40, 10, 10])).toBe(false);
    expect(facingFlip(g, 0, [-5, 10, 10])).toBe(true);
    expect(facingFlip(g, 1, [12, 20, 2])).toBe(false);
  });
});

describe('visibility predicate', () => {
  it('section keeps one side of the plane on every axis', () => {
    for (const axis of [0, 1, 2] as const) {
      const n = [g.nx, g.ny, g.nz][axis]!;
      const cut = Math.floor(n / 2) + 1;
      const low = viewMasks(g, { section: { axis, cut, flip: false }, xray: null }, null).section!;
      const high = viewMasks(g, { section: { axis, cut, flip: true }, xray: null }, null).section!;
      const layer = g.n / n;
      expect(low.reduce((s, v) => s + v, 0)).toBe(cut * layer);
      expect(high.reduce((s, v) => s + v, 0)).toBe((n - cut) * layer);
      for (let e = 0; e < g.n; e++) expect(low[e]! + high[e]!).toBe(1);
    }
    expect(keptBySection(null, 23, 7, 3)).toBe(true);
    expect(keptBySection({ axis: 2, cut: 2, flip: false }, 0, 0, 1)).toBe(true);
    expect(keptBySection({ axis: 2, cut: 2, flip: false }, 0, 0, 2)).toBe(false);
  });

  it('X-ray ghosts only known, low utilisation; failing cells never fade', () => {
    const u = new Float32Array([0.1, 0.3, 0.29, 1.5, Number.NaN, 0]);
    expect(isGhost(0.3, u, 0)).toBe(true);
    expect(isGhost(0.3, u, 1)).toBe(false); // at the threshold: opaque
    expect(isGhost(0.3, u, 2)).toBe(true);
    expect(isGhost(0.3, u, 3)).toBe(false);
    expect(isGhost(0.3, u, 4)).toBe(false);
    expect(isGhost(null, u, 0)).toBe(false); // X-ray off
    expect(isGhost(0.3, null, 0)).toBe(false); // not solved yet
    expect(isGhost(0.3, u, 99)).toBe(false); // out of range
  });

  it('masks: normal = none; X-ray partitions the kept cells; unsolved X-ray = all opaque', () => {
    expect(viewMasks(g, NORMAL_VIEW, rampU(g))).toEqual({ section: null, opaque: null, ghost: null });
    const m = viewMasks(g, { section: null, xray: 0.25 }, rampU(g));
    for (let e = 0; e < g.n; e++) {
      const x = e % g.nx;
      expect(m.ghost![e]).toBe(x < 6 ? 1 : 0); // 6/24 = 0.25
      expect(m.opaque![e]! + m.ghost![e]!).toBe(1);
    }
    expect(viewMasks(g, { section: null, xray: 0.25 }, null)).toEqual({ section: null, opaque: null, ghost: null });
  });

  it('cell look: empty / hidden / ghost / opaque', () => {
    const solid = full();
    solid[at(0, 0, 0)] = 0;
    const m = viewMasks(g, { section: { axis: 0, cut: 20, flip: false }, xray: 0.25 }, rampU(g));
    expect(cellLook(m, solid, at(0, 0, 0))).toBe('empty');
    expect(cellLook(m, solid, at(1, 0, 0))).toBe('ghost');
    expect(cellLook(m, solid, at(10, 0, 0))).toBe('opaque');
    expect(cellLook(m, solid, at(21, 0, 0))).toBe('hidden');
    expect(hiddenByView(m, at(21, 0, 0))).toBe(true);
    expect(hiddenByView(m, at(1, 0, 0))).toBe(false); // ghosts are visible material
    expect(hiddenByView(viewMasks(g, NORMAL_VIEW, null), at(21, 0, 0))).toBe(false);
  });
});

describe('picking in section / X-ray views (carve what you see)', () => {
  const block = none();
  const solid = full();
  const ray = (spec: ViewSpec, origin: [number, number, number], dir: [number, number, number]) =>
    raycastGrid(g, origin, dir, pickPredicate(viewMasks(g, spec, rampU(g)), { solid, block }));

  it('rays pass hidden cells and hit the cut face', () => {
    const hit = ray(sectionX(10), [40, 3.5, 1.5], [-1, 0, 0])!;
    expect(hit.cell).toEqual([9, 3, 1]);
    expect(hit.face).toBe('x+');
    expect(ray(NORMAL_VIEW, [40, 3.5, 1.5], [-1, 0, 0])!.cell).toEqual([23, 3, 1]);
    // flipped: keep x ≥ 10, looking from x−
    const flipped = ray(sectionX(10, true), [-9, 3.5, 1.5], [1, 0, 0])!;
    expect(flipped.cell).toEqual([10, 3, 1]);
    expect(flipped.face).toBe('x-');
    // a ray that only crosses hidden cells misses
    expect(ray(sectionX(10), [15.5, 20, 1.5], [0, -1, 0])).toBeNull();
  });

  it('X-ray ghosts still stop rays (the brush shaves the translucent skin)', () => {
    const hit = ray({ section: null, xray: 0.5 }, [-9, 3.5, 1.5], [1, 0, 0])!;
    expect(hit.cell).toEqual([0, 3, 1]); // u = 0 → ghost, still hit
  });

  it('obstacles are cut by the section too', () => {
    const b = none();
    const s = full();
    for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) (s[at(23, y, z)] = 0), (b[at(23, y, z)] = 1);
    const masks = viewMasks(g, sectionX(12), null);
    const pick = pickPredicate(masks, { solid: s, block: b });
    expect(pick(at(23, 2, 2))).toBe(false);
    expect(pickPredicate(viewMasks(g, NORMAL_VIEW, null), { solid: s, block: b })(at(23, 2, 2))).toBe(true);
    expect(pick(at(5, 2, 2))).toBe(true);
    expect(pick(at(15, 2, 2))).toBe(false);
  });
});

describe('brush with hidden cells', () => {
  const masks = viewMasks(g, sectionX(10), null);
  const hidden = (e: number) => hiddenByView(masks, e);
  const ctx = { solid: full(), keep: none() };

  it('the cut face is a surface: a 3×3 click carves the cut layer', () => {
    const sel = brushSelect(g, [9, 3, 1], 'x+', 3, { ...ctx, hidden });
    expect(sel.carve.sort((a, b) => a - b)).toEqual(
      [at(9, 2, 0), at(9, 3, 0), at(9, 4, 0), at(9, 2, 1), at(9, 3, 1), at(9, 4, 1), at(9, 2, 2), at(9, 3, 2), at(9, 4, 2)].sort(
        (a, b) => a - b,
      ),
    );
    // without the view the same face is buried (neighbours solid): nothing to carve
    expect(brushSelect(g, [9, 3, 1], 'x+', 3, ctx).carve).toEqual([]);
  });

  it('hidden cells under the brush are never carved', () => {
    // 5×5 on the top face straddling the cut (x 7..11): only the kept columns x = 7..9
    const sel = brushSelect(g, [9, 7, 1], 'y+', 5, { ...ctx, hidden });
    const xs = new Set(sel.carve.map((e) => e % g.nx));
    expect([...xs].sort()).toEqual([7, 8, 9]);
    expect(sel.carve).toHaveLength(3 * 4); // x 7..9 × z 0..3 (z clipped to the grid)
  });
});

describe('masked voxel mesh (exact cap)', () => {
  it('section of a full box = surface of the kept box, cap included and coloured by the cut cell', () => {
    const solid = full();
    const mesh = new VoxelMesh(g, solid, none(), 'stress');
    expect(quads(mesh)).toBe(surface(24, 8, 4));
    const section = viewMasks(g, sectionX(10), null).section!;
    mesh.setMask(section);
    mesh.update();
    expect(quads(mesh)).toBe(surface(10, 8, 4));
    const cap = mesh.meshes().flatMap((c) => [...c.data.quadElement].filter((_, q) => c.data.quadFace[q] === 1));
    // every x+ quad lies on the cut and belongs to a cell of the last kept layer
    expect(cap).toHaveLength(8 * 4);
    expect(cap.every((e) => e % g.nx === 9)).toBe(true);
    mesh.setMask(null);
    mesh.update();
    expect(quads(mesh)).toBe(surface(24, 8, 4));
  });

  it('masked meshing matches meshing the combined flags, after carving too', () => {
    const solid = full();
    for (let x = 4; x < 20; x++) solid[at(x, 7, 2)] = 0; // groove crossing the cut
    solid[at(10, 3, 1)] = 0; // interior void just behind the cut
    const mesh = new VoxelMesh(g, solid, none(), 'stress');
    const mask = viewMasks(g, sectionX(10, true), null).section!;
    mesh.setMask(mask);
    mesh.update();
    const combined = solid.map((s, e) => s & mask[e]!);
    expect(quads(mesh)).toBe(countSurfaceQuads(g, combined));
    // carving a kept cell next to the cut: the scene marks it dirty as usual
    solid[at(11, 3, 1)] = 0;
    mesh.markDirty([at(11, 3, 1)]);
    mesh.update();
    expect(quads(mesh)).toBe(countSurfaceQuads(g, solid.map((s, e) => s & mask[e]!)));
  });

  it('moving the cut rebuilds only chunks around changed cells', () => {
    const mesh = new VoxelMesh(g, full(), none(), 'stress');
    mesh.setMask(viewMasks(g, sectionX(20), null).section);
    mesh.update();
    const before = new Map(mesh.meshes().map((c) => [c.mesh.name, c.mesh]));
    mesh.setMask(viewMasks(g, sectionX(18), null).section); // x = 18, 19 change → chunk 2 only
    mesh.update();
    const after = new Map(mesh.meshes().map((c) => [c.mesh.name, c.mesh]));
    expect(after.get('chunk-0')).toBe(before.get('chunk-0'));
    expect(after.get('chunk-1')).toBe(before.get('chunk-1'));
    expect(after.get('chunk-2')).not.toBe(before.get('chunk-2'));
  });
});

describe('ViewLayers (Three.js side)', () => {
  const setup = () => {
    const cells = { grid: g, solid: full(), keep: none(), block: none() };
    const voxels = new VoxelMesh(g, cells.solid, cells.keep, 'stress');
    const views = new ViewLayers(cells, voxels, 'stress', () => [40, 20, 10]);
    return { cells, voxels, views };
  };

  it('X-ray splits the surface into an opaque load path and a translucent ghost skin', () => {
    const { voxels, views } = setup();
    expect(quads(views.ghost)).toBe(0);
    expect(views.ghost.material.transparent).toBe(true);
    expect(views.ghost.material.depthWrite).toBe(false);
    views.set({ section: null, xray: 0.25 });
    views.update();
    voxels.update();
    expect(quads(voxels)).toBe(surface(24, 8, 4)); // no utilisation yet: everything opaque
    expect(quads(views.ghost)).toBe(0);
    views.setUtilization(rampU(g)); // x < 6 → ghost
    views.update();
    voxels.update();
    expect(quads(voxels)).toBe(surface(18, 8, 4));
    expect(quads(views.ghost)).toBe(surface(6, 8, 4));
    views.set(NORMAL_VIEW);
    views.update();
    voxels.update();
    expect(quads(voxels)).toBe(surface(24, 8, 4));
    expect(quads(views.ghost)).toBe(0);
  });

  it('section: hidden cells, pick filter, mask for the load test, default side', () => {
    const { voxels, views } = setup();
    expect(views.sectionMask).toBeNull();
    expect(views.facingFlip(0)).toBe(false); // eye at x = 40
    views.set(sectionX(10));
    voxels.update();
    expect(quads(voxels)).toBe(surface(10, 8, 4));
    expect(views.isHidden(at(10, 0, 0))).toBe(true);
    expect(views.pickable(at(10, 0, 0))).toBe(false);
    expect(views.pickable(at(9, 0, 0))).toBe(true);
    expect(views.sectionMask?.[at(9, 0, 0)]).toBe(1);
    views.dispose();
  });
});

describe('carving through the cut face (controller)', () => {
  class NullPort implements WorkerPort {
    onmessage: ((ev: MessageEvent<FromWorker>) => void) | null = null;
    onerror: ((ev: ErrorEvent) => void) | null = null;
    postMessage(_m: ToWorker): void {}
    terminate(): void {}
  }
  class View implements ViewPort {
    masks = viewMasks(makeGrid([24, 8, 4]), NORMAL_VIEW, null);
    solidChanged(): void {}
    setUtilization(): void {}
    setResult(_r: ResultMsg): void {}
    elementsRemoved(): void {}
    showBrush(): void {}
    isHidden(e: number): boolean {
      return hiddenByView(this.masks, e);
    }
  }
  const hud = (): HudModel => ({
    volumeFraction: 1,
    solidCount: 0,
    canUndo: false,
    canRedo: false,
    brush: 1,
    solving: false,
    iteration: 0,
    relResidual: 0,
    backend: null,
    maxUtilization: null,
    loadsConnected: true,
    converged: false,
    resultCurrent: false,
    error: null,
    toast: null,
  });

  it('section on: a click on the cut face carves the cut layer; section off: nothing changes', () => {
    const stage = buildDemoStage(); // 24×8×4
    const sg = makeGrid(stage.grid);
    const capHit = {
      element: cellIndex(sg, 10, 4, 1),
      cell: [10, 4, 1] as [number, number, number],
      face: 'z+' as const,
      t: 0,
      point: [10.5, 4.5, 2] as [number, number, number],
    };

    // section off: the same hit is buried under solid z = 2 cells
    const offState = new CarveState(stage);
    const off = new GameController(offState, new SolverClient(new NullPort()), new View(), hud());
    off.setBrush(3);
    off.strokeStart(capHit);
    off.strokeEnd();
    expect(offState.solidCount).toBe(sg.n);
    expect(offState.canUndo).toBe(false);

    // section on (keep z < 2): the cut face is a surface
    const state = new CarveState(stage);
    const view = new View();
    view.masks = viewMasks(sg, { section: { axis: 2, cut: 2, flip: false }, xray: null }, null);
    const c = new GameController(state, new SolverClient(new NullPort()), view, hud());
    c.setBrush(3);
    c.strokeStart(capHit);
    c.strokeEnd();
    expect(state.solidCount).toBe(sg.n - 9);
    for (let x = 9; x <= 11; x++) {
      for (let y = 3; y <= 5; y++) {
        expect(state.solid[cellIndex(sg, x, y, 1)]).toBe(0);
        expect(state.solid[cellIndex(sg, x, y, 2)]).toBe(1); // hidden layer untouched
      }
    }
    c.undo();
    expect(state.solidCount).toBe(sg.n);
  });
});
