// The workshop around the part (design doc 演出 / T-307 assets): the baked workbench + room,
// glTF jigs at the stage's supports and loads (replacing the T-102 placeholders once loaded),
// the part's realtime shadow on the test bed, and the debris show. One per game session:
// StageScene creates it and disposes it with the scene (T-304 disposes on every route change).
//
// Lazy: nothing here blocks the first paint. The glbs and the GLTFLoader load after the
// constructor returns; materials are compiled with `renderer.compileAsync` before the swap;
// the swap waits while the load test animates the jigs (`jigsLocked`, T-302).
//
// Frames: world = stage frame (metres, Y-up, grid min corner at the origin); the bench frame
// origin (test-bed top centre) sits at `layout.benchOrigin` = (domain centre x, −0.16, z).

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CarveState } from '../../game/carveState.ts';
import type { RemovalCause } from '../../game/controller.ts';
import { colorAt, KEEP_TINT, linearPalette, NEUTRAL, PALETTES, srgbToLinear, type Palette, type PaletteId } from '../colormap.ts';
import { BED_HALF, BENCH_COLLIDERS, CYLINDER, JIG_BOUNDS, WEIGHT_LIFT, type Aabb, type AssetName } from './assetSpec.ts';
import { instantiate, loadTemplate } from './assets.ts';
import { DebrisFx } from './debris/debris.ts';
import { measure, type BoxCollider } from './debris/physics.ts';
import { resolveFx, type FxOptions } from './debris/plan.ts';
import { computeLayout, loadPartBoxes, type EnvLayout, type LoadJig, type Pose } from './placement.ts';

export interface WorkshopOptions {
  scene: THREE.Scene;
  /** `StageScene.env`: holds the placeholder bench until the glTF bench replaces it */
  env: THREE.Group;
  /** `StageScene.jigs`: placeholder jigs, hidden once the glTF jigs are in */
  placeholders: THREE.Group;
  /** grid-unit group whose opaque meshes cast the part's shadow onto the bed */
  domain: THREE.Object3D;
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  state: CarveState;
  palette: PaletteId;
  /** effect switches; default from the URL, build mode and prefers-reduced-motion */
  fx?: FxOptions;
}

/** Baked bench lamp above the test bed (bench frame, README "Bench / room"). */
const LAMP: [number, number, number] = [0, 0.95, -0.12];
const SHADOW_OPACITY = 0.32;

export class Workshop {
  readonly layout: EnvLayout;
  readonly fx: FxOptions;
  readonly debris: DebrisFx;
  readonly group = new THREE.Group();
  /** resolves true once the glTF environment is in the scene (false: disabled / failed) */
  readonly loaded: Promise<boolean>;
  /** the glTF bench, room and jigs have replaced the placeholders (e2e / debugging) */
  envReady = false;
  /** true while something animates the load jigs (T-302 load test): the swap waits */
  jigsLocked: () => boolean = () => false;

  private readonly shadowLight: THREE.DirectionalLight;
  private readonly shadowPlane: THREE.Mesh;
  private loadRoots: THREE.Object3D[] = [];
  private pendingSwap: (() => void) | null = null;
  private envTexture: THREE.Texture | null = null;
  private utilization: Float32Array | null = null;
  private palette: Palette;
  private disposed = false;
  private frame = 0;

