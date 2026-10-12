import { decodeBitmask, elementCount, encodeBitmask, type Face, type Stage, type Vec3 } from '@stress-carve/protocol';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildDemoStage } from '../../game/demoStage.ts';
import { listStages } from '../../game/stages.ts';
import { BENCH_DROP, JIG_BOUNDS, type Aabb } from './assetSpec.ts';
import { computeLayout, loadPartBoxes, poseMatrix, type LoadJig, type Pose, type SupportJig } from './placement.ts';

const EPS = 1e-9;

function axes(p: Pose): { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 } {
  const q = new THREE.Quaternion(...p.quaternion);
  return {
    x: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    y: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    z: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
  };
}

function expectVec(v: THREE.Vector3, want: Vec3, digits = 9): void {
  expect(v.x).toBeCloseTo(want[0], digits);
  expect(v.y).toBeCloseTo(want[1], digits);
  expect(v.z).toBeCloseTo(want[2], digits);
}

/** Solid cell centres (m) strictly inside a box shrunk by `shrink`. */
function solidCellsInside(stage: Stage, box: Aabb, shrink = 1e-4): number {
  const [nx, ny, nz] = stage.grid;
  const h = stage.voxelSize;
  const solid = decodeBitmask(stage.solid, elementCount(stage.grid));
  let n = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (!solid[x + nx * (y + ny * z)]) continue;
        // test the whole cell box, not only its centre
        const lo = [x * h, y * h, z * h];
        const hi = [(x + 1) * h, (y + 1) * h, (z + 1) * h];
        let overlap = true;
        for (let k = 0; k < 3; k++) {
          if (!(hi[k]! > box.min[k]! + shrink && lo[k]! < box.max[k]! - shrink)) overlap = false;
        }
        if (overlap) n++;
      }
  return n;
}

/** Common invariants of a support jig: orthonormal right-handed basis, +Y = normal, body outside. */
function checkSupport(stage: Stage, j: SupportJig): void {
  const a = axes(j.pose);
  expectVec(a.y, j.normal);
  expect(a.x.dot(a.y)).toBeCloseTo(0, 12);
  expectVec(new THREE.Vector3().crossVectors(a.x, a.y), [a.z.x, a.z.y, a.z.z]);
  // local X is the long axis
  expect(j.patch[0]).toBeGreaterThanOrEqual(j.patch[1] - EPS);
  // the jig body (y >= 0 local, the clamp plate dips 4 mm into its pocket) stays outside the part
  const body: Aabb = { ...JIG_BOUNDS[j.asset], min: [JIG_BOUNDS[j.asset].min[0], 0.0005, JIG_BOUNDS[j.asset].min[2]] };
  const m = poseMatrix(j.pose);
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
    new THREE.Vector3(
      i & 1 ? body.max[0] : body.min[0],
      i & 2 ? body.max[1] : body.min[1],
      i & 4 ? body.max[2] : body.min[2],
    ).applyMatrix4(m),
  );
  const origin = new THREE.Vector3(...j.pose.position);
  for (const c of corners) expect(c.clone().sub(origin).dot(a.y)).toBeGreaterThan(0);
  if (j.riser) {
    const r = j.riser;
    expect(r.pose.position[1]).toBeCloseTo(-BENCH_DROP, 12);
    expect(r.pose.position[1] + r.height).toBeCloseTo(j.bounds.min[1], 12);
    expect(r.height).toBeGreaterThan(0);
    // the column never cuts through the part
    expect(solidCellsInside(stage, r.bounds)).toBe(0);
  }
}

/** Common invariants of a load jig: −Y = F̂, right-handed basis, body clear of the part. */
function checkLoad(stage: Stage, j: LoadJig): void {
  const a = axes(j.pose);
  expectVec(a.y, [-j.dir[0], -j.dir[1], -j.dir[2]]);
  expect(a.x.dot(a.y)).toBeCloseTo(0, 12);
  expectVec(new THREE.Vector3().crossVectors(a.x, a.y), [a.z.x, a.z.y, a.z.z]);
  expect(j.pose.scale).toEqual([1, 1, 1]);
  // no part of the jig (body, spreader plate) pokes into material: sample each oriented box
  if (j.covered) return;
  const m = poseMatrix(j.pose);
  for (const b of loadPartBoxes(j.kind, j.spreader, j.offset)) {
    const lifted: Aabb = { min: [b.min[0], b.min[1] + j.lift, b.min[2]], max: [b.max[0], b.max[1] + j.lift, b.max[2]] };
    expect(solidSamplesInside(stage, lifted, m)).toBe(0);
  }
}

