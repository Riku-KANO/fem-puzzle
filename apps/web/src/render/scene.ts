// The 3D view: renderer, camera + orbit controls, lights, a placeholder bench, the voxel
// surface, obstacles, jigs and the brush preview. Implements the controller's `ViewPort`.
//
// World frame = stage frame: metres, Y-up, grid min corner at the origin. Voxel geometry
// lives in grid units inside `domain` (scaled by the voxel size). Extension points:
//   - T-302 deformation: `voxels.meshes()` (vertex → node ids) + `lastResult` displacements;
//   - T-303 section/X-ray: `voxels.meshes()` materials (clipping), `pickFilter`;
//   - T-307/T-310 environment & debris: `env` group, `elementsRemoved()`.

import type { ResultMsg, Vec3 } from '@stress-carve/protocol';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BrushSelection } from '../game/brush.ts';
import type { CarveState } from '../game/carveState.ts';
import type { RemovalCause, ViewPort } from '../game/controller.ts';
import { cellCoords } from '../game/grid.ts';
import type { PaletteId } from './colormap.ts';
import { buildJigs, supportPatches } from './jigs.ts';
import { raycastGrid, type VoxelHit } from './picking.ts';
import { buildBlockMesh, timeUniform, VoxelMesh } from './voxelMesh.ts';

/** Height of the placeholder bench below the domain (matches T-307's workbench offset). */
const BENCH_DROP = 0.16;
const MAX_BRUSH_CELLS = 25;
const ELEVATION = Math.PI / 4;

export class StageScene implements ViewPort {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** grid-unit group (scale = voxel size) holding voxels, blocks and the brush preview */
  readonly domain = new THREE.Group();
  /** environment placeholder (bench) — T-307/T-310 replace its contents */
  readonly env = new THREE.Group();
  readonly voxels: VoxelMesh;
  /** cells that stop picking rays (T-303 narrows this for section/X-ray views) */
  pickFilter: (element: number) => boolean;
  /** latest current solver result (T-302 reads displacements from here) */
  lastResult: ResultMsg | null = null;
  /** called once per animation frame before rendering (the app flushes solver diffs here) */
  onFrame: (() => void) | null = null;

  private readonly h: number;
  private readonly center: THREE.Vector3;
  private readonly brushCarve: THREE.InstancedMesh;
  private readonly brushProtected: THREE.InstancedMesh;
  private readonly resizeObserver: ResizeObserver;
  private targetGoal: THREE.Vector3 | null = null;
  private readonly reducedMotion: boolean;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  constructor(
    private readonly host: HTMLElement,
    private readonly state: CarveState,
    palette: PaletteId,
  ) {
    const stage = state.stage;
    const g = state.grid;
    this.h = stage.voxelSize;
    const size = new THREE.Vector3(g.nx, g.ny, g.nz).multiplyScalar(this.h);
    this.center = size.clone().multiplyScalar(0.5);
    const extent = size.length();

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.setAttribute('aria-label', '3Dビュー: 左ドラッグで削る、右ドラッグで回転');
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x15171c);
    this.camera = new THREE.PerspectiveCamera(38, 1, extent / 200, extent * 60);

