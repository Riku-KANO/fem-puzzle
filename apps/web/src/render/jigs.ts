// Placeholder jigs (design doc 演出 / T-307 asset conventions): clamp plates behind supported
// faces and arrows for loads. World frame = stage frame (metres, Y-up, grid min corner at
// the origin). T-310 swaps these for the glTF jigs at the same anchors:
//   support: patch centre + outward normal (jig local +Y), patch size in the face plane;
//   load:    patch centre + force direction F̂ (jig local −Y).

import { decodeBitmask, elementCount, stageCases, type Stage, type Vec3 } from '@stress-carve/protocol';
import * as THREE from 'three';
import { faceDir } from '../game/grid.ts';
import { supportCells } from '../game/supports.ts';

export interface SupportPatch {
  /** centre of the contact patch on the domain surface (m) */
  center: Vec3;
  /** outward normal of the supported face */
  normal: Vec3;
  /** patch extent along the face's two tangent axes (axis+1, axis+2), m */
  size: [number, number];
  axis: 0 | 1 | 2;
  /** fixes all three directions (clamp/pin) vs a roller */
  full: boolean;
}

export interface LoadArrow {
  /** centre of the loaded cells' patch (m) */
  center: Vec3;
  /** unit force direction */
  dir: Vec3;
  /** |F| in N */
  magnitude: number;
  caseIndex: number;
}

/** Clamp plates: one per 4-connected cluster of supported cells in the face plane. */
export function supportPatches(stage: Stage): SupportPatch[] {
  const h = stage.voxelSize;
  const solid = decodeBitmask(stage.solid, elementCount(stage.grid));
  const out: SupportPatch[] = [];
  for (const s of stage.supports) {
    const { axis, sign, normal } = faceDir(s.face);
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const cells = supportCells(stage, s, solid);
    for (const cluster of clusters(cells, u, v)) {
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (const c of cluster) {
        u0 = Math.min(u0, c[u]!);
        u1 = Math.max(u1, c[u]! + 1);
        v0 = Math.min(v0, c[v]!);
        v1 = Math.max(v1, c[v]! + 1);
      }
      const plane = cluster[0]![axis]! + (sign > 0 ? 1 : 0);
      const center: Vec3 = [0, 0, 0];
      center[axis] = plane * h;
      center[u] = ((u0 + u1) / 2) * h;
      center[v] = ((v0 + v1) / 2) * h;
      out.push({
        center,
        normal: [normal[0], normal[1], normal[2]],
        size: [(u1 - u0) * h, (v1 - v0) * h],
        axis: axis,
        full: ['x', 'y', 'z'].every((c) => s.fix.includes(c)),
      });
    }
  }
  return out;
}

/** One arrow per load (all cases), anchored at the centre of the loaded cells. */
export function loadArrows(stage: Stage): LoadArrow[] {
  const h = stage.voxelSize;
  return stageCases(stage).flatMap((lc, caseIndex) =>
    lc.loads
      .filter((l) => l.cells.length > 0)
      .map((l) => {
        const m = Math.hypot(...l.force);
        const center: Vec3 = [0, 0, 0];
        for (const c of l.cells) for (let k = 0; k < 3; k++) center[k]! += ((c[k]! + 0.5) * h) / l.cells.length;
        const dir: Vec3 = m > 0 ? [l.force[0] / m, l.force[1] / m, l.force[2] / m] : [0, -1, 0];
        return { center, dir, magnitude: m, caseIndex };
      }),
  );
}

function clusters(cells: Vec3[], u: number, v: number): Vec3[][] {
  const key = (c: Vec3) => `${c[u]},${c[v]}`;
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

const CASE_COLORS = [0xf0a23b, 0x4fc3f7, 0xba68c8, 0x81c784];
const PLATE_MARGIN = 0.01;
const CLAMP_DEPTH = 0.05;
const ROLLER_DEPTH = 0.03;

/** Placeholder jig meshes in world (stage) coordinates. */
export function buildJigs(stage: Stage): THREE.Group {
  const group = new THREE.Group();
  group.name = 'jigs';
  const [nx, ny, nz] = stage.grid;
  const extent = Math.max(nx, ny, nz) * stage.voxelSize;

  const clampMat = new THREE.MeshLambertMaterial({ color: 0x5b6170 });
  const rollerMat = new THREE.MeshLambertMaterial({ color: 0x3f8a99 });
  for (const p of supportPatches(stage)) {
    const depth = p.full ? CLAMP_DEPTH : ROLLER_DEPTH;
    const dims: Vec3 = [0, 0, 0];
    dims[p.axis] = depth;
    dims[(p.axis + 1) % 3] = p.size[0] + 2 * PLATE_MARGIN;
    dims[(p.axis + 2) % 3] = p.size[1] + 2 * PLATE_MARGIN;
    const box = new THREE.Mesh(new THREE.BoxGeometry(...dims), p.full ? clampMat : rollerMat);
    box.position.set(
      p.center[0] + (p.normal[0] * depth) / 2,
      p.center[1] + (p.normal[1] * depth) / 2,
      p.center[2] + (p.normal[2] * depth) / 2,
    );
    box.name = 'support';
    group.add(box);
  }

  const length = Math.min(0.2, 0.6 * extent);
  const up = new THREE.Vector3(0, 1, 0);
  for (const a of loadArrows(stage)) {
    const dir = new THREE.Vector3(...a.dir);
    // the tip touches the loaded cells' surface; the body extends "upstream" along −F̂
    const tip = new THREE.Vector3(...a.center).addScaledVector(dir, -stage.voxelSize / 2);
    const arrow = buildArrow(length, CASE_COLORS[a.caseIndex % CASE_COLORS.length]!);
    arrow.position.copy(tip);
    // local −Y = F̂ (same convention as the T-307 load jigs)
    arrow.quaternion.setFromUnitVectors(up, dir.clone().negate());
    group.add(arrow);
  }
  return group;
}

/** Solid arrow with its tip at the local origin, pointing along local −Y. */
function buildArrow(length: number, color: number): THREE.Group {
  const mat = new THREE.MeshLambertMaterial({ color });
  const headLen = length * 0.3;
  const shaftLen = length - headLen;
  const head = new THREE.Mesh(new THREE.ConeGeometry(length * 0.1, headLen, 20), mat);
  head.rotation.x = Math.PI; // cone points down
  head.position.y = headLen / 2;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(length * 0.035, length * 0.035, shaftLen, 12), mat);
  shaft.position.y = headLen + shaftLen / 2;
  const g = new THREE.Group();
  g.name = 'load';
  g.add(head, shaft);
  return g;
}