/** Points of an oriented box (7³ lattice incl. the surface) strictly inside a solid cell. */
function solidSamplesInside(stage: Stage, box: Aabb, m: THREE.Matrix4, margin = 1e-4): number {
  const [nx, ny, nz] = stage.grid;
  const h = stage.voxelSize;
  const solid = decodeBitmask(stage.solid, elementCount(stage.grid));
  const p = new THREE.Vector3();
  let n = 0;
  const N = 6;
  for (let a = 0; a <= N; a++)
    for (let b = 0; b <= N; b++)
      for (let c = 0; c <= N; c++) {
        p.set(
          box.min[0] + ((box.max[0] - box.min[0]) * a) / N,
          box.min[1] + ((box.max[1] - box.min[1]) * b) / N,
          box.min[2] + ((box.max[2] - box.min[2]) * c) / N,
        ).applyMatrix4(m);
        const q = [p.x / h, p.y / h, p.z / h];
        const cell = q.map(Math.floor);
        if (cell.some((v, k) => v < 0 || v >= [nx, ny, nz][k]!)) continue;
        if (!solid[cell[0]! + nx * (cell[1]! + ny * cell[2]!)]) continue;
        if (q.every((v, k) => v - cell[k]! > margin / h && cell[k]! + 1 - v > margin / h)) n++;
      }
  return n;
}


describe('jig placement for every stage in stages/*.json', () => {
  const stages = listStages().stages.map((s) => s.stage);

  it('finds the stages', () => {
    expect(stages.length).toBeGreaterThan(0);
  });

  for (const stage of stages) {
    it(`${stage.id}: bench, supports and loads`, () => {
      const L = computeLayout(stage);
      const [nx, , nz] = stage.grid;
      expect(L.benchOrigin).toEqual([(nx * stage.voxelSize) / 2, -BENCH_DROP, (nz * stage.voxelSize) / 2]);
      expect(L.supports.length).toBeGreaterThanOrEqual(stage.supports.length);
      for (const j of L.supports) checkSupport(stage, j);
      const loadCount = stage.loads.filter((l) => l.cells.length > 0).length;
      expect(L.loads.length).toBeGreaterThan(0);
      expect(L.loads.length).toBeLessThanOrEqual(loadCount * Math.max(1, stage.loadCases?.length ?? 1));
      for (const j of L.loads) checkLoad(stage, j);
    });
  }

  it('w1-01: x- clamp scaled to the face, riser below it, cylinder on a spreader at the tip', () => {
    const stage = stages.find((s) => s.id === 'w1-01');
    if (!stage) return;
    const L = computeLayout(stage);
    expect(L.supports).toHaveLength(1);
    const c = L.supports[0]!;
    expect(c.kind).toBe('clamp');
    expectVec(new THREE.Vector3(...c.pose.position), [0, 0.04, 0.02], 12);
    expect(c.patch).toEqual([0.08, 0.04]);
    expect(c.pose.scale[0]).toBeCloseTo(1.0, 12);
    expect(c.pose.scale[2]).toBeCloseTo(0.6, 12);
    const a = axes(c.pose);
    expectVec(a.x, [0, 1, 0]); // long axis = Y (8 cells high)
    expectVec(a.y, [-1, 0, 0]);
    expect(c.riser).not.toBeNull();
    expect(c.riser!.height).toBeCloseTo(0.16 + 0.04 - 0.0605, 9);
    expect(L.loads).toHaveLength(1);
    const l = L.loads[0]!;
    expect(l.kind).toBe('cylinder');
    expect(l.pose.position[0]).toBeCloseTo(0.23, 12);
    expect(l.pose.position[1]).toBeCloseTo(0.08, 12);
    expect(l.pose.position[2]).toBeCloseTo(0.02, 12);
    expectVec(axes(l.pose).y, [0, 1, 0]);
    expectVec(axes(l.pose).z, [0, 0, 1]); // camera side
    expect(l.spreader![0]).toBeCloseTo(0.02, 12);
    expect(l.spreader![1]).toBeCloseTo(0.04, 12);
    expect(l.offset).toBe(0.008);
  });

  it('w2-01: pin + roller under the ends with risers, cylinder on a spreader mid-span', () => {
    const stage = stages.find((s) => s.id === 'w2-01');
    if (!stage) return;
    const L = computeLayout(stage);
    expect(L.supports.map((s) => s.kind)).toEqual(['pin', 'roller']);
    for (const s of L.supports) {
      expectVec(axes(s.pose).y, [0, -1, 0]);
      expectVec(axes(s.pose).x, [0, 0, 1]); // pin axis across the beam
      expect(s.pose.scale).toEqual([1, 1, 1]);
      expect(s.riser!.height).toBeCloseTo(0.1, 12);
      expect(s.riser!.pose.position[2]).toBeCloseTo(0.04, 12);
    }
    expect(L.supports[0]!.pose.position[0]).toBeCloseTo(0.01, 12);
    expect(L.supports[1]!.pose.position[0]).toBeCloseTo(0.31, 12);
    const l = L.loads[0]!;
    expectVec(new THREE.Vector3(...l.pose.position), [0.16, 0.08, 0.04], 12);
    expect(l.spreader![0]).toBeCloseTo(0.02, 12);
    expect(l.spreader![1]).toBeCloseTo(0.08, 12);
  });
});