  constructor(private readonly opts: WorkshopOptions) {
    const { state, renderer } = opts;
    this.layout = computeLayout(state.stage);
    this.fx =
      opts.fx ??
      resolveFx({
        search: typeof location === 'undefined' ? '' : location.search,
        mode: import.meta.env.MODE,
        reducedMotion: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      });
    this.palette = linearPalette(PALETTES[opts.palette]);
    this.group.name = 'workshop';
    opts.env.add(this.group);

    // The part's shadow on the test bed: the baked bench is unlit, so a ShadowMaterial plane
    // catches it, cast by an intensity-0 light at the baked lamp (it darkens nothing else).
    // Set up before the first render so no material recompiles later.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const [bx, by, bz] = this.layout.benchOrigin;
    const d = this.layout.domain.max;
    this.shadowLight = new THREE.DirectionalLight(0xffffff, 0);
    this.shadowLight.name = 'shadow-lamp';
    this.shadowLight.castShadow = true;
    this.shadowLight.position.set(bx + LAMP[0], by + LAMP[1], bz + LAMP[2]);
    this.shadowLight.target.position.set(bx, by, bz);
    const half = Math.max(d[0], d[2], 0.2) / 2 + 0.15;
    const cam = this.shadowLight.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 0.1;
    cam.far = LAMP[1] + 0.3;
    this.shadowLight.shadow.mapSize.set(1024, 1024);
    this.shadowLight.shadow.radius = 4;
    this.shadowLight.shadow.bias = -0.0008;
    this.group.add(this.shadowLight, this.shadowLight.target);
    this.shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(BED_HALF[0] * 2, BED_HALF[1] * 2),
      new THREE.ShadowMaterial({ opacity: SHADOW_OPACITY, depthWrite: false }),
    );
    this.shadowPlane.name = 'bed-shadow';
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.position.set(bx, by + 0.0004, bz);
    this.shadowPlane.receiveShadow = true;
    this.shadowPlane.renderOrder = 1;
    this.group.add(this.shadowPlane);

    this.debris = new DebrisFx({
      parent: this.group,
      grid: state.grid,
      h: state.stage.voxelSize,
      solid: state.solid,
      block: state.block,
      mode: this.fx.debris,
      colorOf: (e) => this.colorOf(e),
      staticColliders: () => this.staticColliders(),
      benchY: by,
      prepare: (o) => renderer.compileAsync(o, opts.camera, opts.scene),
      envMap: () => this.loaded.then(() => this.envTexture),
    });

