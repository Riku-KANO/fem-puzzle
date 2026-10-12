// Load-test debris (purely visual, design doc 演出: 超過要素から順に崩れる): broken elements
// pop off as small chips, parts cut off from the supports fall as rigid pieces; both land on
// the bench and fade out when the test releases. Simple ballistic motion with a seeded RNG —
// T-310 owns the real (Rapier) carving debris; this never touches the game state.
// Everything lives in grid units inside the domain group (1 = one voxel).

import * as THREE from 'three';

/** Visual gravity (m/s²): a little slower than real so a 1 cm chip can be followed. */
export const VISUAL_GRAVITY = 2.5;
const RESTITUTION = 0.3;
const FRICTION = 0.6;
const CHIP_SIZE = 0.82;

export interface Chip {
  p: [number, number, number];
  v: [number, number, number];
  /** rotation axis (unit) and angle */
  axis: [number, number, number];
  angle: number;
  spin: number;
  resting: boolean;
}

/** Deterministic PRNG (mulberry32) so the show and its tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Launch a chip from `p` (grid units), kicked away from `away` (e.g. the part's centre). */
export function launchChip(p: readonly number[], away: readonly number[], rand: () => number): Chip {
  const dx = p[0]! - away[0]!;
  const dz = p[2]! - away[2]!;
  const len = Math.hypot(dx, dz) || 1;
  const kick = 2 + 3 * rand();
  const ax = rand() - 0.5;
  const ay = rand() - 0.5;
  const az = rand() - 0.5;
  const al = Math.hypot(ax, ay, az) || 1;
  return {
    p: [p[0]!, p[1]!, p[2]!],
    v: [(dx / len) * kick + (rand() - 0.5) * 2, 2 + 3 * rand(), (dz / len) * kick + (rand() - 0.5) * 2],
    axis: [ax / al, ay / al, az / al],
    angle: 0,
    spin: 4 + 8 * rand(),
    resting: false,
  };
}

/** Advance a chip by `dt` s under `gravity` (grid units/s²) with a floor at `floorY`. */
export function stepChip(c: Chip, dt: number, gravity: number, floorY: number): void {
  if (c.resting) return;
  c.v[1] -= gravity * dt;
  c.p[0] += c.v[0] * dt;
  c.p[1] += c.v[1] * dt;
  c.p[2] += c.v[2] * dt;
  c.angle += c.spin * dt;
  const bottom = floorY + CHIP_SIZE / 2;
  if (c.p[1] < bottom) {
    c.p[1] = bottom;
    if (Math.abs(c.v[1]) < gravity * 0.03) {
      c.resting = true;
      c.v = [0, 0, 0];
      return;
    }
    c.v[1] = -c.v[1] * RESTITUTION;
    c.v[0] *= FRICTION;
    c.v[2] *= FRICTION;
    c.spin *= FRICTION;
  }
}

interface Piece {
  pivot: THREE.Group;
  v: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number;
  resting: boolean;
}

/** Chips (instanced cubes) and falling pieces of one load test. */
export class Debris {
  readonly group = new THREE.Group();
  private readonly chipMesh: THREE.InstancedMesh;
  private readonly chipMaterial: THREE.MeshLambertMaterial;
  private readonly chips: Chip[] = [];
  private readonly pieces: Piece[] = [];
  private readonly rand: () => number;
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly box = new THREE.Box3();

