// The end-to-end carve loop, shared by the mock and wasm specs:
// load a stage → canvas renders → carve with real mouse events → a newer `result` arrives →
// volume drops → undo (right click) restores it → redo / undo by keyboard.

import { expect, type Page, type TestInfo } from '@playwright/test';
import {
  canvasStats,
  findCarveRun,
  openStage,
  percent1,
  selectBrush,
  shot,
  skipTutorial,
  trackErrors,
  volumeText,
  waitForResultAfter,
  type BackendId,
} from './game.ts';

export const STAGE_ID = 'w1-01';

/** Returns the page-error collector (still empty here) so a caller can continue the flow. */
export async function carveUndoLoop(page: Page, testInfo: TestInfo, backend: BackendId): Promise<string[]> {
  const errors = trackErrors(page);

  // load + first solve; w1-01 opens with the tutorial on a first visit
  const s0 = await openStage(page, STAGE_ID, backend);
  await skipTutorial(page);
  expect(s0.backend).toBe(backend);
  expect(s0.converged).toBe(true);
  expect(s0.volume).toBe(1);
  await expect(volumeText(page)).toHaveText(percent1(s0.volume));

  // the canvas really draws the stage (not just a cleared background)
  const stats = await canvasStats(page);
  expect(stats.triangles, 'triangles in the last rendered frame').toBeGreaterThan(0);
  expect(stats.drawnFraction, 'share of canvas pixels that are not background').toBeGreaterThan(0.02);
  await shot(page, testInfo, '1-loaded');

  // brush 3×3 via the real keyboard shortcut
  await selectBrush(page, 3);

  // carve: hover (brush preview) → left click, all real mouse events on the canvas
  const { from: p } = await findCarveRun(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  const s1 = await waitForResultAfter(page, s0.seq);
  const carved = s0.solidCount - s1.solidCount;
  expect(carved, 'voxels removed by one 3×3 click').toBeGreaterThanOrEqual(1);
  expect(carved).toBeLessThanOrEqual(9);
  expect(s1.volume).toBeLessThan(s0.volume);
  expect(s1.converged).toBe(true);
  expect(s1.canUndo).toBe(true);
  await expect(volumeText(page)).toHaveText(percent1(s1.volume));
  await expect(page.getByText('解析完了', { exact: true })).toBeVisible();
  await shot(page, testInfo, '2-carved');

  // undo with a right click (no movement) → volume restored, re-solved
  await page.mouse.click(p.x, p.y, { button: 'right' });
  const s2 = await waitForResultAfter(page, s1.seq);
  expect(s2.solidCount).toBe(s0.solidCount);
  expect(s2.volume).toBe(s0.volume);
  expect(s2.canRedo).toBe(true);
  await expect(volumeText(page)).toHaveText(percent1(s0.volume));
  await shot(page, testInfo, '3-undone');

  // redo / undo with the keyboard shortcuts
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  const s3 = await waitForResultAfter(page, s2.seq);
  expect(s3.solidCount).toBe(s1.solidCount);
  await page.keyboard.press('ControlOrMeta+Z');
  const s4 = await waitForResultAfter(page, s3.seq);
  expect(s4.solidCount).toBe(s0.solidCount);
  await expect(volumeText(page)).toHaveText(percent1(s0.volume));

  expect(errors).toEqual([]);
  return errors;
}

/** One left drag = one history entry: a single undo restores everything it carved. */
export async function dragIsOneUndo(page: Page, testInfo: TestInfo, backend: BackendId): Promise<void> {
  const errors = trackErrors(page);
  const s0 = await openStage(page, STAGE_ID, backend);
  await skipTutorial(page);

  const { from, to } = await findCarveRun(page, 48);
  expect(to.x - from.x, 'a 48 px horizontal run over carvable voxels').toBeGreaterThanOrEqual(48);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.mouse.up();
  const s1 = await waitForResultAfter(page, s0.seq);
  expect(s0.solidCount - s1.solidCount, 'voxels removed by the drag').toBeGreaterThanOrEqual(2);
  await expect(volumeText(page)).toHaveText(percent1(s1.volume));
  await shot(page, testInfo, '1-dragged');

  await page.keyboard.press('ControlOrMeta+Z');
  const s2 = await waitForResultAfter(page, s1.seq);
  expect(s2.solidCount).toBe(s0.solidCount);
  expect(s2.canUndo, 'the whole drag was a single history entry').toBe(false);
  await expect(volumeText(page)).toHaveText(percent1(s0.volume));

  expect(errors).toEqual([]);
}
