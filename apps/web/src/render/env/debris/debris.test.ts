// DebrisFx end to end in node with the real Rapier WASM: chips spawn, settle into the pile,
// respect the caps, are deterministic, and never touch the carve state the solver reads.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { cellIndex, makeGrid, type Grid } from '../../../game/grid.ts';
import { BENCH_COLLIDERS, PIECE_NAMES } from '../assetSpec.ts';
import { DEBRIS_LIMITS, DebrisFx, type DebrisOptions } from './debris.ts';

const H = 0.01;
const BENCH_Y = -0.16;

/** A stand-in for debris.glb: one small box mesh per piece name. */
function pieces(): Promise<THREE.Object3D> {
  const root = new THREE.Group();
  for (const n of PIECE_NAMES) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.004, 0.006), new THREE.MeshStandardMaterial());
    m.name = n;
    root.add(m);
  }
  return Promise.resolve(root);
}

interface Rig {
  fx: DebrisFx;
  g: Grid;
  solid: Uint8Array;
  block: Uint8Array;
  t: number;
  run(seconds: number): void;
}

function rig(mode: DebrisOptions['mode'], seed = 1): Rig {
  const g = makeGrid([16, 6, 4]);
  const solid = new Uint8Array(g.n).fill(1);
  const block = new Uint8Array(g.n);
  const parent = new THREE.Group();
  const benchOrigin = [(g.nx * H) / 2, BENCH_Y, (g.nz * H) / 2];
  const fx = new DebrisFx({
    parent,
    grid: g,
    h: H,
    solid,
    block,
    mode,
    colorOf: () => [0.2, 0.4, 0.8],
    staticColliders: () =>
      BENCH_COLLIDERS.map((c) => ({
        center: [c.center[0] + benchOrigin[0]!, c.center[1] + benchOrigin[1]!, c.center[2] + benchOrigin[2]!],
        halfExtents: [...c.halfExtents],
      })),
    benchY: BENCH_Y,
    seed,
    preloadDelayMs: 0,
    pieces,
  });
  const r: Rig = {
    fx,
    g,
    solid,
    block,
    t: 1000,
    run(seconds: number) {
      const frames = Math.round(seconds * 60);
      for (let i = 0; i < frames; i++) {
        r.t += 1000 / 60;
        fx.update(r.t);
      }
    },
  };
  fx.update(r.t);
  return r;
}

/** Carve the top layer cells x0..x1 (z all) like a brush would: flip solid, then notify. */
function carveTop(r: Rig, x0: number, x1: number): number[] {
  const cells: number[] = [];
  for (let z = 0; z < r.g.nz; z++) for (let x = x0; x <= x1; x++) cells.push(cellIndex(r.g, x, r.g.ny - 1, z));
  for (const e of cells) r.solid[e] = 0;
  r.fx.solidChanged(cells);
  r.fx.removed(cells, 'carve');
  return cells;
}

async function ready(r: Rig): Promise<void> {
  await vi.waitFor(() => expect(r.fx.stats.ready).toBe(true), { timeout: 10_000, interval: 10 });
}

