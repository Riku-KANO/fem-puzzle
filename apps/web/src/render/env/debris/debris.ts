// Debris show (design doc 演出): carved voxels burst into small chips that fall and pile up on
// the bench; floating pieces cut off the part drop as one rigid chunk. Rapier runs on the
// main thread with a fixed 60 Hz step, at most two steps per frame, a hard cap on live
// bodies (adaptively lowered if a step gets slow) and settled chips baked into a static pile.
// Purely visual: it reads the carve state, never writes anything the solver sees.
//
// Modes (`plan.ts::resolveFx`): physics; fade (prefers-reduced-motion: removed voxels fade
// in place, Rapier is never loaded); off (e2e). Until Rapier + debris.glb are loaded (lazy,
// after the first paint) and after a Rapier failure, physics mode falls back to fade.

import type { Vec3 } from '@stress-carve/protocol';
import * as THREE from 'three';
import { cellCoords, type Grid } from '../../../game/grid.ts';
import { DEBRIS_DENSITY, PIECE_HALF_EXTENTS, PIECE_NAMES } from '../assetSpec.ts';
import { loadTemplate } from '../assets.ts';
import { DebrisPhysics, loadRapier, measure, type BoxCollider, type RigidBody } from './physics.ts';
import {
  CHIP_KINEMATICS,
  chipCounts,
  chipSpawn,
  CHUNK_MIN_CELLS,
  components,
  greedyBoxes,
  outwardDir,
  rng,
  settleVerdict,
  type ChipSpawn,
  type DebrisMode,
  type SettleRule,
} from './plan.ts';
import { cellSurfaceGeometry, ChipPile, FadeGhosts, LiveChips } from './view.ts';

/** Tunables (exported for the log / tests). */
export const DEBRIS_LIMITS = {
  /** live (simulated) chips, hard cap */
  maxLive: 300,
  /** floor of the adaptive cap */
  minLive: 60,
  /** chips per removed voxel while the budget allows */
  perCell: 2,
  /** most chips a single removal spawns */
  perRemoval: 60,
  /** bodies created per frame (the rest waits in the queue) */
  spawnPerFrame: 40,
  /** pending spawns kept at most (older ones are dropped) */
  maxQueue: 240,
  /** settled chips that keep a (fixed) collider so the pile can build up */
  pileColliders: 250,
  /** static pile instances per piece variant (ring buffer) */
  pilePerVariant: 800,
  /** falling chunks kept at most (oldest shrinks away) */
  maxChunks: 12,
  /** a step slower than this lowers the live cap by 20 % */
  slowStepMs: 6,
  /** fixed steps per frame at most (slow frames run the debris in slow motion) */
  maxStepsPerFrame: 2,
} as const;

const DT = 1 / 60;
/** far below the floor: where the GPU warm-up dummies are drawn */
const WARM_Y = -100;
const SHRINK_S = 0.45;

export interface DebrisStats {
  mode: DebrisMode;
  /** physics world + chip meshes ready */
  ready: boolean;
  failed: boolean;
  /** chips simulated right now */
  live: number;
  /** chips waiting to be spawned (spawn budget per frame) */
  queued: number;
  pile: number;
  chunks: number;
  ghosts: number;
  liveCap: number;
  spawned: number;
  /** chips that settled into the static pile / shrank away / fell off the world, cumulative */
  piled: number;
  faded: number;
  lost: number;
  /** ms from the load request to a usable world (Rapier init + glb) */
  initMs: number;
  /** longest single synchronous slice of the init (world + colliders + meshes), ms */
  initSliceMs: number;
  stepMsAvg: number;
  stepMsMax: number;
  /** longest `update()` (spawn + step + sync), ms */
  updateMsMax: number;
}

export interface DebrisOptions {
  /** world-frame parent for every debris object */
  parent: THREE.Object3D;
  grid: Grid;
  /** voxel size, m */
  h: number;
  /** live carve state (read only) */
  solid: Uint8Array;
  block: Uint8Array;
  mode: DebrisMode;
  /** current colour of a cell, linear RGB */
  colorOf: (e: number) => readonly [number, number, number];
  /** static colliders (bench, jigs), world frame — read when the world is built */
  staticColliders: () => BoxCollider[];
  /** world y of the bench top (chips resting at or below it + 3 cm join the pile) */
  benchY: number;
  /** compile materials off the critical path before first use (renderer.compileAsync) */
  prepare?: (obj: THREE.Object3D) => Promise<unknown>;
  /** environment map for the metallic chips (awaited before the chip material is built) */
  envMap?: () => Promise<THREE.Texture | null> | THREE.Texture | null;
  seed?: number;
  /** delay before lazily loading Rapier + debris.glb, ms */
  preloadDelayMs?: number;
}