    this.loaded = this.fx.env ? this.loadEnvironment() : Promise.resolve(false);
  }

  // --- scene hooks -----------------------------------------------------------------

  /** Load-jig roots for the load test: glTF ones once loaded, else the placeholder arrows. */
  loadJigs(): THREE.Object3D[] {
    if (this.loadRoots.length > 0) return this.loadRoots;
    return this.opts.placeholders.children.filter((o) => o.name === 'load');
  }

  elementsRemoved(cells: readonly number[], cause: RemovalCause): void {
    this.debris.removed(cells, cause);
  }

  solidChanged(cells: readonly number[]): void {
    this.debris.solidChanged(cells);
  }

  setUtilization(u: Float32Array | null): void {
    this.utilization = u;
  }

  setPalette(id: PaletteId): void {
    this.palette = linearPalette(PALETTES[id]);
  }

  update(timeMs: number): void {
    if (this.disposed) return;
    if (this.pendingSwap && !this.jigsLocked()) {
      this.pendingSwap();
      this.pendingSwap = null;
    }
    // the voxel chunks / deformed mesh come and go: refresh shadow casting a few times a second
    if (this.frame++ % 10 === 0) {
      this.opts.domain.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          o.castShadow = mats.every((m: THREE.Material) => !m.transparent);
        }
      });
    }
    this.debris.update(timeMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingSwap = null;
    this.debris.dispose();
    this.envTexture?.dispose();
    this.envTexture = null;
    // meshes under `group` are disposed by StageScene's scene traversal; detach the rest
    this.shadowLight.shadow.dispose();
  }

  // --- internals ---------------------------------------------------------------------

  /** Linear RGB a removed cell was shown in (stress colour of the latest result). */
  private colorOf(e: number): readonly [number, number, number] {
    if (this.opts.state.keep[e]) return srgbToLinear(KEEP_TINT);
    const u = this.utilization;
    if (!u) return srgbToLinear(NEUTRAL);
    const out = [0, 0, 0];
    colorAt(this.palette, u[e] ?? 0, out);
    return [out[0]!, out[1]!, out[2]!];
  }

  /** Bench + jig boxes in the world frame, for the debris physics. */
  private staticColliders(): BoxCollider[] {
    const [bx, by, bz] = this.layout.benchOrigin;
    const out: BoxCollider[] = BENCH_COLLIDERS.map((c) => ({
      center: [c.center[0] + bx, c.center[1] + by, c.center[2] + bz],
      halfExtents: [c.halfExtents[0], c.halfExtents[1], c.halfExtents[2]],
    }));
    for (const s of this.layout.supports) {
      out.push(boxInPose(JIG_BOUNDS[s.asset], s.pose));
      if (s.riser) out.push(aabbCollider(s.riser.bounds));
    }
    for (const l of this.layout.loads) {
      for (const b of loadPartBoxes(l.kind, l.spreader, l.offset)) {
        const lifted: Aabb = { min: [b.min[0], b.min[1] + l.lift, b.min[2]], max: [b.max[0], b.max[1] + l.lift, b.max[2]] };
        out.push(boxInPose(lifted, l.pose));
      }
    }
    return out;
  }

  private async loadEnvironment(): Promise<boolean> {
    const L = this.layout;
    const needed = new Set<AssetName>(['workbench', 'workshop']);
    for (const s of L.supports) {
      needed.add(s.asset);
      if (s.riser) needed.add('jig_riser');
    }
    for (const l of L.loads) {
      needed.add(l.kind === 'cylinder' ? 'jig_cylinder' : 'jig_weight');
      if (l.spreader) needed.add('jig_spreader');
    }
    const names = [...needed];
    let loaded: THREE.Object3D[];
    const t0 = performance.now();
    try {
      loaded = await Promise.all(names.map((n) => loadTemplate(n)));
      measure('env:load', t0, performance.now());
    } catch (err) {
      console.warn('[workshop] environment assets failed to load; keeping placeholders:', err);
      return false;
    }
    if (this.disposed) return false;
    const t1 = performance.now();
    const tpl = new Map(names.map((n, i) => [n, loaded[i]!] as const));
    const materials = new Map<THREE.Material, THREE.Material>();
    const make = (n: AssetName) => instantiate(tpl.get(n)!, materials);

    const root = new THREE.Group();
    root.name = 'workshop-env';
    for (const n of ['workbench', 'workshop'] as const) {
      const o = make(n);
      o.position.set(...L.benchOrigin);
      root.add(o);
    }
    const jigs = new THREE.Group();
    jigs.name = 'jigs-gltf';
    for (const s of L.supports) {
      const o = make(s.asset);
      applyPose(o, s.pose);
      o.userData = { ...o.userData, kind: 'support', supportIndex: s.supportIndex };
      jigs.add(o);
      if (s.riser) {
        const r = make('jig_riser');
        applyPose(r, s.riser.pose);
        const column = r.getObjectByName('riser_column');
        if (column) column.scale.y = s.riser.height;
        jigs.add(r);
      }
    }
    const loadRoots = L.loads.map((l) => buildLoadJig(l, make));
    jigs.add(...loadRoots);
    root.add(jigs);

    measure('env:instantiate', t1, performance.now());
    // unlit baked surfaces render as authored; lit jigs get a room environment for metals
    const t2 = performance.now();
    const env = this.environmentMap();
    measure('env:pmrem', t2, performance.now());
    for (const m of materials.values()) {
      if (m instanceof THREE.MeshBasicMaterial) m.toneMapped = false;
      if (m instanceof THREE.MeshStandardMaterial) {
        m.envMap = env;
        m.envMapIntensity = 0.7;
      }
    }
    jigs.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const t3 = performance.now();
    try {
      await this.opts.renderer.compileAsync(root, this.opts.camera, this.opts.scene);
    } catch {
      // warm-up only
    }
    measure('env:compile', t3, performance.now());
    if (this.disposed) return false;
    this.pendingSwap = () => {
      const t4 = performance.now();
      // drop the T-102 placeholder bench, hide the placeholder jigs, show the real ones
      for (const child of [...this.opts.env.children]) {
        if (child === this.group) continue;
        child.removeFromParent();
        child.traverse((o) => {
          if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
            o.geometry.dispose();
            (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: THREE.Material) => m.dispose());
          }
        });
      }
      this.opts.placeholders.visible = false;
      this.group.add(root);
      this.loadRoots = loadRoots;
      this.envReady = true;
      measure('env:swap', t4, performance.now());
    };
    return true;
  }

  private environmentMap(): THREE.Texture | null {
    if (this.envTexture) return this.envTexture;
    try {
      const pmrem = new THREE.PMREMGenerator(this.opts.renderer);
      const room = new RoomEnvironment();
      // sigma 0: the room is soft already; the extra blur pass costs ~10 ms on the main thread
      this.envTexture = pmrem.fromScene(room, 0).texture;
      room.dispose();
      pmrem.dispose();
    } catch (err) {
      console.warn('[workshop] no environment map:', err);
    }
    return this.envTexture;
  }
}