// --- synthetic stages: every face and force direction ------------------------

function boxStage(grid: Vec3, patch: Partial<Stage>): Stage {
  const n = grid[0] * grid[1] * grid[2];
  return {
    ...buildDemoStage(),
    grid,
    solid: encodeBitmask(new Uint8Array(n).fill(1)),
    keep: encodeBitmask(new Uint8Array(n)),
    ...patch,
  };
}

const FACE_NORMALS: Record<Face, Vec3> = {
  'x-': [-1, 0, 0],
  'x+': [1, 0, 0],
  'y-': [0, -1, 0],
  'y+': [0, 1, 0],
  'z-': [0, 0, -1],
  'z+': [0, 0, 1],
};

describe('support jigs on every face', () => {
  for (const face of Object.keys(FACE_NORMALS) as Face[]) {
    for (const fix of ['xyz', 'y'] as const) {
      it(`${face} fix=${fix}: +Y = outward normal, outside the part, riser unless on top`, () => {
        const stage = boxStage([10, 6, 4], { supports: [{ face, fix }] });
        const L = computeLayout(stage);
        expect(L.supports).toHaveLength(1);
        const j = L.supports[0]!;
        expect(j.kind).toBe(fix === 'xyz' ? 'clamp' : 'roller');
        expect(j.normal).toEqual(FACE_NORMALS[face]);
        checkSupport(stage, j);
        if (face === 'y+') expect(j.riser).toBeNull();
        else expect(j.riser).not.toBeNull();
      });
    }
  }

  it('listed cells → pin, one jig per 4-connected cluster', () => {
    const stage = boxStage([10, 6, 4], {
      supports: [
        {
          face: 'y-',
          fix: 'xyz',
          cells: [
            [0, 0, 0],
            [0, 0, 1],
            [0, 0, 2],
            [9, 0, 0],
            [9, 0, 1],
          ],
        },
      ],
    });
    const L = computeLayout(stage);
    expect(L.supports.map((s) => s.kind)).toEqual(['pin', 'pin']);
    expect(L.supports[0]!.patch[0]).toBeCloseTo(0.03, 12);
    expect(L.supports[0]!.pose.scale[0]).toBeCloseTo(0.03 / 0.08, 12);
    expect(L.supports[1]!.patch[0]).toBeCloseTo(0.02, 12);
    for (const j of L.supports) checkSupport(stage, j);
  });

  it('a riser next to a side clamp is pushed out so it clears the part', () => {
    // clamp only on the upper half of the x- face: the column must not run along the face
    const stage = boxStage([10, 10, 4], {
      supports: [
        {
          face: 'x-',
          fix: 'xyz',
          cells: [5, 6, 7, 8, 9].flatMap((y) => [0, 1, 2, 3].map((z) => [0, y, z] as Vec3)),
        },
      ],
    });
    const j = computeLayout(stage).supports[0]!;
    expect(j.riser).not.toBeNull();
    expect(j.riser!.bounds.max[0]).toBeLessThan(0);
    checkSupport(stage, j);
  });
});

