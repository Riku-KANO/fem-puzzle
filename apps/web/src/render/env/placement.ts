// Pure placement maths for the T-307 jigs (tools/blender/assets/README.md "Jigs"): where each
// support / load jig and riser goes for a stage, as plain poses in the world (= stage) frame:
// metres, Y-up, grid min corner at the origin. No scene graph — `workshop.ts` applies these.
//
// Supports: origin = centre of the contact patch, local +Y = outward face normal, local X =
//   the patch's long axis. fix "xyz" without `cells` → clamp (X/Z scaled by
//   (patch + 0.02) / 0.10); fix "xyz" with `cells` → pin; fix ⊊ xyz → roller (X scaled by
//   patchLength / 0.08). One jig per 4-connected cluster of supported cells.
// Risers: from the bench top up to the underside of every support jig not standing on top.
// Loads: origin = contact patch centre, local −Y = F̂. A pushing cylinder sits on the face
//   whose outward normal ≈ −F̂ ("behind" the load); when that face is covered by material and
//   F̂ ≈ −Y the hanging weight goes on the underside instead. Patches wider than the Ø32 mm pad
//   get a spreader plate scaled to the patch and the cylinder on top of it (+0.008 local Y).

import { decodeBitmask, elementCount, stageCases, supportCells, type Stage, type Vec3 } from '@stress-carve/protocol';
import * as THREE from 'three';
import { cellCoords, faceDir, makeGrid, type Grid } from '../../game/grid.ts';
import { BENCH_DROP, CLAMP, CYLINDER, JIG_BOUNDS, PIN, SPREADER, type Aabb } from './assetSpec.ts';

export type Quat = [number, number, number, number];

export interface Pose {
  position: Vec3;
  /** rotation (x, y, z, w) */
  quaternion: Quat;
  scale: Vec3;
}

export type SupportKind = 'clamp' | 'pin' | 'roller';

export interface SupportJig {
  kind: SupportKind;
  asset: 'jig_clamp' | 'jig_pin' | 'jig_roller';
  supportIndex: number;
  /** outward normal of the supported face (= local +Y) */
  normal: Vec3;
  /** patch size along local X (long axis) and local Z, m */
  patch: [number, number];
  pose: Pose;
  /** world AABB of the jig */
  bounds: Aabb;
  riser: RiserJig | null;
}

export interface RiserJig {
  /** origin on the bench top, unrotated, unscaled */
  pose: Pose;
  /** `riser_column.scale.y`: bench top → underside of the jig it carries, m */
  height: number;
  bounds: Aabb;
}

export type LoadKind = 'cylinder' | 'weight';

export interface LoadJig {
  kind: LoadKind;
  /** first load case this jig belongs to, and every case with the same patch + direction */
  caseIndex: number;
  cases: number[];
  /** index of the load inside its case */
  loadIndex: number;
  /** unit force direction F̂ (= local −Y) */
  dir: Vec3;
  /** root pose: origin = contact-patch centre on the part surface, unit scale */
  pose: Pose;
  /** spreader plate scale along local X / Z (patch size), or null when the pad is enough */
  spreader: [number, number] | null;
  /** offset of the cylinder / weight along local +Y inside the root (spreader thickness) */
  offset: number;
  /**
   * extra shift of spreader + cylinder/weight along local +Y (0 unless F̂ is tilted against
   * the face: then the tilted pad/plate would dip into the part)
   */
  lift: number;
  /** the face behind the load is covered by material (placed with a fallback) */
  covered: boolean;
  bounds: Aabb;
}

export interface EnvLayout {
  /** workbench / workshop root position (bench frame origin) */
  benchOrigin: Vec3;
  /** the voxel domain, m */
  domain: Aabb;
  supports: SupportJig[];
  loads: LoadJig[];
}

/** Clearance between a riser's column and the part it must not cut through. */
const RISER_CLEARANCE = 0.002;
const MIN_RISER = 0.005;

export function computeLayout(stage: Stage): EnvLayout {
  const g = makeGrid(stage.grid);
  const h = stage.voxelSize;
  const domain: Aabb = { min: [0, 0, 0], max: [g.nx * h, g.ny * h, g.nz * h] };
  const benchOrigin: Vec3 = [domain.max[0] / 2, -BENCH_DROP, domain.max[2] / 2];
  const solid = decodeBitmask(stage.solid, elementCount(stage.grid));
  const block = stage.block ? decodeBitmask(stage.block, g.n) : new Uint8Array(g.n);
  const supports = stage.supports.flatMap((s, i) => placeSupport(stage, g, solid, i, benchOrigin[1]));
  const loads = placeLoads(stage, g, solid, block);
  return { benchOrigin, domain, supports, loads };
}

// --- supports ----------------------------------------------------------------

