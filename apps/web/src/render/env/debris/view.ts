// Three.js side of the debris show: instanced chips (live, compacted every frame), the static
// pile (ring buffer of instances, written once per settled chip), fade-out ghosts for
// reduced motion, and the surface mesh of a falling chunk. World frame (metres).

import * as THREE from 'three';
import type { Grid } from '../../../game/grid.ts';

/** One InstancedMesh per piece variant, refilled from scratch each frame. */
export class LiveChips {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[];
  private readonly counts: number[];

  constructor(geometries: readonly THREE.BufferGeometry[], material: THREE.Material, capacity: number) {
    this.group.name = 'debris-live';
    this.meshes = geometries.map((g, i) => instanced(g, material, capacity, `debris-live-${i}`));
    this.counts = geometries.map(() => 0);
    this.group.add(...this.meshes);
  }

  begin(): void {
    this.counts.fill(0);
  }

  push(variant: number, matrix: THREE.Matrix4, color: THREE.Color): void {
    const mesh = this.meshes[variant];
    if (!mesh) return;
    const i = this.counts[variant]!;
    if (i >= mesh.instanceMatrix.count) return;
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, color);
    this.counts[variant] = i + 1;
  }

  end(): void {
    this.meshes.forEach((mesh, v) => {
      const n = this.counts[v]!;
      if (n === 0 && mesh.count === 0) return;
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.addUpdateRange(0, n * 3);
        mesh.instanceColor.needsUpdate = true;
      }
    });
  }
}

/**
 * The pile: settled chips baked into static instances (no physics, one draw call per
 * variant). A ring buffer per variant: when full, the oldest chip is overwritten.
 */
export class ChipPile {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[];
  private readonly next: number[];
  private total = 0;

  constructor(geometries: readonly THREE.BufferGeometry[], material: THREE.Material, capacityPerVariant: number) {
    this.group.name = 'debris-pile';
    this.meshes = geometries.map((g, i) => instanced(g, material, capacityPerVariant, `debris-pile-${i}`));
    this.next = geometries.map(() => 0);
    this.group.add(...this.meshes);
  }

  /** chips currently drawn in the pile */
  get size(): number {
    return this.total;
  }

  add(variant: number, matrix: THREE.Matrix4, color: THREE.Color): void {
    const mesh = this.meshes[variant];
    if (!mesh) return;
    const cap = mesh.instanceMatrix.count;
    const i = this.next[variant]! % cap;
    this.next[variant] = i + 1;
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, color);
    if (mesh.count < cap) {
      mesh.count++;
      this.total++;
    }
    mesh.instanceMatrix.addUpdateRange(i * 16, 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.addUpdateRange(i * 3, 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }
}

/** Removed voxels fading out in place (reduced motion, or before the physics is ready). */
export class FadeGhosts {
  readonly group = new THREE.Group();
  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshLambertMaterial;
  private batches: { mesh: THREE.InstancedMesh; material: THREE.MeshLambertMaterial; start: number }[] = [];

  constructor(
    h: number,
    private readonly duration = 0.45,
  ) {
    this.group.name = 'debris-ghosts';
    this.geometry = new THREE.BoxGeometry(h * 1.002, h * 1.002, h * 1.002);
    this.material = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.85, depthWrite: false });
  }

  /** A mesh carrying the ghost material, for shader warm-up. */
  sample(): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geometry, this.material, 1);
    m.setColorAt(0, new THREE.Color(1, 1, 1));
    return m;
  }

  get active(): number {
    return this.batches.length;
  }

  add(centers: readonly number[], colors: readonly number[], nowS: number): void {
    const n = centers.length / 3;
    if (n === 0) return;
    const material = this.material.clone();
    const mesh = new THREE.InstancedMesh(this.geometry, material, n);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      m.makeTranslation(centers[i * 3]!, centers[i * 3 + 1]!, centers[i * 3 + 2]!);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.setRGB(colors[i * 3]!, colors[i * 3 + 1]!, colors[i * 3 + 2]!));
    }
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.group.add(mesh);
    this.batches.push({ mesh, material, start: nowS });
  }

  update(nowS: number): void {
    this.batches = this.batches.filter((b) => {
      const t = (nowS - b.start) / this.duration;
      if (t >= 1) {
        b.mesh.removeFromParent();
        b.mesh.dispose();
        b.material.dispose();
        return false;
      }
      b.material.opacity = 0.85 * (1 - t) * (1 - t);
      return true;
    });
  }

  dispose(): void {
    for (const b of this.batches) {
      b.mesh.dispose();
      b.material.dispose();
    }
    this.batches = [];
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Surface of a cell set (faces between member and non-member cells) relative to `origin`
 * (m), with per-vertex colours from `colorOf` (linear RGB triples per cell).
 */
export function cellSurfaceGeometry(
  g: Grid,
  cells: readonly number[],
  h: number,
  origin: readonly [number, number, number],
  colorOf: (e: number) => readonly [number, number, number],
): THREE.BufferGeometry {
  const inSet = new Set(cells);
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (const e of cells) {
    const x = e % g.nx;
    const y = Math.floor(e / g.nx) % g.ny;
    const z = Math.floor(e / (g.nx * g.ny));
    const rgb = colorOf(e);
    for (let axis = 0; axis < 3; axis++) {
      for (const s of [-1, 1] as const) {
        const q = [x, y, z];
        q[axis] = q[axis]! + s;
        const inside = q[0]! >= 0 && q[1]! >= 0 && q[2]! >= 0 && q[0]! < g.nx && q[1]! < g.ny && q[2]! < g.nz;
        if (inside && inSet.has(q[0]! + g.nx * (q[1]! + g.ny * q[2]!))) continue;
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        const base = pos.length / 3;
        const corner = [x, y, z];
        corner[axis] = corner[axis]! + (s > 0 ? 1 : 0);
        for (const [du, dv] of [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ] as const) {
          const p = [...corner];
          p[u] = p[u]! + du;
          p[v] = p[v]! + dv;
          pos.push(p[0]! * h - origin[0], p[1]! * h - origin[1], p[2]! * h - origin[2]);
          const n = [0, 0, 0];
          n[axis] = s;
          nor.push(n[0]!, n[1]!, n[2]!);
          col.push(rgb[0], rgb[1], rgb[2]);
        }
        // (u, v, axis) is right-handed: CCW seen from +axis
        if (s > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // allocate instanceColor up front so the shader is compiled with instance colours
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = name;
  return mesh;
}