interface Chip {
  body: RigidBody | null;
  variant: number;
  scale: number;
  color: THREE.Color;
  age: number;
  restFor: number;
  /** ≥ 0 while shrinking away (no body), seconds into the shrink */
  shrink: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

interface Chunk {
  body: RigidBody | null;
  mesh: THREE.Mesh;
  cells: Set<number>;
  age: number;
  restFor: number;
  shrink: number;
  frozen: boolean;
}

interface Pending {
  spawn: ChipSpawn;
  color: THREE.Color;
}

export class DebrisFx {
  readonly group = new THREE.Group();
  readonly stats: DebrisStats;
  private readonly rand: () => number;
  private readonly ghosts: FadeGhosts;
  private physics: DebrisPhysics | null = null;
  private live: LiveChips | null = null;
  private pile: ChipPile | null = null;
  private chipMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly chunkMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  private chips: Chip[] = [];
  private chunks: Chunk[] = [];
  private queue: Pending[] = [];
  private pileBodies: RigidBody[] = [];
  private liveCap: number = DEBRIS_LIMITS.maxLive;
  private lastMs: number | null = null;
  private acc = 0;
  private disposed = false;
  private preloadTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly settle: SettleRule;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  /**
   * Frames left in which an off-screen dummy of every debris mesh is drawn: ANGLE/Metal
   * builds GPU pipelines at the first draw, which would otherwise hitch the first carve.
   */
  private warmFrames = 0;
  private ghostsWarm = false;
  private readonly warmColor = new THREE.Color(1, 1, 1);
  private warmChunk: THREE.Mesh | null = null;

  constructor(private readonly opts: DebrisOptions) {
    this.group.name = 'debris';
    opts.parent.add(this.group);
    this.rand = rng(opts.seed ?? 0x7310);
    this.ghosts = new FadeGhosts(opts.h);
    this.group.add(this.ghosts.group);
    this.settle = {
      linear: 0.02,
      angular: 1.5,
      restTime: 0.35,
      pileMaxY: opts.benchY + 0.03,
      killY: opts.benchY - 1.5,
      maxAge: 8,
    };
    this.stats = {
      mode: opts.mode,
      ready: false,
      failed: false,
      live: 0,
      queued: 0,
      pile: 0,
      chunks: 0,
      ghosts: 0,
      liveCap: this.liveCap,
      spawned: 0,
      piled: 0,
      faded: 0,
      lost: 0,
      initMs: NaN,
      initSliceMs: NaN,
      stepMsAvg: 0,
      stepMsMax: 0,
      updateMsMax: 0,
    };
    if (opts.mode !== 'off') void opts.prepare?.(this.ghosts.sample());
    if (opts.mode === 'physics') {
      this.preloadTimer = setTimeout(() => void this.init(), opts.preloadDelayMs ?? 400);
    }
  }

  // --- events from the scene -------------------------------------------------

  /** Cells left the solid set (carved, or floating pieces cut off). */
  removed(cells: readonly number[], cause: 'carve' | 'floating'): void {
    if (this.opts.mode === 'off' || cells.length === 0 || this.disposed) return;
    if (!this.physicsReady) {
      this.fade(cells);
      return;
    }
    if (cause === 'floating') {
      for (const comp of components(this.opts.grid, cells)) {
        if (comp.length >= CHUNK_MIN_CELLS) this.spawnChunk(comp);
        else this.queueChips(comp, 0.5);
      }
    } else {
      this.queueChips(cells, 1);
    }
  }