/**
 * One load jig root: origin at the contact centre, local −Y = F̂ (T-302 moves `position`).
 * Inside: an inner group lifted for tilted loads, the spreader plate on the part, the
 * cylinder (or weight) above it. `userData.setStroke(t)`: 1 = rest pose (pad on the plate /
 * weights hanging), 0 = rod retracted by `rodTravel` (weights lifted).
 */
function buildLoadJig(l: LoadJig, make: (n: AssetName) => THREE.Object3D): THREE.Object3D {
  const root = new THREE.Group();
  root.name = 'load';
  applyPose(root, l.pose);
  const inner = new THREE.Group();
  inner.position.y = l.lift;
  root.add(inner);
  if (l.spreader) {
    const plate = make('jig_spreader');
    plate.scale.set(l.spreader[0], 1, l.spreader[1]);
    inner.add(plate);
  }
  const body = make(l.kind === 'cylinder' ? 'jig_cylinder' : 'jig_weight');
  body.position.y = l.offset;
  inner.add(body);
  const moving = body.getObjectByName(l.kind === 'cylinder' ? 'cylinder_rod' : 'weight_stack');
  const rest = moving ? moving.position.y : 0;
  const travel = l.kind === 'cylinder' ? CYLINDER.rodTravel : WEIGHT_LIFT;
  root.userData = {
    kind: 'load',
    caseIndex: l.caseIndex,
    cases: l.cases,
    loadIndex: l.loadIndex,
    setStroke: (t: number) => {
      if (moving) moving.position.y = rest + travel * (1 - Math.min(1, Math.max(0, t)));
    },
  };
  return root;
}

function applyPose(o: THREE.Object3D, p: Pose): void {
  o.position.set(...p.position);
  o.quaternion.set(...p.quaternion);
  o.scale.set(...p.scale);
}

/** A local box under a pose as an oriented collider. */
function boxInPose(box: Aabb, p: Pose): BoxCollider {
  const c = new THREE.Vector3(
    ((box.min[0] + box.max[0]) / 2) * p.scale[0],
    ((box.min[1] + box.max[1]) / 2) * p.scale[1],
    ((box.min[2] + box.max[2]) / 2) * p.scale[2],
  )
    .applyQuaternion(new THREE.Quaternion(...p.quaternion))
    .add(new THREE.Vector3(...p.position));
  return {
    center: [c.x, c.y, c.z],
    halfExtents: [
      (Math.abs(box.max[0] - box.min[0]) / 2) * p.scale[0],
      (Math.abs(box.max[1] - box.min[1]) / 2) * p.scale[1],
      (Math.abs(box.max[2] - box.min[2]) / 2) * p.scale[2],
    ],
    rotation: p.quaternion,
  };
}

function aabbCollider(b: Aabb): BoxCollider {
  return {
    center: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
    halfExtents: [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2],
  };
}