function placeSupport(stage: Stage, g: Grid, solid: Uint8Array, supportIndex: number, benchY: number): SupportJig[] {
  const s = stage.supports[supportIndex]!;
  const h = stage.voxelSize;
  const { axis, sign, normal } = faceDir(s.face);
  const full = ['x', 'y', 'z'].every((c) => s.fix.includes(c));
  const kind: SupportKind = !full ? 'roller' : s.cells ? 'pin' : 'clamp';
  const cells = supportCells(stage, s, solid).map((e) => cellCoords(g, e));
  const u = ((axis + 1) % 3) as 0 | 1 | 2;
  const v = ((axis + 2) % 3) as 0 | 1 | 2;
  const out: SupportJig[] = [];
  for (const cluster of clusters(cells, u, v)) {
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of cluster) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, c[k]!);
        hi[k] = Math.max(hi[k]!, c[k]! + 1);
      }
    }
    const center: Vec3 = [0, 0, 0];
    center[axis] = (sign > 0 ? hi[axis]! : lo[axis]!) * h;
    center[u] = ((lo[u]! + hi[u]!) / 2) * h;
    center[v] = ((lo[v]! + hi[v]!) / 2) * h;
    const sizeU = (hi[u]! - lo[u]!) * h;
    const sizeV = (hi[v]! - lo[v]!) * h;
    // local X = long axis of the patch (ties: the first tangent axis)
    const longAxis = sizeV > sizeU + 1e-9 ? v : u;
    const xAxis = unit(longAxis);
    const yAxis = new THREE.Vector3(...normal);
    const patch: [number, number] = longAxis === u ? [sizeU, sizeV] : [sizeV, sizeU];
    const scale: Vec3 =
      kind === 'clamp'
        ? [(patch[0] + CLAMP.margin) / CLAMP.nominal, 1, (patch[1] + CLAMP.margin) / CLAMP.nominal]
        : [patch[0] / PIN.nominalLength, 1, 1];
    const asset = kind === 'clamp' ? 'jig_clamp' : kind === 'pin' ? 'jig_pin' : 'jig_roller';
    const pose = poseFromBasis(center, xAxis, yAxis, scale);
    const bounds = transformAabb(JIG_BOUNDS[asset], pose);
    out.push({
      kind,
      asset,
      supportIndex,
      normal: [normal[0], normal[1], normal[2]],
      patch,
      pose,
      bounds,
      riser: placeRiser(bounds, center, normal, benchY),
    });
  }
  return out;
}

/**
 * A riser under a support jig: centred under the jig, pushed out along a horizontal face
 * normal far enough that the column clears the part, from the bench top up to the jig's
 * underside. None for jigs on top of the part (they would need a gantry) or already on the bed.
 */
function placeRiser(jig: Aabb, contact: Vec3, normal: Vec3, benchY: number): RiserJig | null {
  if (normal[1] > 0.5) return null;
  const half = JIG_BOUNDS.jig_riser.max[0];
  const x = (jig.min[0] + jig.max[0]) / 2;
  const z = (jig.min[2] + jig.max[2]) / 2;
  const pos: Vec3 = [x, benchY, z];
  // horizontal normal: keep the column outside the supported face plane
  for (const k of [0, 2] as const) {
    const n = normal[k]!;
    if (Math.abs(n) > 0.5) {
      const plane = contact[k]!;
      const minOut = half + RISER_CLEARANCE;
      if ((pos[k]! - plane) * n < minOut) pos[k] = plane + n * minOut;
    }
  }
  const height = jig.min[1] - benchY;
  if (height < MIN_RISER) return null;
  const pose: Pose = { position: pos, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };
  const r = JIG_BOUNDS.jig_riser;
  const bounds: Aabb = {
    min: [pos[0] + r.min[0], benchY, pos[2] + r.min[2]],
    max: [pos[0] + r.max[0], benchY + height, pos[2] + r.max[2]],
  };
  return { pose, height, bounds };
}