describe('DebrisFx (Rapier in node)', () => {
  it('carved voxels spawn chips that fall and settle into the pile', async () => {
    const r = rig('physics');
    await ready(r);
    carveTop(r, 2, 5); // 16 cells → 32 chips
    const before = Uint8Array.from(r.solid);
    r.run(0.1);
    expect(r.fx.stats.spawned).toBe(32);
    expect(r.fx.stats.live).toBeGreaterThan(0);
    r.run(10);
    const s = r.fx.stats;
    expect(s.live).toBe(0);
    expect(s.queued).toBe(0);
    expect(s.piled + s.faded + s.lost).toBe(32);
    expect(s.piled).toBeGreaterThan(0);
    expect(s.pile).toBe(s.piled);
    expect(s.failed).toBe(false);
    // purely visual: the carve state is exactly what the carve left
    expect(r.solid).toEqual(before);
    r.fx.dispose();
  });

  it('is deterministic for a seed', async () => {
    const outcome = async () => {
      const r = rig('physics', 7);
      await ready(r);
      carveTop(r, 0, 15);
      r.run(10);
      const s = { ...r.fx.stats };
      r.fx.dispose();
      return [s.spawned, s.piled, s.faded, s.lost];
    };
    expect(await outcome()).toEqual(await outcome());
  });

  it('caps live bodies and the per-frame spawn budget', async () => {
    const r = rig('physics');
    await ready(r);
    let maxLive = 0;
    for (let k = 0; k < 6; k++) {
      // whole layers at a time: far more chips than the cap
      const cells: number[] = [];
      const y = r.g.ny - 1 - k;
      for (let z = 0; z < r.g.nz; z++) for (let x = 0; x < r.g.nx; x++) cells.push(cellIndex(r.g, x, y, z));
      for (const e of cells) r.solid[e] = 0;
      r.fx.solidChanged(cells);
      r.fx.removed(cells, 'carve');
      for (let f = 0; f < 6; f++) {
        const spawnedBefore = r.fx.stats.spawned;
        r.run(1 / 60);
        expect(r.fx.stats.spawned - spawnedBefore).toBeLessThanOrEqual(DEBRIS_LIMITS.spawnPerFrame);
        maxLive = Math.max(maxLive, r.fx.stats.live);
        expect(r.fx.stats.queued).toBeLessThanOrEqual(DEBRIS_LIMITS.maxQueue);
      }
    }
    expect(maxLive).toBeLessThanOrEqual(DEBRIS_LIMITS.maxLive);
    r.run(12);
    expect(r.fx.stats.live).toBe(0);
    r.fx.dispose();
  });

  it('a floating piece falls as one chunk; undo brings the cells back and the chunk goes', async () => {
    const r = rig('physics');
    await ready(r);
    const cells: number[] = [];
    for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 10; x < 13; x++) cells.push(cellIndex(r.g, x, y, z));
    for (const e of cells) r.solid[e] = 0;
    r.fx.solidChanged(cells);
    r.fx.removed(cells, 'floating');
    r.run(1 / 60);
    expect(r.fx.stats.chunks).toBe(1);
    expect(r.fx.stats.spawned).toBe(0);
    const chunk = r.fx.group.getObjectByName('debris-chunk')!;
    const y0 = chunk.position.y;
    r.run(2);
    expect(chunk.position.y).toBeLessThan(y0 - 0.05); // fell onto the bed
    expect(chunk.position.y).toBeGreaterThan(BENCH_Y);
    // undo: the cells are solid again → the chunk shrinks away
    for (const e of cells) r.solid[e] = 1;
    r.fx.solidChanged(cells);
    r.run(1);
    expect(r.fx.stats.chunks).toBe(0);
    r.fx.dispose();
  });

  it('tiny floating bits crumble into chips', async () => {
    const r = rig('physics');
    await ready(r);
    const cells = [cellIndex(r.g, 0, 0, 0), cellIndex(r.g, 15, 0, 3)];
    for (const e of cells) r.solid[e] = 0;
    r.fx.solidChanged(cells);
    r.fx.removed(cells, 'floating');
    r.run(0.1);
    expect(r.fx.stats.chunks).toBe(0);
    expect(r.fx.stats.spawned).toBe(4);
    r.fx.dispose();
  });
});

describe('DebrisFx without physics', () => {
  it('fade (reduced motion): removed voxels fade in place, Rapier is never loaded', () => {
    const r = rig('fade');
    r.run(0.6); // let the GPU warm-up ghost expire
    carveTop(r, 0, 3);
    r.run(1 / 60);
    expect(r.fx.stats.ghosts).toBe(1);
    r.run(0.2);
    expect(r.fx.stats.ghosts).toBe(1);
    r.run(0.4);
    expect(r.fx.stats.ghosts).toBe(0);
    expect(r.fx.stats.ready).toBe(false);
    expect(r.fx.stats.spawned).toBe(0);
    r.fx.dispose();
  });

  it('off (e2e): nothing at all', () => {
    const r = rig('off');
    carveTop(r, 0, 3);
    r.run(0.5);
    expect(r.fx.stats).toMatchObject({ ghosts: 0, spawned: 0, live: 0, ready: false });
    r.fx.dispose();
  });

  it('physics mode before Rapier is ready falls back to fading', () => {
    const r = rig('physics');
    r.run(0.6);
    carveTop(r, 0, 3);
    r.run(1 / 60);
    expect(r.fx.stats.ready).toBe(false);
    expect(r.fx.stats.ghosts).toBe(1);
    r.fx.dispose();
  });
});