describe('load jigs for every force direction', () => {
  const dirs: Vec3[] = [
    [0, -1, 0],
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0.6, -0.8, 0],
  ];
  for (const d of dirs) {
    it(`F̂ = (${d.join(', ')}): cylinder behind the load, −Y = F̂`, () => {
      // load on a corner patch whose faces are all exposed
      const cells: Vec3[] = [];
      for (let x = 0; x < 2; x++) for (let z = 0; z < 4; z++) cells.push([x + 8 * Number(d[0] < 0), 5 * Number(d[1] < 0), z]);
      const stage = boxStage([10, 6, 4], {
        supports: [{ face: 'x-', fix: 'xyz' }],
        loads: [{ cells, force: [d[0] * 1000, d[1] * 1000, d[2] * 1000] }],
      });
      const L = computeLayout(stage);
      expect(L.loads).toHaveLength(1);
      const j = L.loads[0]!;
      expect(j.kind).toBe('cylinder');
      const n = Math.hypot(...d);
      expect(j.dir[0]).toBeCloseTo(d[0] / n, 12);
      expect(j.dir[1]).toBeCloseTo(d[1] / n, 12);
      expect(j.dir[2]).toBeCloseTo(d[2] / n, 12);
      checkLoad(stage, j);
      // the contact lies on the domain's outer face behind the load
      const ad = d.map(Math.abs);
      const a = ad[1]! >= ad[0]! && ad[1]! >= ad[2]! ? 1 : ad[0]! >= ad[2]! ? 0 : 2;
      expect(j.pose.position[a]).toBeCloseTo(d[a]! < 0 ? stage.grid[a]! * stage.voxelSize : 0, 12);
      expect(j.covered).toBe(false);
      // only a force tilted against the face lifts the jig off the contact point
      const tilted = d.filter((c) => c !== 0).length > 1;
      if (tilted) expect(j.lift).toBeGreaterThan(0.005);
      else expect(j.lift).toBe(0);
    });
  }

  it('a covered top face with a downward load → weight hanging from the underside', () => {
    // load cells in the bottom layer, material above them
    const cells: Vec3[] = [
      [4, 0, 1],
      [5, 0, 1],
      [4, 0, 2],
      [5, 0, 2],
    ];
    const stage = boxStage([10, 6, 4], { supports: [{ face: 'x-', fix: 'xyz' }], loads: [{ cells, force: [0, -500, 0] }] });
    const j = computeLayout(stage).loads[0]!;
    expect(j.kind).toBe('weight');
    expect(j.covered).toBe(true);
    expectVec(new THREE.Vector3(...j.pose.position), [0.05, 0, 0.02], 12);
    expect(j.spreader).toBeNull();
    expect(j.offset).toBe(0);
    checkLoad(stage, j);
  });

  it('a small patch needs no spreader', () => {
    const stage = boxStage([10, 6, 4], {
      supports: [{ face: 'x-', fix: 'xyz' }],
      loads: [{ cells: [[9, 5, 1]], force: [0, -100, 0] }],
    });
    const j = computeLayout(stage).loads[0]!;
    expect(j.spreader).toBeNull();
    expect(j.offset).toBe(0);
  });

  it('the same patch and direction in several load cases → one jig listing every case', () => {
    const load = { cells: [[9, 5, 1]] as Vec3[], force: [0, -100, 0] as Vec3 };
    const stage = boxStage([10, 6, 4], {
      supports: [{ face: 'x-', fix: 'xyz' }],
      loadCases: [
        { name: 'a', loads: [load] },
        { name: 'b', loads: [load, { cells: [[9, 3, 3]], force: [0, 0, 50] }] },
      ],
    });
    const L = computeLayout(stage);
    expect(L.loads).toHaveLength(2);
    expect(L.loads[0]!.cases).toEqual([0, 1]);
    expect(L.loads[1]!.caseIndex).toBe(1);
    expect(L.loads[1]!.loadIndex).toBe(1);
  });
});
