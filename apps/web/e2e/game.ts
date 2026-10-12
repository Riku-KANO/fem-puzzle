// Page helpers shared by the e2e specs: open a stage, read the test hook, find a carvable
// spot on screen (with the app's own picking), wait for solver results.

import { expect, type Page, type TestInfo } from '@playwright/test';
import './hook.ts';

export type BackendId = 'mock' | 'wasm';

/** The 3D view canvas (StageScene sets this aria-label). */
export const VIEW_CANVAS = 'canvas[aria-label^="3Dビュー"]';
/** Background colour of the scene (StageScene: 0x15171c). */
const BACKGROUND: [number, number, number] = [0x15, 0x17, 0x1c];

/**
 * Deep link to a stage. `#/stage/<id>` is T-304's stable route; `?stage=<id>` keeps builds
 * without hash routing on the same stage (T-304 rewrites it to the hash and keeps other
 * params). `?backend=` selects the solver backend (T-205).
 */
export function stageUrl(stageId: string, backend: BackendId): string {
  return `/?backend=${backend}&stage=${stageId}#/stage/${stageId}`;
}

export interface Snapshot {
  stageId: string;
  backend: string | null;
  /** seq of the latest result (-1 = none) */
  seq: number;
  /** seq of the newest request sent to the worker */
  latestSeq: number;
  converged: boolean;
  volume: number;
  solidCount: number;
  canUndo: boolean;
  canRedo: boolean;
}

export async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const s = window.__stressCarve;
    if (!s) throw new Error('window.__stressCarve missing — is this an e2e (--mode e2e) build?');
    const st = s.controller.state;
    const r = s.controller.latestResult;
    return {
      stageId: st.stage.id,
      backend: s.solver.ready?.backend ?? null,
      seq: r?.seq ?? -1,
      latestSeq: s.solver.latestSeq,
      converged: r?.converged ?? false,
      volume: st.volumeFraction,
      solidCount: st.solidCount,
      canUndo: st.canUndo,
      canRedo: st.canRedo,
    };
  });
}

/** Collects uncaught page errors and console errors; assert `errors` is empty at the end. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

/** Open a stage and wait until the solver has answered the initial `init`. */
export async function openStage(page: Page, stageId: string, backend: BackendId): Promise<Snapshot> {
  await page.goto(stageUrl(stageId, backend));
  await expect(page.locator(VIEW_CANVAS)).toBeVisible();
  await page.waitForFunction(() => {
    const s = window.__stressCarve;
    const r = s?.controller.latestResult;
    return !!s && !!r && r.seq === s.solver.latestSeq;
  });
  const snap = await snapshot(page);
  expect(snap.stageId).toBe(stageId);
  return snap;
}

/** Wait for a `result` newer than `afterSeq` that answers the newest request. */
export async function waitForResultAfter(page: Page, afterSeq: number): Promise<Snapshot> {
  await page.waitForFunction((after) => {
    const s = window.__stressCarve;
    const r = s?.controller.latestResult;
    return !!s && !!r && r.seq > after && r.seq === s.solver.latestSeq;
  }, afterSeq);
  return snapshot(page);
}

export interface CanvasStats {
  triangles: number;
  /** fraction of canvas pixels that differ clearly from the scene background */
  drawnFraction: number;
}

/**
 * Read back the WebGL canvas right after Three.js rendered a frame (our rAF callback runs
 * after the render loop's, before compositing, so the drawing buffer is still intact).
 */
