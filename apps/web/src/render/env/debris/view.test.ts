import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cellIndex, makeGrid } from '../../../game/grid.ts';
import { cellSurfaceGeometry, ChipPile, LiveChips } from './view.ts';

describe('cellSurfaceGeometry', () => {
  const g = makeGrid([4, 3, 2]);
  const white = () => [1, 1, 1] as const;

  function quads(geo: THREE.BufferGeometry): number {
    return geo.getIndex()!.count / 6;
  }

  it('one cell → 6 outward-facing quads around the origin', () => {
    const e = cellIndex(g, 1, 1, 0);
    const h = 0.01;
    const origin = [0.015, 0.015, 0.005] as const;
    const geo = cellSurfaceGeometry(g, [e], h, origin, white);
    expect(quads(geo)).toBe(6);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      expect(Math.abs(pos.getX(i))).toBeCloseTo(0.005, 7);
      expect(Math.abs(pos.getY(i))).toBeCloseTo(0.005, 7);
      expect(Math.abs(pos.getZ(i))).toBeCloseTo(0.005, 7);
    }
  });

  it('shared faces are skipped; winding agrees with the normals', () => {
    const cells = [cellIndex(g, 0, 0, 0), cellIndex(g, 1, 0, 0), cellIndex(g, 1, 1, 0)];
    const geo = cellSurfaceGeometry(g, cells, 1, [0, 0, 0], (e) => [e, 0, 0]);
    expect(quads(geo)).toBe(3 * 6 - 2 * 2);
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    const idx = geo.getIndex()!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(pos, idx.getX(t));
      b.fromBufferAttribute(pos, idx.getX(t + 1));
      c.fromBufferAttribute(pos, idx.getX(t + 2));
      const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
      const want = new THREE.Vector3().fromBufferAttribute(nor, idx.getX(t));
      expect(n.dot(want)).toBeCloseTo(1, 9);
    }
    // per-cell colour
    expect(geo.getAttribute('color').getX(0)).toBe(cells[0]);
  });
});

describe('chip instancing', () => {
  const geoms = [new THREE.BoxGeometry(1, 1, 1), new THREE.BoxGeometry(1, 2, 1)];
  const mat = new THREE.MeshStandardMaterial();
  const m = new THREE.Matrix4();
  const white = new THREE.Color(1, 1, 1);

  it('live chips are compacted per variant every frame and capped', () => {
    const live = new LiveChips(geoms, mat, 3);
    live.begin();
    for (let i = 0; i < 5; i++) live.push(0, m, white);
    live.push(1, m, white);
    live.end();
    const [a, b] = live.group.children as THREE.InstancedMesh[];
    expect(a!.count).toBe(3);
    expect(b!.count).toBe(1);
    live.begin();
    live.end();
    expect(a!.count).toBe(0);
  });

  it('the pile is a ring buffer: it never grows past its capacity', () => {
    const pile = new ChipPile(geoms, mat, 4);
    for (let i = 0; i < 10; i++) pile.add(0, m.makeTranslation(i, 0, 0), white);
    expect(pile.size).toBe(4);
    const mesh = pile.group.children[0] as THREE.InstancedMesh;
    const got = new THREE.Matrix4();
    mesh.getMatrixAt(0, got);
    // slots 0, 1 were overwritten by chips 8, 9
    expect(new THREE.Vector3().setFromMatrixPosition(got).x).toBe(8);
  });
});