  constructor(
    private readonly gravity: number,
    private readonly floorY: number,
    readonly maxChips: number,
    seed = 1,
  ) {
    this.rand = rng(seed);
    this.chipMaterial = new THREE.MeshLambertMaterial({ transparent: true });
    this.chipMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.chipMaterial, maxChips);
    this.chipMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxChips * 3), 3);
    this.chipMesh.count = 0;
    this.chipMesh.frustumCulled = false;
    this.chipMesh.name = 'load-test-chips';
    this.group.add(this.chipMesh);
    this.group.name = 'load-test-debris';
  }

  get chipCount(): number {
    return this.chips.length;
  }

  get pieceCount(): number {
    return this.pieces.length;
  }

  /** Spawn a chip at `p` (grid units) in linear-RGB `color`; ignored beyond `maxChips`. */
  addChip(p: readonly number[], away: readonly number[], color: readonly number[]): void {
    if (this.chips.length >= this.maxChips) return;
    const i = this.chips.length;
    this.chips.push(launchChip(p, away, this.rand));
    this.chipMesh.setColorAt(i, new THREE.Color(color[0] ?? 1, color[1] ?? 0, color[2] ?? 1));
    this.chipMesh.count = this.chips.length;
    if (this.chipMesh.instanceColor) this.chipMesh.instanceColor.needsUpdate = true;
    this.writeChip(i);
  }

  /**
   * Let `mesh` (grid units, already deformed) fall as a rigid piece pivoting about `center`,
   * nudged away from `away`.
   */
  addPiece(mesh: THREE.Mesh, center: readonly number[], away: readonly number[]): void {
    const pivot = new THREE.Group();
    pivot.position.set(center[0]!, center[1]!, center[2]!);
    mesh.position.set(-center[0]!, -center[1]!, -center[2]!);
    pivot.add(mesh);
    const dx = center[0]! - away[0]!;
    const dz = center[2]! - away[2]!;
    const len = Math.hypot(dx, dz) || 1;
    const v = new THREE.Vector3((dx / len) * 1.5, 0.5, (dz / len) * 1.5);
    // tip over the edge nearest the remaining part: rotate about the horizontal axis ⊥ the kick
    const axis = new THREE.Vector3(dz / len, 0, -dx / len);
    if (axis.lengthSq() < 1e-9) axis.set(1, 0, 0);
    this.pieces.push({ pivot, v, axis: axis.normalize(), spin: -(0.8 + 0.6 * this.rand()), resting: false });
    this.group.add(pivot);
  }

  update(dt: number, opacity: number): void {
    const step = Math.min(dt, 1 / 20);
    for (let i = 0; i < this.chips.length; i++) {
      stepChip(this.chips[i]!, step, this.gravity, this.floorY);
      this.writeChip(i);
    }
    if (this.chips.length > 0) this.chipMesh.instanceMatrix.needsUpdate = true;
    this.chipMaterial.opacity = opacity;
    this.chipMaterial.visible = opacity > 0.01;
    for (const p of this.pieces) this.stepPiece(p, step);
    for (const p of this.pieces) {
      p.pivot.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material instanceof THREE.Material) {
          o.material.opacity = opacity;
          o.material.visible = opacity > 0.01;
        }
      });
    }
  }

  clear(): void {
    this.chips.length = 0;
    this.chipMesh.count = 0;
    for (const p of this.pieces) {
      this.group.remove(p.pivot);
      p.pivot.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    this.pieces.length = 0;
  }

  dispose(): void {
    this.clear();
    this.chipMesh.geometry.dispose();
    this.chipMaterial.dispose();
  }

  private writeChip(i: number): void {
    const c = this.chips[i]!;
    this.axis.set(c.axis[0], c.axis[1], c.axis[2]);
    this.quat.setFromAxisAngle(this.axis, c.angle);
    this.pos.set(c.p[0], c.p[1], c.p[2]);
    this.scale.setScalar(CHIP_SIZE);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.chipMesh.setMatrixAt(i, this.matrix);
  }

  private stepPiece(p: Piece, dt: number): void {
    if (p.resting) return;
    p.v.y -= this.gravity * dt;
    p.pivot.position.addScaledVector(p.v, dt);
    p.pivot.rotateOnWorldAxis(p.axis, p.spin * dt);
    p.pivot.updateMatrixWorld(true);
    // land: lift the piece so its lowest point sits on the floor (bounding box in group space)
    this.box.makeEmpty();
    p.pivot.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox!.clone();
        b.applyMatrix4(new THREE.Matrix4().multiplyMatrices(p.pivot.matrix, o.matrix));
        this.box.union(b);
      }
    });
    if (!this.box.isEmpty() && this.box.min.y < this.floorY) {
      p.pivot.position.y += this.floorY - this.box.min.y;
      p.resting = true;
    }
  }
}
