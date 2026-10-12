// 載荷テスト (Space / toolbar): plays the load test on the latest solver result — the load
// jigs descend, the part bends with an auto-scaled exaggeration, over-stressed elements crack,
// flash and break off in order of utilisation, pieces cut off from the supports fall, then
// everything springs back (design doc 操作・演出・変形表示). Purely visual: the game state is
// never touched; while playing, the normal voxel view is hidden and `DeformView` shows a
// private copy. Any change of the solid set cancels the show (StageScene.solidChanged).

import type { ResultMsg, Stage } from '@stress-carve/protocol';
import { supportedCells } from '@stress-carve/protocol';
import * as THREE from 'three';
import type { Grid } from '../../game/grid.ts';
import {
  colorAt,
  envelope,
  KEEP_TINT,
  linearPalette,
  NEUTRAL,
  PALETTES,
  srgbToLinear,
  type PaintInput,
  type PaletteId,
} from '../colormap.ts';
import { detachedComponents, floatingMask } from './collapse.ts';
import { Debris, VISUAL_GRAVITY } from './debris.ts';
import {
  autoScale,
  breakOrder,
  cellDisplacement,
  crackField,
  criticalCase,
  maxActiveDisplacement,
} from './deform.ts';
import { DeformView } from './deformView.ts';
import { timelineAt, type LoadTestPhase, type TimelineFrame, type TimelinePlan } from './timeline.ts';

/** At most this many elements break off visually (the rest only crack). */
export const MAX_BREAKS = 400;
/** URL of T-307's tileable crack texture; the procedural pattern is used until it loads. */
export const CRACK_TILE_URL = 'assets/crack_tile.png';

export interface LoadTestStatus {
  /** idle; waiting for a current result; playing the animation; holding the static frame */
  state: 'idle' | 'waiting' | 'playing' | 'holding';
  phase: LoadTestPhase | null;
  /** exaggeration factor (0 = nothing to show) */
  scale: number;
  /** judged elements above the allowable stress */
  overstressed: number;
  /** elements broken off so far */
  broken: number;
  /** pieces that fell off after breaking */
  collapsed: number;
  /** animated load case name when the stage has several */
  caseName: string | null;
  /** shows started so far in this session (tutorial signal, T-305) */
  runs: number;
}

export const IDLE_LOAD_TEST: LoadTestStatus = {
  state: 'idle',
  phase: null,
  scale: 0,
  overstressed: 0,
  broken: 0,
  collapsed: 0,
  caseName: null,
  runs: 0,
};

export interface LoadTestOptions {
  state: { grid: Grid; stage: Stage; solid: Uint8Array; keep: Uint8Array };
  /** grid-unit parent group (scaled by the voxel size) */
  domain: THREE.Object3D;
  /** the normal voxel view, hidden while playing */
  voxels: THREE.Object3D;
  /** placeholder jig group: its children named 'load' are the default `loadJigs` */
  jigs: THREE.Object3D | null;
  palette: PaletteId;
  reducedMotion: boolean;
  /** bench height in grid units (debris floor) */
  floorY: number;
  /** load T-307's crack texture (browser only) */
  loadCrackTexture?: boolean;
}

interface JigTrack {
  obj: THREE.Object3D;
  /** `position` at rest (parent space), restored on stop */
  rest: THREE.Vector3;
  /** origin at rest in world space (m) */
  restWorld: THREE.Vector3;
  /** unit force direction (world) */
  dir: THREE.Vector3;
  /** displacement (m) of the loaded cell in the animated case */
  u: THREE.Vector3;
  /** optional ram stroke animation (T-310 glTF jigs) */
  setStroke: ((t: number) => void) | null;
}

interface Show {
  plan: TimelinePlan;
  t0: number | null;
  last: number;
  scale: number;
  order: number[];
  broken: number;
  collapsed: number;
  floatingBefore: Uint8Array;
  utilization: Float32Array;
  nodal: Float32Array;
  centre: [number, number, number];
  jigs: JigTrack[];
  frame: TimelineFrame | null;
}

export interface FrameStats {
  frames: number;
  meanFps: number;
  p95FrameMs: number;
  worstFrameMs: number;
}