/** 4-connected clusters of cells in the (u, v) plane, same layer (as render/jigs.ts). */
export function clusters(cells: readonly Vec3[], u: number, v: number): Vec3[][] {
  const key = (c: Vec3) => `${c[0]},${c[1]},${c[2]}`;
  const byKey = new Map(cells.map((c) => [key(c), c] as const));
  const seen = new Set<string>();
  const out: Vec3[][] = [];
  for (const c of cells) {
    if (seen.has(key(c))) continue;
    const comp: Vec3[] = [c];
    seen.add(key(c));
    for (let i = 0; i < comp.length; i++) {
      const p = comp[i]!;
      for (const [du, dv] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const q: Vec3 = [p[0], p[1], p[2]];
        q[u] = q[u]! + du;
        q[v] = q[v]! + dv;
        const n = byKey.get(key(q));
        if (n && !seen.has(key(n))) {
          seen.add(key(n));
          comp.push(n);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

// --- loads -------------------------------------------------------------------

function placeLoads(stage: Stage, g: Grid, solid: Uint8Array, block: Uint8Array): LoadJig[] {
  const h = stage.voxelSize;
  const occupied = (c: Vec3): boolean => {
    if (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= g.nx || c[1] >= g.ny || c[2] >= g.nz) return false;
    const e = c[0] + g.nx * (c[1] + g.ny * c[2]);
    return solid[e] === 1 || block[e] === 1;
  };
  const out: LoadJig[] = [];
  const byKey = new Map<string, LoadJig>();
  stageCases(stage).forEach((lc, caseIndex) => {
    lc.loads.forEach((load, loadIndex) => {
      if (load.cells.length === 0) return;
      const m = Math.hypot(...load.force);
      const dir: Vec3 = m > 0 ? [load.force[0] / m, load.force[1] / m, load.force[2] / m] : [0, -1, 0];
      const a = dominantAxis(dir);
      const s = Math.sign(dir[a]) || -1;
      // face behind the load: outward normal -s·e_a
      const behind = faceOf(load.cells, a, -s, h);
      const behindCovered = coveredFraction(load.cells, a, -s, occupied) > 0.5;
      let kind: LoadKind = 'cylinder';
      let face = behind;
      if (behindCovered && a === 1 && s < 0 && dir[1] < -0.9) {
        const under = faceOf(load.cells, 1, -1, h);
        if (coveredFraction(load.cells, 1, -1, occupied) <= 0.5) {
          kind = 'weight';
          face = under;
        }
      }
      const yAxis = new THREE.Vector3(-dir[0], -dir[1], -dir[2]);
      const xAxis = loadTangent(yAxis);
      const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis);
      const extX = boxExtentAlong(face.cellBox, xAxis);
      const extZ = boxExtentAlong(face.cellBox, zAxis);
      const spreader: [number, number] | null =
        kind === 'cylinder' && Math.max(extX, extZ) > CYLINDER.padDiameter ? [extX, extZ] : null;
      const offset = spreader ? SPREADER.thickness : 0;
      const pose = poseFromBasis(face.center, xAxis, yAxis, [1, 1, 1]);
      const lift = tiltLift(kind, pose, face.normal, spreader, offset);
      const key = `${kind}|${face.center.map((c) => c.toFixed(5)).join(',')}|${dir.map((c) => c.toFixed(4)).join(',')}`;
      const dup = byKey.get(key);
      if (dup) {
        if (!dup.cases.includes(caseIndex)) dup.cases.push(caseIndex);
        return;
      }
      const jig: LoadJig = {
        kind,
        caseIndex,
        cases: [caseIndex],
        loadIndex,
        dir,
        pose,
        spreader,
        offset,
        lift,
        covered: behindCovered,
        bounds: loadBounds(kind, pose, spreader, offset, lift),
      };
      byKey.set(key, jig);
      out.push(jig);
    });
  });
  return out;
}

interface PatchFace {
  /** contact centre on the face, m */
  center: Vec3;
  /** outward normal of the face */
  normal: Vec3;
  /** AABB of the loaded cells, m */
  cellBox: Aabb;
}

/** The loaded cells' face with outward normal `sign`·e_axis: the outermost plane, patch centre. */
function faceOf(cells: readonly Vec3[], axis: 0 | 1 | 2, sign: number, h: number): PatchFace {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, c[k]!);
      hi[k] = Math.max(hi[k]!, c[k]! + 1);
    }
  }
  const center: Vec3 = [((lo[0] + hi[0]) / 2) * h, ((lo[1] + hi[1]) / 2) * h, ((lo[2] + hi[2]) / 2) * h];
  center[axis] = (sign > 0 ? hi[axis]! : lo[axis]!) * h;
  const normal: Vec3 = [0, 0, 0];
  normal[axis] = sign > 0 ? 1 : -1;
  return {
    center,
    normal,
    cellBox: { min: [lo[0] * h, lo[1] * h, lo[2] * h], max: [hi[0] * h, hi[1] * h, hi[2] * h] },
  };
}

/**
 * Share of the loaded cells' outer faces (normal `sign`·e_axis, neighbour not itself loaded)
 * that are covered by material.
 */
function coveredFraction(cells: readonly Vec3[], axis: 0 | 1 | 2, sign: number, occupied: (c: Vec3) => boolean): number {
  const key = (c: Vec3) => `${c[0]},${c[1]},${c[2]}`;
  const loaded = new Set(cells.map(key));
  let faces = 0;
  let covered = 0;
  for (const c of cells) {
    const q: Vec3 = [c[0], c[1], c[2]];
    q[axis] = q[axis]! + sign;
    if (loaded.has(key(q))) continue;
    faces++;
    if (occupied(q)) covered++;
  }
  return faces > 0 ? covered / faces : 1;
}

/** Local X of a load jig: world +X, else +Z, else +Y projected ⊥ to Y (so local +Z faces the camera side). */
function loadTangent(y: THREE.Vector3): THREE.Vector3 {
  for (const cand of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)]) {
    const p = cand.addScaledVector(y, -cand.dot(y));
    if (p.length() > 0.5) return p.normalize();
  }
  return new THREE.Vector3(1, 0, 0);
}

