// One smoke step each for the HUD features around the carve loop (mock backend):
// section / X-ray views (T-303), thin-wall badge (T-308) and the load test (T-302).

import { expect, test } from '@playwright/test';
import { STAGE_ID } from './flows.ts';
import {
  blurFocus,
  brushStrokes,
  canvasStats,
  loadTestButton,
  nextFrames,
  openStage,
  resultCard,
  selectBrush,
  shot,
  skipTutorial,
  slotStrokes,
  submitButton,
  trackErrors,
  W1_01_SLOT,
  waitForResultAfter,
} from './game.ts';

test.describe('view modes and HUD features (mock backend)', () => {
  test('section and X-ray views reach the scene and render', async ({ page }, testInfo) => {
    const errors = trackErrors(page);
    await openStage(page, STAGE_ID, 'mock');
    await skipTutorial(page);
    const modes = page.getByRole('group', { name: '表示モード' });
    const view = () => page.evaluate(() => window.__stressCarve?.scene.views.view ?? null);
    const hasMask = () => page.evaluate(() => window.__stressCarve?.scene.views.sectionMask != null);

    // 断面: w1-01 is 24×8×4, so the first cut goes across z (the thinnest axis), at the middle
    await modes.getByRole('button', { name: '断面' }).click();
    await expect(modes.getByRole('button', { name: '断面' })).toHaveAttribute('aria-pressed', 'true');
    const settings = page.getByRole('group', { name: '断面の設定' });
    await expect(settings).toBeVisible();
    await expect.poll(view).toMatchObject({ section: { axis: 2, cut: 2 }, xray: null });
    expect(await hasMask()).toBe(true);
    const slider = settings.getByRole('slider', { name: '断面の位置' });
    await expect(slider).toHaveAttribute('aria-valuetext', '2 / 4');
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(slider).toHaveAttribute('aria-valuetext', '1 / 4');
    await expect.poll(view).toMatchObject({ section: { axis: 2, cut: 1 } });
    const sectioned = await canvasStats(page);
    expect(sectioned.drawnFraction, 'the cut part still draws').toBeGreaterThan(0.02);
    await shot(page, testInfo, '1-section');

    // X線: default threshold 30 %, section off
    await modes.getByRole('button', { name: 'X線' }).click();
    await expect(page.getByRole('group', { name: 'X線の設定' })).toBeVisible();
    await expect(settings).toBeHidden();
    await expect.poll(view).toMatchObject({ section: null, xray: 0.3 });
    expect(await hasMask()).toBe(false);
    expect((await canvasStats(page)).drawnFraction).toBeGreaterThan(0.02);
    await shot(page, testInfo, '2-xray');

    // 通常
    await modes.getByRole('button', { name: '通常' }).click();
    await expect.poll(view).toEqual({ section: null, xray: null });
    await expect(page.getByRole('group', { name: 'X線の設定' })).toBeHidden();

    expect(errors).toEqual([]);
  });

  test('thin-wall badge appears for a 1-voxel chord and toggles its tint', async ({ page }) => {
    const errors = trackErrors(page);
    const s0 = await openStage(page, STAGE_ID, 'mock');
    await skipTutorial(page);
    const badge = page.getByRole('button', { name: /^薄い部分 \d+ ボクセル/ });
    await expect(badge, 'the authored block has no thin walls').toHaveCount(0);

    // the known slot leaves a 1-voxel bottom chord under it
    await selectBrush(page, 5);
    await brushStrokes(page, slotStrokes(W1_01_SLOT.noStars.centres));
    await waitForResultAfter(page, s0.seq);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('aria-pressed', 'true');
    await badge.click();
    await expect(badge).toHaveAttribute('aria-pressed', 'false');
    await badge.click();
    await expect(badge).toHaveAttribute('aria-pressed', 'true');

    expect(errors).toEqual([]);
  });

  test('load test: Space plays (frozen frame), badge, Space stops; not while the result card is open', async ({
    page,
  }, testInfo) => {
    const errors = trackErrors(page);
    await openStage(page, STAGE_ID, 'mock');
    await skipTutorial(page);
    const button = loadTestButton(page);
    const badge = page.getByRole('status').filter({ hasText: '載荷テスト' });
    const status = () => page.evaluate(() => window.__stressCarve?.scene.loadTest.current ?? null);
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    // pin the show in its hold phase (lift 0.3 + descend 0.8 + load 1.6 s) for a stable frame
    await page.evaluate(() => {
      const lt = window.__stressCarve?.scene.loadTest;
      if (lt) lt.freezeAt = 3;
    });
    await blurFocus(page);
    await page.keyboard.press('Space');
    await expect(badge).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(status).toMatchObject({ state: 'playing', phase: 'hold', runs: 1, overstressed: 0 });
    expect((await status())?.scale, 'auto exaggeration factor').toBeGreaterThan(1);
    await expect(badge).toContainText(/変形 ×[\d,.]+/);
    await expect(badge).toContainText('許容応力以内');
    expect((await canvasStats(page)).drawnFraction, 'the deformed part draws').toBeGreaterThan(0.02);
    await shot(page, testInfo, '1-load-test');

    await page.keyboard.press('Space');
    await expect(badge).toBeHidden();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(status).toMatchObject({ state: 'idle', runs: 1 });

    // the result card blocks it: button disabled, Space ignored
    await submitButton(page).click();
    await expect(resultCard(page)).toBeVisible();
    await expect(button).toBeDisabled();
    await blurFocus(page);
    await page.keyboard.press('Space');
    await nextFrames(page, 2);
    expect(await status()).toMatchObject({ state: 'idle', runs: 1 });
    await expect(badge).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(resultCard(page)).toBeHidden();
    await expect(button).toBeEnabled();

    expect(errors).toEqual([]);
  });
});