  /** Cells flipped solid/empty (carve, undo/redo, floating): keep the part collider in sync. */
  solidChanged(cells: readonly number[]): void {
    const p = this.physics;
    if (!p || p.failed) return;
    const g = this.opts.grid;
    let restored: Set<number> | null = null;
    for (const e of cells) {
      const filled = this.opts.solid[e] === 1 || this.opts.block[e] === 1;
      const [x, y, z] = cellCoords(g, e);
      p.setVoxel(x, y, z, filled);
      if (this.opts.solid[e] === 1) (restored ??= new Set()).add(e);
    }
    // undo brought cut-off cells back: their chunk lying on the bench goes away
    if (restored) {
      for (const c of this.chunks) {
        if (c.shrink < 0 && [...restored].some((e) => c.cells.has(e))) this.shrinkChunk(c);
      }
    }
  }

  /** Per animation frame. */
  update(timeMs: number): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const dt = this.lastMs === null ? 0 : Math.min(0.1, Math.max(0, (timeMs - this.lastMs) / 1000));
    this.lastMs = timeMs;
    if (!this.ghostsWarm && this.opts.mode !== 'off') {
      this.ghostsWarm = true;
      this.ghosts.add([0, WARM_Y, 0], [1, 1, 1], timeMs / 1000);
    }
    this.ghosts.update(timeMs / 1000);
    if (this.physicsReady) {
      this.spawnQueued();
      this.stepPhysics(dt);
      if (this.physics!.failed) this.onPhysicsFailure();
    }
    this.syncChips(dt);
    this.syncChunks(dt);
    const s = this.stats;
    s.live = this.chips.reduce((n, c) => n + (c.body ? 1 : 0), 0);
    s.queued = this.queue.length;
    s.pile = this.pile?.size ?? 0;
    s.chunks = this.chunks.length;
    s.ghosts = this.ghosts.active;
    s.liveCap = this.liveCap;
    s.updateMsMax = Math.max(s.updateMsMax, performance.now() - t0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.preloadTimer !== null) clearTimeout(this.preloadTimer);
    this.physics?.free();
    this.physics = null;
    this.ghosts.dispose();
    for (const c of this.chunks) c.mesh.geometry.dispose();
    this.warmChunk?.geometry.dispose();
    this.chunkMaterial.dispose();
    this.chipMaterial?.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
    this.group.removeFromParent();
    this.chips = [];
    this.chunks = [];
    this.queue = [];
  }

  // --- init --------------------------------------------------------------------

  private get physicsReady(): boolean {
    return this.physics !== null && !this.physics.failed && this.live !== null;
  }