export class LoadTest {
  /** status sink for the HUD (called on changes only) */
  onStatus: ((s: LoadTestStatus) => void) | null = null;
  /** section mask (T-303): shown cells = solid & mask */
  sectionMask: (() => Uint8Array | null) | null = null;
  /** objects hidden while the test plays (the voxel view; T-303 adds its X-ray ghost) */
  readonly hideWhilePlaying: THREE.Object3D[];
  /**
   * Load jig roots, read at each start (T-310 swaps in the glTF jigs): origin = contact-patch
   * centre, local −Y = F̂, rest pose touching the part. Only `position` is driven while
   * playing (restored exactly on stop); `userData.setStroke(t)` is called when present.
   */
  loadJigs: () => THREE.Object3D[];
  readonly view: DeformView;
  readonly debris: Debris;

  private result: ResultMsg | null = null;
  private show: Show | null = null;
  private waiting = false;
  private startPending = false;
  private palette: PaletteId;
  private status: LoadTestStatus = IDLE_LOAD_TEST;
  private readonly supported: Uint8Array;
  private readonly h: number;
  private readonly hidden = new Map<THREE.Object3D, boolean>();
  private frameTimes: number[] = [];
  private runs = 0;
  private crackTexture: THREE.Texture | null = null;
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly opts: LoadTestOptions) {
    const { grid, stage } = opts.state;
    this.h = stage.voxelSize;
    this.palette = opts.palette;
    this.supported = supportedCells(stage);
    this.hideWhilePlaying = [opts.voxels];
    this.loadJigs = () => opts.jigs?.children.filter((o) => o.name === 'load') ?? [];
    this.view = new DeformView(grid, this.h);
    this.view.group.visible = false;
    this.debris = new Debris(VISUAL_GRAVITY / this.h, opts.floorY, MAX_BREAKS, 0x5eed);
    opts.domain.add(this.view.group, this.debris.group);
    if (opts.loadCrackTexture) this.loadCrackTexture();
  }

  get active(): boolean {
    return this.show !== null;
  }

  get current(): LoadTestStatus {
    return this.status;
  }

  /** Latest current solver result (StageScene.setResult). */
  setResult(result: ResultMsg): void {
    this.result = result;
    if (this.waiting) this.startPending = true; // next frame: after any debris removal
  }

  setPalette(id: PaletteId): void {
    this.palette = id;
  }

  /**
   * Space / toolbar: stop a running test, or start one. With `current: false` (a newer
   * state than the latest result exists) it waits for the next result and then starts.
   */
  toggle(opts: { current?: boolean } = {}): void {
    if (this.show || this.waiting) {
      this.stop();
      return;
    }
    if (opts.current === false || !this.result) {
      this.waiting = true;
      this.emit({ ...IDLE_LOAD_TEST, state: 'waiting' });
      return;
    }
    this.start();
  }

  /** Start on the latest result; false when there is none. */
  start(): boolean {
    const r = this.result;
    this.stop();
    if (!r || r.cases.length === 0) return false;
    const { grid, solid, keep } = this.opts.state;
    const ci = criticalCase(r.cases);
    const lc = r.cases[ci]!;
    const utilization = envelope(r.cases.map((c) => c.utilization)) ?? lc.utilization;

    const mask = this.sectionMask?.() ?? null;
    const flags = new Uint8Array(grid.n);
    for (let e = 0; e < grid.n; e++) flags[e] = solid[e] && (!mask || mask[e]) ? 1 : 0;

    // auto scale from the whole active part (not just the visible section)
    const scale = autoScale(maxActiveDisplacement(grid, solid, lc.displacement), grid, this.h);
    const allBreaks = breakOrder(utilization, flags, keep);
    const order = allBreaks.slice(0, MAX_BREAKS);
    const paint: PaintInput = {
      palette: linearPalette(PALETTES[this.palette]),
      neutral: srgbToLinear(NEUTRAL),
      keepTint: srgbToLinear(KEEP_TINT),
      utilization,
      keep,
    };
    this.view.build({ flags, nodal: lc.displacement, scale, paint, crack: crackField(utilization, flags, keep) });
    this.uniforms.uCrackMap.value = this.crackTexture;
    this.uniforms.uCrackMapOn.value = this.crackTexture ? 1 : 0;

    let cx = 0;
    let cy = 0;
    let cz = 0;
    let count = 0;
    for (let e = 0; e < grid.n; e++) {
      if (!flags[e]) continue;
      cx += e % grid.nx;
      cy += Math.floor(e / grid.nx) % grid.ny;
      cz += Math.floor(e / (grid.nx * grid.ny));
      count++;
    }
    const centre: [number, number, number] = count
      ? [cx / count + 0.5, cy / count + 0.5, cz / count + 0.5]
      : [grid.nx / 2, grid.ny / 2, grid.nz / 2];

    this.show = {
      plan: { breaks: order.length, reducedMotion: this.opts.reducedMotion },
      t0: null,
      last: 0,
      scale,
      order,
      broken: 0,
      collapsed: 0,
      floatingBefore: floatingMask(grid, flags, this.supported),
      utilization,
      nodal: lc.displacement,
      centre,
      jigs: this.trackJigs(lc.displacement),
      frame: null,
    };
    for (const o of this.hideWhilePlaying) {
      this.hidden.set(o, o.visible);
      o.visible = false;
    }
    this.view.group.visible = true;
    this.frameTimes = [];
    this.waiting = false;
    this.startPending = false;
    this.runs++;
    this.emit({
      state: this.opts.reducedMotion ? 'holding' : 'playing',
      phase: null,
      scale,
      overstressed: allBreaks.length,
      broken: 0,
      collapsed: 0,
      caseName: r.cases.length > 1 ? lc.name : null,
      runs: this.runs,
    });
    this.applyFrame(timelineAt(this.show.plan, 0));
    return true;
  }

  /** End the test now and restore the normal view (no-op when idle). */
  stop(): void {
    this.waiting = false;
    this.startPending = false;
    if (this.show) {
      for (const j of this.show.jigs) {
        j.obj.position.copy(j.rest);
        j.setStroke?.(1);
      }
      this.show = null;
    }
    for (const [o, visible] of this.hidden) o.visible = visible;
    this.hidden.clear();
    this.view.clear();
    this.view.group.visible = false;
    this.debris.clear();
    const u = this.uniforms;
    u.uDeform.value = 0;
    u.uDeformT.value = 0;
    u.uCrack.value = 0;
    u.uFlash.value = 0;
    this.emit(IDLE_LOAD_TEST);
  }

  /** The solid set changed under the show: abort it (a pending start keeps waiting). */
  cancel(): void {
    if (!this.show) return;
    const waiting = this.waiting;
    this.stop();
    this.waiting = waiting;
  }

  /** Advance the show; call once per animation frame with the rAF timestamp (ms). */
  update(nowMs: number): void {
    if (this.startPending) {
      this.startPending = false;
      this.start();
    }
    const s = this.show;
    if (!s) return;
    if (s.t0 === null) {
      s.t0 = nowMs;
      s.last = nowMs;
    }
    const dt = Math.max(0, (nowMs - s.last) / 1000);
    if (nowMs > s.last) this.frameTimes.push(nowMs - s.last);
    s.last = nowMs;
    const frame = timelineAt(s.plan, (nowMs - s.t0) / 1000);
    this.applyFrame(frame);
    if (!this.show) return;
    this.debris.update(dt, frame.debris);
    if (frame.done) this.stop();
  }

  /** Frame-time statistics of the current/last show (fps measurement, dev console). */
  frameStats(): FrameStats {
    const t = [...this.frameTimes].sort((a, b) => a - b);
    if (t.length === 0) return { frames: 0, meanFps: 0, p95FrameMs: 0, worstFrameMs: 0 };
    const mean = t.reduce((a, b) => a + b, 0) / t.length;
    return {
      frames: t.length,
      meanFps: 1000 / mean,
      p95FrameMs: t[Math.min(t.length - 1, Math.floor(t.length * 0.95))]!,
      worstFrameMs: t[t.length - 1]!,
    };
  }

  dispose(): void {
    this.stop();
    this.opts.domain.remove(this.view.group, this.debris.group);
    this.view.dispose();
    this.debris.dispose();
    this.crackTexture?.dispose();
  }

  // --- internals ------------------------------------------------------------

  private get uniforms() {
    return this.view.uniforms;
  }

  private applyFrame(f: TimelineFrame): void {
    const s = this.show;
    if (!s) return;
    const prevPhase = s.frame?.phase ?? null;
    s.frame = f;
    const factor = s.scale * f.deform;
    const u = this.uniforms;
    u.uDeform.value = factor;
    u.uDeformT.value = f.deform;
    u.uCrack.value = f.crack;
    u.uFlash.value = f.flash;

    if (f.broken > s.broken) this.breakUpTo(f.broken, factor);

    const lift = Math.max(3, 0.15 * Math.max(this.opts.state.grid.nx, this.opts.state.grid.ny, this.opts.state.grid.nz));
    for (const j of s.jigs) {
      this.tmp
        .copy(j.restWorld)
        .addScaledVector(j.dir, -lift * this.h * (1 - f.jig))
        .addScaledVector(j.u, factor);
      if (j.obj.parent) j.obj.parent.worldToLocal(this.tmp);
      j.obj.position.copy(this.tmp);
      j.setStroke?.(f.jig);
    }
    if (prevPhase !== f.phase) this.emit({ ...this.status, phase: f.phase });
  }

  private breakUpTo(target: number, factor: number): void {
    const s = this.show!;
    const { grid } = this.opts.state;
    const batch = s.order.slice(s.broken, target);
    s.broken = target;
    const animate = !this.opts.reducedMotion;
    const palette = linearPalette(PALETTES[this.palette]);
    const rgb = [0, 0, 0];
    if (animate) {
      for (const e of batch) {
        const d = cellDisplacement(grid, e, s.nodal);
        const x = e % grid.nx;
        const y = Math.floor(e / grid.nx) % grid.ny;
        const z = Math.floor(e / (grid.nx * grid.ny));
        const p = [x + 0.5 + (factor * d[0]) / this.h, y + 0.5 + (factor * d[1]) / this.h, z + 0.5 + (factor * d[2]) / this.h];
        colorAt(palette, s.utilization[e] ?? 0, rgb);
        this.debris.addChip(p, s.centre, rgb);
      }
    }
    this.view.remove(batch);

    // whatever lost its path to a support falls off as a rigid piece
    const pieces = detachedComponents(grid, this.view.shown, this.supported, s.floatingBefore);
    for (const cells of pieces) {
      if (animate) {
        const mesh = this.view.pieceMesh(cells, factor);
        if (mesh) {
          let cx = 0;
          let cy = 0;
          let cz = 0;
          for (const e of cells) {
            cx += (e % grid.nx) + 0.5;
            cy += (Math.floor(e / grid.nx) % grid.ny) + 0.5;
            cz += Math.floor(e / (grid.nx * grid.ny)) + 0.5;
          }
          const n = cells.length;
          this.debris.addPiece(mesh, [cx / n, cy / n, cz / n], s.centre);
        }
      }
      this.view.remove(cells);
    }
    s.collapsed += pieces.length;
    this.emit({ ...this.status, broken: s.broken, collapsed: s.collapsed });
  }

  private trackJigs(nodal: Float32Array): JigTrack[] {
    const out: JigTrack[] = [];
    const { grid } = this.opts.state;
    const h = this.h;
    for (const obj of this.loadJigs()) {
      obj.updateWorldMatrix(true, false);
      const restWorld = obj.getWorldPosition(new THREE.Vector3());
      const q = obj.getWorldQuaternion(new THREE.Quaternion());
      const dir = new THREE.Vector3(0, -1, 0).applyQuaternion(q).normalize();
      // the loaded cell lies half a voxel past the contact point along F̂
      const c = restWorld.clone().addScaledVector(dir, h / 2).divideScalar(h);
      const x = Math.min(grid.nx - 1, Math.max(0, Math.floor(c.x)));
      const y = Math.min(grid.ny - 1, Math.max(0, Math.floor(c.y)));
      const z = Math.min(grid.nz - 1, Math.max(0, Math.floor(c.z)));
      const d = cellDisplacement(grid, x + grid.nx * (y + grid.ny * z), nodal);
      const stroke: unknown = obj.userData['setStroke'];
      out.push({
        obj,
        rest: obj.position.clone(),
        restWorld,
        dir,
        u: new THREE.Vector3(d[0], d[1], d[2]),
        setStroke: typeof stroke === 'function' ? (t: number) => (stroke as (t: number) => void)(t) : null,
      });
    }
    return out;
  }

  private emit(next: LoadTestStatus): void {
    const prev = this.status;
    const s = { ...next, runs: this.runs };
    this.status = s;
    if (
      prev.state !== s.state ||
      prev.phase !== s.phase ||
      prev.scale !== s.scale ||
      prev.overstressed !== s.overstressed ||
      prev.broken !== s.broken ||
      prev.collapsed !== s.collapsed ||
      prev.caseName !== s.caseName ||
      prev.runs !== s.runs
    ) {
      this.onStatus?.(s);
    }
  }

  private loadCrackTexture(): void {
    const url = `${import.meta.env.BASE_URL ?? '/'}${CRACK_TILE_URL}`;
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        this.crackTexture = tex;
        if (this.show) {
          this.uniforms.uCrackMap.value = tex;
          this.uniforms.uCrackMapOn.value = 1;
        }
      },
      undefined,
      () => {
        // not exported yet (T-307) or offline: keep the procedural cracks
      },
    );
  }
}
