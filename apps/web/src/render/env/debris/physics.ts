// Rapier (WASM) world for the debris show — purely visual, never read by the FEM solve.
// `@dimforge/rapier3d-compat` (WASM inlined as base64) is imported dynamically on first use,
// so neither the first paint nor the main bundle waits for it; the module is shared by every
// game session, each session owns (and frees) one `DebrisPhysics` world.
//
// Scale: the part's voxels are 1 cm and the chips 5–10 mm, so the world runs with
// `lengthUnit = 0.01` (Rapier's tolerances and sleep thresholds are tuned for ~1 unit
// objects; at metre scale the chip piles cost 10× more per step and never fall asleep).

import type * as Rapier from '@dimforge/rapier3d-compat';
import type { Vec3 } from '@stress-carve/protocol';
import type { CellBox } from './plan.ts';

export type RapierModule = typeof Rapier;
export type RigidBody = Rapier.RigidBody;

let loading: Promise<RapierModule> | null = null;

/** Load + initialise Rapier once per page. */
export function loadRapier(): Promise<RapierModule> {
  loading ??= (async () => {
    const t0 = performance.now();
    const R = await import('@dimforge/rapier3d-compat');
    const t1 = performance.now();
    await R.init();
    measure('debris:rapier-import', t0, t1);
    measure('debris:rapier-init', t1, performance.now());
    return R;
  })();
  // a failed load (offline, CSP) may be retried by the next session
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** A DevTools performance-timeline entry (debugging the lazy init; no-op where unsupported). */
export function measure(name: string, start: number, end: number): void {
  try {
    performance.measure(name, { start, end });
  } catch {
    // older browsers / test environments
  }
}

export interface BoxCollider {
  center: Vec3;
  halfExtents: Vec3;
  /** quaternion (x, y, z, w); identity when absent */
  rotation?: [number, number, number, number];
}

export interface ChipBodyDesc {
  position: Vec3;
  rotation: [number, number, number, number];
  linvel: Vec3;
  angvel: Vec3;
  halfExtents: Vec3;
}

export const GRAVITY = 9.81;
const FRICTION = 0.7;
const RESTITUTION = 0.15;

export class DebrisPhysics {
  readonly world: Rapier.World;
  private part: Rapier.Collider | null = null;
  private dead = false;
  private freed = false;

  constructor(
    readonly R: RapierModule,
    readonly density: number,
  ) {
    this.world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.lengthUnit = 0.01;
    this.world.timestep = 1 / 60;
  }

  /** True after a WASM failure: the owner falls back to fading and stops calling in. */
  get failed(): boolean {
    return this.dead;
  }

  addStatic(boxes: readonly BoxCollider[]): void {
    for (const b of boxes) {
      const desc = this.R.ColliderDesc.cuboid(b.halfExtents[0], b.halfExtents[1], b.halfExtents[2])
        .setTranslation(b.center[0], b.center[1], b.center[2])
        .setFriction(FRICTION)
        .setRestitution(RESTITUTION);
      if (b.rotation) desc.setRotation({ x: b.rotation[0], y: b.rotation[1], z: b.rotation[2], w: b.rotation[3] });
      this.world.createCollider(desc);
    }
  }

  /**
   * The carved part (+ obstacles) as one voxel collider in the stage frame: voxel (x, y, z)
   * spans [x·h, (x+1)·h] etc. `filled(e)` says which cells are material.
   */
  setPart(grid: { nx: number; ny: number; nz: number }, h: number, filled: (e: number) => boolean): void {
    const coords: number[] = [];
    for (let z = 0; z < grid.nz; z++)
      for (let y = 0; y < grid.ny; y++)
        for (let x = 0; x < grid.nx; x++) if (filled(x + grid.nx * (y + grid.ny * z))) coords.push(x, y, z);
    if (this.part) this.world.removeCollider(this.part, false);
    // an empty voxel set is valid but pointless; keep one far-away voxel so setVoxel works
    if (coords.length === 0) coords.push(-1000, -1000, -1000);
    const desc = this.R.ColliderDesc.voxels(new Int32Array(coords), { x: h, y: h, z: h })
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION);
    this.part = this.world.createCollider(desc);
  }

  /** Mirror solid flips into the part collider (voxel (x, y, z) filled or not). */
  setVoxel(x: number, y: number, z: number, filled: boolean): void {
    this.guard(() => this.part?.setVoxel(x, y, z, filled));
  }

  addChip(c: ChipBodyDesc): RigidBody {
    const R = this.R;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(c.position[0], c.position[1], c.position[2])
        .setRotation({ x: c.rotation[0], y: c.rotation[1], z: c.rotation[2], w: c.rotation[3] })
        .setLinvel(c.linvel[0], c.linvel[1], c.linvel[2])
        .setAngvel({ x: c.angvel[0], y: c.angvel[1], z: c.angvel[2] })
        .setLinearDamping(0.05)
        .setAngularDamping(0.6),
    );
    this.world.createCollider(
      R.ColliderDesc.cuboid(c.halfExtents[0], c.halfExtents[1], c.halfExtents[2])
        .setDensity(this.density)
        .setFriction(FRICTION)
        .setRestitution(RESTITUTION),
      body,
    );
    return body;
  }

  /**
   * A falling piece made of voxel boxes (grid units, see `greedyBoxes`), body origin at
   * `origin` (m); boxes are placed relative to it.
   */
  addChunk(boxes: readonly CellBox[], h: number, origin: Vec3, linvel: Vec3, angvel: Vec3): RigidBody {
    const R = this.R;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(origin[0], origin[1], origin[2])
        .setLinvel(linvel[0], linvel[1], linvel[2])
        .setAngvel({ x: angvel[0], y: angvel[1], z: angvel[2] })
        .setAngularDamping(0.2),
    );
    for (const b of boxes) {
      const half: Vec3 = [
        ((b.max[0] - b.min[0]) * h) / 2,
        ((b.max[1] - b.min[1]) * h) / 2,
        ((b.max[2] - b.min[2]) * h) / 2,
      ];
      this.world.createCollider(
        R.ColliderDesc.cuboid(half[0], half[1], half[2])
          .setTranslation(
            b.min[0] * h + half[0] - origin[0],
            b.min[1] * h + half[1] - origin[1],
            b.min[2] * h + half[2] - origin[2],
          )
          .setDensity(this.density)
          .setFriction(FRICTION)
          .setRestitution(0.05),
        body,
      );
    }
    return body;
  }

  /** Freeze a settled body in place (it keeps colliding as part of the pile). */
  freeze(body: RigidBody): void {
    this.guard(() => body.setBodyType(this.R.RigidBodyType.Fixed, false));
  }

  remove(body: RigidBody): void {
    this.guard(() => this.world.removeRigidBody(body));
  }

  /** One fixed step; returns its wall time in ms (NaN after a failure). */
  step(): number {
    if (this.dead) return NaN;
    const t0 = performance.now();
    this.guard(() => this.world.step());
    return performance.now() - t0;
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.dead = true;
    try {
      this.world.free();
    } catch {
      // a world broken by a panic may refuse; its WASM memory goes with the page
    }
  }

  private guard(f: () => void): void {
    if (this.dead) return;
    try {
      f();
    } catch (err) {
      // A Rust panic inside WASM ("unreachable") leaves the world unusable. Debris is
      // decoration: log once and let the owner fall back to fading.
      console.warn('[debris] physics disabled after a Rapier failure:', err);
      this.dead = true;
    }
  }
}