  private async init(): Promise<void> {
    this.preloadTimer = null;
    const t0 = performance.now();
    let R: Awaited<ReturnType<typeof loadRapier>>;
    let template: THREE.Object3D;
    let envMap: THREE.Texture | null;
    try {
      [R, template, envMap] = await Promise.all([loadRapier(), loadTemplate('debris'), this.opts.envMap?.() ?? null]);
    } catch (err) {
      console.warn('[debris] physics unavailable, fading instead:', err);
      this.stats.failed = true;
      return;
    }
    if (this.disposed) return;

    // synchronous slice 1: world + colliders
    const s0 = performance.now();
    const physics = new DebrisPhysics(R, DEBRIS_DENSITY);
    physics.addStatic(this.opts.staticColliders());
    const { solid, block } = this.opts;
    physics.setPart(this.opts.grid, this.opts.h, (e) => solid[e] === 1 || block[e] === 1);
    const slice1 = performance.now() - s0;
    measure('debris:world', s0, s0 + slice1);
    // The first step of a fresh world is slow (lazy WASM compilation, broad-phase build:
    // ~35 ms on an M-series Mac). Pay it now, in its own task, not in a gameplay frame.
    await yieldTask();
    if (this.disposed) {
      physics.free();
      return;
    }
    const w0 = performance.now();
    physics.step();
    const warmStep = performance.now() - w0;
    measure('debris:warm-step', w0, w0 + warmStep);
    await yieldTask();
    if (this.disposed) {
      physics.free();
      return;
    }

    // meshes (materials compiled off the critical path before they show up)
    const geoms = PIECE_NAMES.map((n) => {
      const o = template.getObjectByName(n);
      return o instanceof THREE.Mesh ? (o.geometry as THREE.BufferGeometry) : new THREE.BoxGeometry(0.006, 0.004, 0.006);
    });
    const src = template.getObjectByName('chip_0');
    const baseMat =
      src instanceof THREE.Mesh && src.material instanceof THREE.MeshStandardMaterial
        ? src.material.clone()
        : new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.45 });
    baseMat.envMap = envMap;
    baseMat.envMapIntensity = 0.8;
    this.chipMaterial = baseMat;
    const s1 = performance.now();
    const live = new LiveChips(geoms, baseMat, DEBRIS_LIMITS.maxLive);
    const pile = new ChipPile(geoms, baseMat, DEBRIS_LIMITS.pilePerVariant);
    const slice2 = performance.now() - s1;
    measure('debris:meshes', s1, s1 + slice2);
    const warm = new THREE.Group();
    const sampleChunk = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), this.chunkMaterial);
    warm.add(live.group, pile.group, sampleChunk);
    const c0 = performance.now();
    try {
      await this.opts.prepare?.(warm);
    } catch {
      // compile warm-up is an optimisation only
    }
    measure('debris:compile', c0, performance.now());
    sampleChunk.geometry.dispose();
    warm.remove(live.group, pile.group, sampleChunk);
    if (this.disposed) {
      physics.free();
      return;
    }
    this.physics = physics;
    this.live = live;
    this.pile = pile;
    this.group.add(live.group, pile.group);
    this.warmChunk = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), this.chunkMaterial);
    this.warmChunk.position.set(0, WARM_Y, 0);
    this.warmChunk.frustumCulled = false;
    this.group.add(this.warmChunk);
    this.warmFrames = 3;
    this.stats.ready = true;
    this.stats.initMs = performance.now() - t0;
    this.stats.initSliceMs = Math.max(slice1, slice2, warmStep);
  }

  private onPhysicsFailure(): void {
    this.stats.failed = true;
    for (const c of this.chips) {
      c.body = null;
      if (c.shrink < 0) c.shrink = 0;
    }
    for (const c of this.chunks) {
      c.body = null;
      if (c.shrink < 0) c.shrink = 0;
    }
    this.queue = [];
    this.pileBodies = [];
    this.live?.begin();
  }

  // --- spawning ------------------------------------------------------------------

  private fade(cells: readonly number[]): void {
    const centers: number[] = [];
    const colors: number[] = [];
    const h = this.opts.h;
    for (const e of cells) {
      const [x, y, z] = cellCoords(this.opts.grid, e);
      centers.push((x + 0.5) * h, (y + 0.5) * h, (z + 0.5) * h);
      const c = this.opts.colorOf(e);
      colors.push(c[0], c[1], c[2]);
    }
    this.ghosts.add(centers, colors, (this.lastMs ?? performance.now()) / 1000);
  }

  private queueChips(cells: readonly number[], speedScale: number): void {
    const counts = chipCounts(cells.length, { perCell: DEBRIS_LIMITS.perCell, max: DEBRIS_LIMITS.perRemoval });
    const g = this.opts.grid;
    const h = this.opts.h;
    const kin = {
      ...CHIP_KINEMATICS,
      speed: [CHIP_KINEMATICS.speed[0] * speedScale, CHIP_KINEMATICS.speed[1] * speedScale] as const,
      pop: [CHIP_KINEMATICS.pop[0] * speedScale, CHIP_KINEMATICS.pop[1] * speedScale] as const,
      h,
      variants: PIECE_NAMES.length,
    };
    cells.forEach((e, i) => {
      const n = counts[i]!;
      if (n === 0) return;
      const cell = cellCoords(g, e);
      const center: Vec3 = [(cell[0] + 0.5) * h, (cell[1] + 0.5) * h, (cell[2] + 0.5) * h];
      const out = outwardDir(g, this.opts.solid, cell);
      const rgb = this.opts.colorOf(e);
      for (let k = 0; k < n; k++) {
        this.queue.push({ spawn: chipSpawn(this.rand, center, out, kin), color: new THREE.Color(rgb[0], rgb[1], rgb[2]) });
      }
    });
    if (this.queue.length > DEBRIS_LIMITS.maxQueue) this.queue.splice(0, this.queue.length - DEBRIS_LIMITS.maxQueue);
  }

  private spawnQueued(): void {
    const p = this.physics!;
    let budget = DEBRIS_LIMITS.spawnPerFrame;
    let simulated = this.chips.reduce((n, c) => n + (c.body ? 1 : 0), 0);
    while (budget > 0 && this.queue.length > 0) {
      const { spawn, color } = this.queue.shift()!;
      budget--;
      if (simulated >= this.liveCap && this.evictOldest()) simulated--;
      simulated++;
      const half = PIECE_HALF_EXTENTS[PIECE_NAMES[spawn.variant] ?? 'chip_0'];
      const body = p.addChip({
        ...spawn,
        halfExtents: [half[0] * spawn.scale, half[1] * spawn.scale, half[2] * spawn.scale],
      });
      this.chips.push({
        body,
        variant: spawn.variant,
        scale: spawn.scale,
        color,
        age: 0,
        restFor: 0,
        shrink: -1,
        position: new THREE.Vector3(...spawn.position),
        quaternion: new THREE.Quaternion(...spawn.rotation),
      });
      this.stats.spawned++;
    }
  }

  /** Make room: the oldest simulated chip settles into the pile (low) or shrinks away. */
  private evictOldest(): boolean {
    const c = this.chips.find((x) => x.body);
    if (!c) return false;
    this.retire(c, c.position.y <= this.settle.pileMaxY ? 'pile' : 'fade');
    return true;
  }

  private spawnChunk(cells: number[]): void {
    const g = this.opts.grid;
    const h = this.opts.h;
    const origin: Vec3 = [0, 0, 0];
    for (const e of cells) {
      const [x, y, z] = cellCoords(g, e);
      origin[0] += ((x + 0.5) * h) / cells.length;
      origin[1] += ((y + 0.5) * h) / cells.length;
      origin[2] += ((z + 0.5) * h) / cells.length;
    }
    const geo = cellSurfaceGeometry(g, cells, h, origin, this.opts.colorOf);
    const mesh = new THREE.Mesh(geo, this.chunkMaterial);
    mesh.castShadow = true;
    mesh.position.set(...origin);
    mesh.name = 'debris-chunk';
    const r = this.rand;
    const body = this.physics!.addChunk(
      greedyBoxes(g, cells),
      h,
      origin,
      [(r() - 0.5) * 0.05, 0.02, (r() - 0.5) * 0.05],
      [(r() - 0.5) * 1.5, (r() - 0.5) * 1.5, (r() - 0.5) * 1.5],
    );
    this.group.add(mesh);
    this.chunks.push({ body, mesh, cells: new Set(cells), age: 0, restFor: 0, shrink: -1, frozen: false });
    const alive = this.chunks.filter((c) => c.shrink < 0);
    if (alive.length > DEBRIS_LIMITS.maxChunks) this.shrinkChunk(alive[0]!);
  }

  // --- simulation -----------------------------------------------------------------

  private stepPhysics(dt: number): void {
    const p = this.physics!;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && steps < DEBRIS_LIMITS.maxStepsPerFrame) {
      const ms = p.step();
      steps++;
      this.acc -= DT;
      if (!Number.isFinite(ms)) return;
      if (ms > 4) measure('debris:slow-step', performance.now() - ms, performance.now());
      const s = this.stats;
      s.stepMsAvg = s.stepMsAvg * 0.95 + ms * 0.05;
      s.stepMsMax = Math.max(s.stepMsMax, ms);
      if (ms > DEBRIS_LIMITS.slowStepMs) {
        this.liveCap = Math.max(DEBRIS_LIMITS.minLive, Math.floor(this.liveCap * 0.8));
        let over = this.chips.reduce((n, c) => n + (c.body ? 1 : 0), 0) - this.liveCap;
        while (over-- > 0 && this.evictOldest());
      }
    }
    // a long stall (tab in background, slow frame) is dropped, not caught up
    if (this.acc > DT) this.acc = 0;
    if (steps > 0 && this.stats.stepMsAvg < DEBRIS_LIMITS.slowStepMs / 3 && this.liveCap < DEBRIS_LIMITS.maxLive) {
      this.liveCap = Math.min(DEBRIS_LIMITS.maxLive, this.liveCap + 1);
    }
  }

  private syncChips(dt: number): void {
    const live = this.live;
    if (!live) return;
    live.begin();
    const keep: Chip[] = [];
    for (const c of this.chips) {
      c.age += dt;
      if (c.body) {
        const t = c.body.translation();
        const q = c.body.rotation();
        c.position.set(t.x, t.y, t.z);
        c.quaternion.set(q.x, q.y, q.z, q.w);
        const lv = c.body.linvel();
        const av = c.body.angvel();
        const speed = Math.hypot(lv.x, lv.y, lv.z);
        const ang = Math.hypot(av.x, av.y, av.z);
        c.restFor = speed < this.settle.linear && ang < this.settle.angular ? c.restFor + dt : 0;
        const verdict = settleVerdict(this.settle, t.y, speed, ang, c.restFor, c.age, c.body.isSleeping());
        if (verdict === 'kill') {
          this.physics?.remove(c.body);
          c.body = null;
          this.stats.lost++;
          continue;
        }
        if (verdict !== 'moving') {
          this.retire(c, verdict);
          if (verdict === 'pile') continue;
        }
      }
      let s = c.scale;
      if (c.shrink >= 0) {
        c.shrink += dt;
        if (c.shrink >= SHRINK_S) continue;
        s *= 1 - c.shrink / SHRINK_S;
      }
      this.m.compose(c.position, c.quaternion, this.v.setScalar(s));
      live.push(c.variant, this.m, c.color);
      keep.push(c);
    }
    this.chips = keep;
    if (this.warmFrames > 0) {
      this.m.makeTranslation(0, WARM_Y, 0);
      for (let v = 0; v < PIECE_NAMES.length; v++) live.push(v, this.m, this.warmColor);
      if (--this.warmFrames === 0 && this.warmChunk) {
        this.warmChunk.removeFromParent();
        this.warmChunk.geometry.dispose();
        this.warmChunk = null;
      }
    }
    live.end();
  }

  /** A chip leaves the simulation: into the static pile, or shrinking away. */
  private retire(c: Chip, how: 'pile' | 'fade'): void {
    const p = this.physics;
    if (how === 'pile' && c.body && this.pile) {
      this.m.compose(c.position, c.quaternion, this.v.setScalar(c.scale));
      this.pile.add(c.variant, this.m, c.color);
      p?.freeze(c.body);
      this.pileBodies.push(c.body);
      if (this.pileBodies.length > DEBRIS_LIMITS.pileColliders) p?.remove(this.pileBodies.shift()!);
      c.body = null;
      c.shrink = SHRINK_S; // drop from the live list
      this.stats.piled++;
      return;
    }
    if (c.body) p?.remove(c.body);
    c.body = null;
    if (c.shrink < 0) {
      c.shrink = 0;
      this.stats.faded++;
    }
  }

  private syncChunks(dt: number): void {
    const keep: Chunk[] = [];
    for (const c of this.chunks) {
      c.age += dt;
      if (c.body && !c.frozen) {
        const t = c.body.translation();
        const q = c.body.rotation();
        c.mesh.position.set(t.x, t.y, t.z);
        c.mesh.quaternion.set(q.x, q.y, q.z, q.w);
        const lv = c.body.linvel();
        const av = c.body.angvel();
        const speed = Math.hypot(lv.x, lv.y, lv.z);
        const ang = Math.hypot(av.x, av.y, av.z);
        c.restFor = speed < this.settle.linear && ang < this.settle.angular ? c.restFor + dt : 0;
        if (t.y < this.settle.killY) {
          this.shrinkChunk(c);
        } else if (c.body.isSleeping() || c.restFor > 0.6 || c.age > 12) {
          this.physics?.freeze(c.body);
          c.frozen = true;
        }
      }
      if (c.shrink >= 0) {
        c.shrink += dt;
        if (c.shrink >= SHRINK_S) {
          c.mesh.removeFromParent();
          c.mesh.geometry.dispose();
          continue;
        }
        c.mesh.scale.setScalar(1 - c.shrink / SHRINK_S);
      }
      keep.push(c);
    }
    this.chunks = keep;
  }

  private shrinkChunk(c: Chunk): void {
    if (c.body) this.physics?.remove(c.body);
    c.body = null;
    c.frozen = true;
    if (c.shrink < 0) c.shrink = 0;
  }
}

/** Let the browser run a frame / other tasks before the next synchronous slice. */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
