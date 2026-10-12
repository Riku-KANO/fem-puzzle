// State of the result screen (T-301): judges the current design on submit, fires the clear
// record once, shows the benchmark overlay, spins the camera once around a cleared design
// (design doc 演出: クリア時はカメラが一周して完成形を見せ…) and keeps the left button from
// carving while the screen is open (orbit / zoom still work).

import { decodeBitmask, elementCount, type Stage } from '@stress-carve/protocol';
import { makeGrid } from '../../game/grid.ts';
import { submit, type StageClear, type Submission, type SubmitGateInput, type SubmitSource } from '../../game/judge/index.ts';
import { BenchmarkOverlay, type OverlayHost, type OverlayMode } from './benchmarkOverlay.ts';

/** What the result screen needs from the 3D view (structurally `StageScene`). */
export interface ResultView extends OverlayHost {
  readonly controls: { autoRotate: boolean; autoRotateSpeed: number; getAzimuthalAngle(): number };
  readonly canvas: HTMLElement;
}

/** What it needs from the running game (structurally `GameSession`). */
export interface ResultGame {
  readonly controller: SubmitSource & { hover?(hit: null): void };
  readonly scene: ResultView;
}

/** OrbitControls turns 2π/3600·speed per frame: ≈ one turn in 5 s at 60 fps. */
const SPIN_SPEED = 12;
/** safety stop for the spin (e.g. a background tab with no frames) */
const SPIN_MAX_MS = 15_000;

export class ResultSession {
  /** the open submission; null = screen closed */
  submission = $state.raw<Submission | null>(null);
  overlay = $state<OverlayMode>('off');
  /** the camera is turning around the cleared design */
  spinning = $state(false);
  /** called once per passed submission (T-304 stores records) */
  onClear: ((clear: StageClear) => void) | null = null;

  private bench: BenchmarkOverlay | null = null;
  private cleanup: (() => void)[] = [];
  private overlayTouched = false;

  /** The stage has a benchmark to compare with (only meaningful while open). */
  get hasBenchmark(): boolean {
    return this.bench !== null;
  }

  /** Judge the current design and open the screen; null when the submit gate is closed. */
  open(game: ResultGame, gate: SubmitGateInput): Submission | null {
    const s = submit(game.controller, gate);
    if (!s) return null;
    this.close();
    this.submission = s;
    this.overlayTouched = false;
    this.bench = buildOverlay(game.scene, game.controller.state.stage);
    this.lockCarving(game);
    if (s.clear) this.onClear?.(s.clear);
    const spun = s.judgement.passed && this.spin(game.scene, () => this.afterSpin());
    if (!spun && s.judgement.passed) this.afterSpin();
    return s;
  }

  setOverlay(mode: OverlayMode): void {
    this.overlayTouched = true;
    this.applyOverlay(mode);
  }

  close(): void {
    for (const f of this.cleanup.splice(0).reverse()) f();
    this.bench?.dispose();
    this.bench = null;
    this.overlay = 'off';
    this.spinning = false;
    this.submission = null;
  }

  dispose(): void {
    this.close();
    this.onClear = null;
  }

  // --- internals ------------------------------------------------------------

  private applyOverlay(mode: OverlayMode): void {
    const m = this.bench ? mode : 'off';
    this.bench?.setMode(m);
    this.overlay = m;
  }

  /** After the camera turn (or right away without motion): show the comparison on a clear. */
  private afterSpin(): void {
    if (!this.overlayTouched && this.bench) this.applyOverlay('overlay');
  }

  private lockCarving(game: ResultGame): void {
    const canvas = game.scene.canvas;
    game.controller.hover?.(null);
    const target = canvas.parentElement ?? canvas;
    const block = (ev: Event) => {
      const p = ev as PointerEvent;
      if (p.target !== canvas || p.pointerType === 'touch') return;
      // left press = carve; hover = brush preview. Right drag (orbit) and wheel pass through.
      if ((p.type === 'pointerdown' && p.button === 0) || (p.type === 'pointermove' && p.buttons === 0)) {
        p.stopPropagation();
      }
    };
    target.addEventListener('pointerdown', block, true);
    target.addEventListener('pointermove', block, true);
    this.cleanup.push(() => {
      target.removeEventListener('pointerdown', block, true);
      target.removeEventListener('pointermove', block, true);
    });
  }

  /** One turn around the target; false when motion is reduced or frames are unavailable. */
  private spin(view: ResultView, done: () => void): boolean {
    if (typeof requestAnimationFrame !== 'function' || prefersReducedMotion()) return false;
    const c = view.controls;
    const before = { on: c.autoRotate, speed: c.autoRotateSpeed };
    c.autoRotate = true;
    c.autoRotateSpeed = SPIN_SPEED;
    this.spinning = true;
    let last = c.getAzimuthalAngle();
    let turned = 0;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = (finished: boolean) => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      view.canvas.removeEventListener('pointerdown', onUser);
      c.autoRotate = before.on;
      c.autoRotateSpeed = before.speed;
      this.spinning = false;
      if (finished) done();
    };
    const onUser = () => stop(true); // the player takes the camera
    const tick = () => {
      const a = c.getAzimuthalAngle();
      let d = a - last;
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      turned += Math.abs(d);
      last = a;
      if (turned >= 2 * Math.PI - 0.01) stop(true);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    timer = setTimeout(() => stop(true), SPIN_MAX_MS);
    view.canvas.addEventListener('pointerdown', onUser);
    this.cleanup.push(() => stop(false));
    return true;
  }
}

function buildOverlay(view: OverlayHost, stage: Stage): BenchmarkOverlay | null {
  const b = stage.benchmark;
  if (!b) return null;
  try {
    const flags = decodeBitmask(b.solid, elementCount(stage.grid));
    return new BenchmarkOverlay(view, makeGrid(stage.grid), flags);
  } catch {
    return null; // undecodable benchmark: the comparison text still uses `benchmark.volume`
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}