/** Local boxes of a load jig's parts (root frame, before `lift`): body, then the plate. */
export function loadPartBoxes(kind: LoadKind, spreader: [number, number] | null, offset: number): Aabb[] {
  const body = kind === 'cylinder' ? JIG_BOUNDS.jig_cylinder : JIG_BOUNDS.jig_weight;
  const out: Aabb[] = [
    { min: [body.min[0], body.min[1] + offset, body.min[2]], max: [body.max[0], body.max[1] + offset, body.max[2]] },
  ];
  if (spreader) {
    const s = JIG_BOUNDS.jig_spreader;
    out.push({
      min: [s.min[0] * spreader[0], s.min[1], s.min[2] * spreader[1]],
      max: [s.max[0] * spreader[0], s.max[1], s.max[2] * spreader[1]],
    });
  }
  return out;
}

function loadBounds(kind: LoadKind, pose: Pose, spreader: [number, number] | null, offset: number, lift: number): Aabb {
  const boxes = loadPartBoxes(kind, spreader, offset).map((b) => ({
    min: [b.min[0], b.min[1] + lift, b.min[2]] as Vec3,
    max: [b.max[0], b.max[1] + lift, b.max[2]] as Vec3,
  }));
  return boxes.map((b) => transformAabb(b, pose)).reduce(union);
}

/**
 * Lift along local +Y that keeps every part of a pushing jig on the outer side of the face
 * plane (normal `n`) when F̂ is not parallel to the face normal. 0 for axis-aligned loads and
 * for the hanging weight (it hangs away from the part by construction).
 */
function tiltLift(kind: LoadKind, pose: Pose, n: Vec3, spreader: [number, number] | null, offset: number): number {
  if (kind === 'weight') return 0;
  const q = new THREE.Quaternion(...pose.quaternion);
  const nn = new THREE.Vector3(...n);
  const yn = new THREE.Vector3(0, 1, 0).applyQuaternion(q).dot(nn);
  if (yn <= 0) return 0;
  let need = 0;
  const p = new THREE.Vector3();
  for (const b of loadPartBoxes(kind, spreader, offset)) {
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]).applyQuaternion(q);
      need = Math.max(need, -p.dot(nn) / yn);
    }
  }
  return need < 1e-9 ? 0 : need;
}

// --- maths -------------------------------------------------------------------

function dominantAxis(d: Vec3): 0 | 1 | 2 {
  const ax = Math.abs(d[0]);
  const ay = Math.abs(d[1]);
  const az = Math.abs(d[2]);
  if (ay >= ax && ay >= az) return 1;
  return ax >= az ? 0 : 2;
}

function unit(axis: number): THREE.Vector3 {
  const v = new THREE.Vector3();
  v.setComponent(axis, 1);
  return v;
}

/** Pose with basis (X, Y, X × Y): X is re-orthogonalised against Y. */
export function poseFromBasis(position: Vec3, x: THREE.Vector3, y: THREE.Vector3, scale: Vec3): Pose {
  const yy = y.clone().normalize();
  const xx = x.clone().addScaledVector(yy, -x.dot(yy)).normalize();
  const zz = new THREE.Vector3().crossVectors(xx, yy);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xx, yy, zz));
  return { position: [position[0], position[1], position[2]], quaternion: [q.x, q.y, q.z, q.w], scale };
}

export function poseMatrix(p: Pose): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...p.position),
    new THREE.Quaternion(...p.quaternion),
    new THREE.Vector3(...p.scale),
  );
}

/** AABB of a local box under a pose (all 8 corners). */
export function transformAabb(box: Aabb, pose: Pose): Aabb {
  const m = poseMatrix(pose);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]);
    p.applyMatrix4(m);
    for (let k = 0; k < 3; k++) {
      const c = p.getComponent(k);
      min[k] = Math.min(min[k]!, c);
      max[k] = Math.max(max[k]!, c);
    }
  }
  return { min, max };
}

function union(a: Aabb, b: Aabb): Aabb {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/** Width of an AABB measured along a unit direction (support function). */
function boxExtentAlong(box: Aabb, d: THREE.Vector3): number {
  let w = 0;
  for (let k = 0; k < 3; k++) w += Math.abs(d.getComponent(k)) * (box.max[k]! - box.min[k]!);
  return w;
}