    // lights
    this.scene.add(new THREE.HemisphereLight(0xe8eef7, 0x30343c, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(-0.6, 1.4, 1.0).multiplyScalar(extent * 2).add(this.center);
    sun.target.position.copy(this.center);
    this.scene.add(sun, sun.target);

    // domain: voxels, obstacles, brush preview (grid units)
    this.domain.scale.setScalar(this.h);
    this.domain.name = 'domain';
    this.voxels = new VoxelMesh(g, state.solid, state.keep, palette);
    this.domain.add(this.voxels.group);
    if (state.block.some((b) => b === 1)) this.domain.add(buildBlockMesh(g, state.block));
    const boxGeo = new THREE.BoxGeometry(1.04, 1.04, 1.04);
    this.brushCarve = makeBrushMesh(boxGeo, 0xffffff, 0.32);
    this.brushProtected = makeBrushMesh(boxGeo, 0xff5a5a, 0.4);
    this.domain.add(this.brushCarve, this.brushProtected);
    this.scene.add(this.domain);

    this.scene.add(buildJigs(stage));
    this.buildBench(size);
    this.scene.add(this.env);

    // camera: orbit around the domain centre, 45° above, turned towards the supports
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = extent * 0.15;
    this.controls.maxDistance = extent * 8;
    this.controls.target.copy(this.center);
    this.resetCamera(extent);

    this.pickFilter = (e) => state.solid[e] === 1 || state.block[e] === 1;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  // --- ViewPort -------------------------------------------------------------

  solidChanged(cells: readonly number[]): void {
    this.voxels.markDirty(cells);
  }

  setUtilization(u: Float32Array | null): void {
    this.voxels.setUtilization(u);
  }

  setResult(result: ResultMsg): void {
    this.lastResult = result;
  }

  elementsRemoved(cells: readonly number[], cause: RemovalCause): void {
    // Debris hook: T-310 spawns falling chips here. Intentionally empty in the shell.
    void cells;
    void cause;
  }

  showBrush(sel: BrushSelection | null): void {
    this.fillBrush(this.brushCarve, sel?.carve ?? []);
    this.fillBrush(this.brushProtected, sel?.protected ?? []);
  }

  // --- picking & camera -----------------------------------------------------

  /** Voxel under a client-space point, or null. */
  pick(clientX: number, clientY: number): VoxelHit | null {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;
    const h = this.h;
    return raycastGrid(this.state.grid, [o.x / h, o.y / h, o.z / h], [d.x, d.y, d.z], this.pickFilter);
  }

  /** Smoothly move the orbit target to the centre of the hit voxel face (double-click). */
  retarget(hit: VoxelHit): void {
    const p = hit.point;
    this.targetGoal = new THREE.Vector3(p[0], p[1], p[2]).multiplyScalar(this.h);
  }

  /** World position (m) of a cell centre. */
  cellCenter(element: number): Vec3 {
    const [x, y, z] = cellCoords(this.state.grid, element);
    return [(x + 0.5) * this.h, (y + 0.5) * this.h, (z + 0.5) * this.h];
  }

  setPalette(id: PaletteId): void {
    this.voxels.setPalette(id);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.voxels.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
    releaseRenderer(this.renderer);
  }

  // --- internals ------------------------------------------------------------

  private resetCamera(extent: number): void {
    const patches = supportPatches(this.state.stage);
    const sx = patches.length ? patches.reduce((s, p) => s + p.normal[0], 0) / patches.length : -1;
    const azimuth = 0.45 * Math.max(-1, Math.min(1, sx));
    const radius = extent / 2 + Math.min(0.2, 0.6 * extent) * 0.5;
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    const dir = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(ELEVATION),
      Math.sin(ELEVATION),
      Math.cos(azimuth) * Math.cos(ELEVATION),
    );
    this.camera.position.copy(this.center).addScaledVector(dir, dist);
    this.camera.lookAt(this.center);
  }

  private buildBench(size: THREE.Vector3): void {
    const span = Math.max(1, Math.ceil(Math.max(size.x, size.z) * 3 * 10) / 10);
    const grid = new THREE.GridHelper(span, Math.round(span * 20), 0x3a3f49, 0x262a31);
    grid.position.set(this.center.x, -BENCH_DROP, this.center.z);
    this.env.add(grid);
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(span, span),
      new THREE.MeshLambertMaterial({ color: 0x1c1f25 }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(this.center.x, -BENCH_DROP - 0.001, this.center.z);
    this.env.add(plate);
    this.env.name = 'env';
  }

  private fillBrush(mesh: THREE.InstancedMesh, cells: readonly number[]): void {
    const m = new THREE.Matrix4();
    const n = Math.min(cells.length, MAX_BRUSH_CELLS);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = cellCoords(this.state.grid, cells[i]!);
      m.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
      mesh.setMatrixAt(i, m);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(timeMs: number): void {
    timeUniform.value = this.reducedMotion ? Math.PI / 14 : timeMs / 1000;
    if (this.targetGoal) {
      const t = this.controls.target;
      const delta = this.targetGoal.clone().sub(t).multiplyScalar(0.2);
      t.add(delta);
      this.camera.position.add(delta);
      if (delta.lengthSq() < 1e-12) this.targetGoal = null;
    }
    this.controls.update();
    this.onFrame?.();
    this.voxels.update();
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * Free the renderer *and* its WebGL context before dropping the canvas. Browsers cap live
 * contexts (~16); without `forceContextLoss` every stage switch (T-304) would leak one until
 * GC, and old canvases eventually trigger "too many active WebGL contexts".
 */
export function releaseRenderer(
  renderer: Pick<THREE.WebGLRenderer, 'dispose' | 'forceContextLoss'> & { domElement: { remove(): void } },
): void {
  renderer.dispose(); // first: removes the renderer's context-lost listeners
  renderer.forceContextLoss();
  renderer.domElement.remove();
}

function makeBrushMesh(geo: THREE.BoxGeometry, color: number, opacity: number): THREE.InstancedMesh {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX_BRUSH_CELLS);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.name = 'brush';
  return mesh;
}