export async function canvasStats(page: Page): Promise<CanvasStats> {
  return page.evaluate(
    (bg) =>
      new Promise<CanvasStats>((resolve, reject) => {
        requestAnimationFrame(() => {
          const s = window.__stressCarve;
          if (!s) return reject(new Error('window.__stressCarve missing'));
          const src = s.scene.canvas;
          const w = 160;
          const h = Math.max(1, Math.round((w * src.height) / src.width));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d');
          if (!ctx) return reject(new Error('no 2d context'));
          ctx.drawImage(src, 0, 0, w, h);
          const px = ctx.getImageData(0, 0, w, h).data;
          let drawn = 0;
          for (let i = 0; i < px.length; i += 4) {
            const d = Math.abs(px[i]! - bg[0]) + Math.abs(px[i + 1]! - bg[1]) + Math.abs(px[i + 2]! - bg[2]);
            if (d > 40) drawn++;
          }
          resolve({ triangles: s.scene.renderer.info.render.triangles, drawnFraction: drawn / (w * h) });
        });
      }),
    BACKGROUND,
  );
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface CarveRun {
  /** a carvable spot as close to the canvas centre as possible */
  from: ScreenPoint;
  /** end of a horizontal run of carvable spots starting at `from` */
  to: ScreenPoint;
}

/**
 * Find on-screen spots over carvable voxels using the app's own picking. A spot is carvable
 * when the canvas is the top element there (no HUD panel) and the ray hits a solid,
 * non-protected, non-obstacle cell. `from` must also be stable: its ±2 px neighbourhood
 * hits the same cell (robust to sub-pixel rounding of mouse coordinates).
 * Returns the stable spot nearest the canvas centre that starts a horizontal run of
 * carvable spots at least `minRun` px long (or, if there is none, the nearest stable spot
 * with `to === from`).
 */
export async function findCarveRun(page: Page, minRun = 48): Promise<CarveRun> {
  const run = await page.evaluate((minPx) => {
    const s = window.__stressCarve;
    if (!s) throw new Error('window.__stressCarve missing');
    const canvas = s.scene.canvas;
    const { keep, block } = s.controller.state;
    const rect = canvas.getBoundingClientRect();
    const step = 5;
    const carvableAt = (x: number, y: number): number | null => {
      if (document.elementFromPoint(x, y) !== canvas) return null;
      const hit = s.scene.pick(x, y);
      if (!hit || keep[hit.element] === 1 || block[hit.element] === 1) return null;
      return hit.element;
    };
    const stable = (x: number, y: number, element: number): boolean =>
      [[-2, 0], [2, 0], [0, -2], [0, 2]].every(([dx, dy]) => s.scene.pick(x + dx!, y + dy!)?.element === element);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    type Run = { x0: number; x1: number; y: number; d: number };
    let withRun: Run | null = null;
    let single: Run | null = null;
    for (let y = Math.ceil(rect.top) + step; y < rect.bottom - step; y += step) {
      const xs: number[] = [];
      const cells: (number | null)[] = [];
      for (let x = Math.ceil(rect.left) + step; x < rect.right - step; x += step) {
        xs.push(x);
        cells.push(carvableAt(x, y));
      }
      // runEnd[i]: x of the last sample in the carvable run that contains sample i
      const runEnd: number[] = new Array<number>(xs.length).fill(-1);
      for (let i = xs.length - 1, end = -1; i >= 0; i--) {
        end = cells[i] === null ? -1 : end < 0 ? xs[i]! : end;
        runEnd[i] = end;
      }
      for (let i = 0; i < xs.length; i++) {
        const cell = cells[i];
        const x = xs[i]!;
        if (cell === null || cell === undefined) continue;
        const d = Math.hypot(x - cx, y - cy);
        const long = runEnd[i]! - x >= minPx;
        if (long ? withRun && withRun.d <= d : single && single.d <= d) continue;
        if (!stable(x, y, cell)) continue;
        if (long) withRun = { x0: x, x1: x + minPx, y, d };
        else single = { x0: x, x1: x, y, d };
      }
    }
    return withRun ?? single;
  }, minRun);
  if (!run) throw new Error('no carvable voxel visible on the canvas');
  return { from: { x: run.x0, y: run.y }, to: { x: run.x1, y: run.y } };
}

/** Format like the HUD volume meter (`percent(v, 1)` in src/ui/format.ts). */
export function percent1(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** The volume read-out in the stage panel (体積率 …%). */
export function volumeText(page: Page) {
  return page.getByRole('region', { name: 'ステージ情報' }).locator('strong').first();
}

export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}
