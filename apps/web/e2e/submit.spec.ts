// Submit flow and result card (T-301) against the mock backend (deterministic numbers).
// Reduced motion: a clear skips the camera turn, so the benchmark overlay switches to
// 重ねて比較 at once instead of after ~5 s.

import { expect, test } from '@playwright/test';
import { STAGE_ID } from './flows.ts';
import {
  brushStrokes,
  findCarveRun,
  injectResult,
  nextFrames,
  openStage,
  percent1,
  recordDisabled,
  resultCard,
  selectBrush,
  shot,
  skipTutorial,
  slotStrokes,
  snapshot,
  submitButton,
  toolbar,
  trackErrors,
  volumeText,
  W1_01_SLOT,
  waitForResultAfter,
} from './game.ts';

test.use({ reducedMotion: 'reduce' });

test.describe('submit and result card (mock backend)', () => {
  test('提出 only for a current converged result; card compare / Esc / 続けて削る; no carving while open', async ({
    page,
  }, testInfo) => {
    const errors = trackErrors(page);
    const s0 = await openStage(page, STAGE_ID, 'mock');
    await skipTutorial(page);
    const submit = submitButton(page);
    const card = resultCard(page);
    await expect(submit, 'authored block, converged, current').toBeEnabled();

    // a carve makes the result stale: disabled until the newer result is in
    const disabledLog = await recordDisabled(submit);
    const { from: p } = await findCarveRun(page);
    await page.mouse.click(p.x, p.y);
    const s1 = await waitForResultAfter(page, s0.seq);
    expect(s1.solidCount).toBeLessThan(s0.solidCount);
    await expect(submit).toBeEnabled();
    const log = await disabledLog();
    expect(log[0], '提出 disabled while the carve was being solved').toBe(true);
    expect(log.at(-1)).toBe(false);

    // a current but unconverged result (mechanism / stalled CG) keeps it closed, with a hint
    const hint = toolbar(page).getByRole('status');
    await injectResult(page, { converged: false });
    await expect(submit).toBeDisabled();
    await expect(hint).toHaveText('構造が安定していません');
    await injectResult(page, { converged: true });
    await expect(submit).toBeEnabled();
    await expect(hint).toHaveCount(0);

    // open: the uncarved-ish beam passes but earns no star
    await submit.click();
    await expect(card).toBeVisible();
    await expect(card).toContainText('合格(星なし)');
    await expect(card.locator('#result-title')).toHaveText('条件は満たしていますが、星の目標体積率に届いていません');
    await expect(card.locator('[aria-label="星 0"]')).toBeVisible();
    await expect(card.getByText(percent1(s1.volume), { exact: true })).toBeVisible();
    await expect(submit, 'no second submit while the card is open').toBeDisabled();

    // compare with the optimiser
    const compare = card.getByRole('button', { name: '重ねて比較' });
    await compare.click();
    await expect(compare).toHaveAttribute('aria-pressed', 'true');
    await shot(page, testInfo, '1-result-compare');
    const own = card.getByRole('button', { name: '自分の形' });
    await own.click();
    await expect(own).toHaveAttribute('aria-pressed', 'true');

    // the left button does not carve while the card is open (orbit / zoom still work)
    const { from: q } = await findCarveRun(page);
    const before = await snapshot(page);
    await page.mouse.click(q.x, q.y);
    await nextFrames(page, 3);
    const after = await snapshot(page);
    expect(after.solidCount, 'nothing carved under the open card').toBe(before.solidCount);
    expect(after.latestSeq, 'no request sent to the solver').toBe(before.latestSeq);
    await expect(card).toBeVisible();

    // Esc closes
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(submit).toBeEnabled();

    // 続けて削る closes; afterwards the left button carves again
    await submit.click();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: '続けて削る' }).click();
    await expect(card).toBeHidden();
    await page.mouse.click(q.x, q.y);
    const s2 = await waitForResultAfter(page, after.seq);
    expect(s2.solidCount).toBeLessThan(after.solidCount);

    // a design change makes the verdict stale and closes the card: undo by right click
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(card).toBeVisible();
    await page.mouse.click(q.x, q.y, { button: 'right' });
    await expect(card).toBeHidden();
    const s3 = await waitForResultAfter(page, s2.seq);
    expect(s3.solidCount).toBe(after.solidCount);

    expect(errors).toEqual([]);
  });

  test('stars for a known carve on w1-01: 0 stars at 60.9 %, ★1 at 47.9 %', async ({ page }, testInfo) => {
    const errors = trackErrors(page);
    const slot = W1_01_SLOT;
    const s0 = await openStage(page, STAGE_ID, 'mock');
    await skipTutorial(page);
    await selectBrush(page, 5);
    const submit = submitButton(page);
    const card = resultCard(page);
    const panelStars = page.getByRole('region', { name: 'ステージ情報' }).locator('[aria-label^="体積の星"]');

    // three slot columns: passes, but the volume is above ★1
    expect(await brushStrokes(page, slotStrokes(slot.noStars.centres))).toBe(slot.noStars.solidCount);
    const s1 = await waitForResultAfter(page, s0.seq);
    expect(s1.solidCount).toBe(slot.noStars.solidCount);
    expect(s1.converged).toBe(true);
    await expect(volumeText(page)).toHaveText(slot.noStars.volume);
    await expect(panelStars).toHaveAttribute('aria-label', '体積の星 0');
    await submit.click();
    await expect(card).toContainText('合格(星なし)');
    await expect(card.locator('[aria-label="星 0"]')).toBeVisible();
    await expect(card.getByText(slot.noStars.volume, { exact: true })).toBeVisible();
    await expect(card).toContainText('★の目標は体積率 60% 以下です');
    await expect(card).toContainText(slot.benchmark);
    await expect(card).toContainText(slot.noStars.benchDelta);
    await expect(card.getByRole('button', { name: '次のステージへ' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();

    // a fourth column: ★1
    expect(await brushStrokes(page, slotStrokes(slot.oneStar.centres))).toBe(slot.oneStar.solidCount);
    const s2 = await waitForResultAfter(page, s1.seq);
    expect(s2.solidCount).toBe(slot.oneStar.solidCount);
    await expect(volumeText(page)).toHaveText(slot.oneStar.volume);
    await expect(panelStars).toHaveAttribute('aria-label', '体積の星 1');
    await submit.click();
    await expect(card).toBeVisible();
    await expect(card.locator('#result-title')).toHaveText('クリア!');
    await expect(card.locator('[aria-label="星 1"]')).toBeVisible();
    await expect(card.getByText(slot.oneStar.volume, { exact: true })).toBeVisible();
    await expect(card).toContainText(slot.oneStar.benchDelta);
    await expect(card.getByText('自己ベスト更新'), 'better than the 0-star pass recorded above').toBeVisible();
    const rules = card.getByRole('list', { name: '判定' });
    await expect(rules.locator('li.fail')).toHaveCount(0);
    // a clear switches to the comparison by itself (at once with reduced motion)
    await expect(card.getByRole('button', { name: '重ねて比較' })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('button', { name: '次のステージへ' })).toBeVisible();
    await shot(page, testInfo, '1-clear-one-star');

    expect(errors).toEqual([]);
  });
});
