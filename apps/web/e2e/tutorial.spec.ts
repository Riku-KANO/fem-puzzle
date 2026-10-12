// T-305 tutorial on w1-01 (first visit in a fresh context): manual 次へ, one auto-advance on
// the first carve, スキップ remembered across a reload, restart from the hints card.

import { expect, test } from '@playwright/test';
import { STAGE_ID } from './flows.ts';
import {
  findCarveRun,
  openStage,
  selectBrush,
  trackErrors,
  tutorialCard,
  waitForResultAfter,
  waitForStage,
} from './game.ts';

test('w1-01 tutorial: 次へ, auto-advance on the first carve, スキップ is remembered', async ({ page }) => {
  const errors = trackErrors(page);
  const s0 = await openStage(page, STAGE_ID, 'mock');
  const card = tutorialCard(page);
  await expect(card).toBeVisible();
  const counter = card.getByText(/^チュートリアル \d+\/\d+$/);
  await expect(counter).toHaveText(/^チュートリアル 1\/\d+$/);
  const total = Number((await counter.textContent())?.split('/')[1]);
  expect(total, 'steps in the tutorial').toBeGreaterThanOrEqual(3);

  // the first two steps only explain: 次へ
  await card.getByRole('button', { name: '次へ' }).click();
  await expect(counter).toHaveText(`チュートリアル 2/${total}`);
  await card.getByRole('button', { name: '次へ' }).click();
  await expect(counter).toHaveText(`チュートリアル 3/${total}`);
  await expect(card.getByRole('heading')).toHaveText('青いところを削ろう');

  // "carve something" advances by itself
  await selectBrush(page, 3);
  const { from: p } = await findCarveRun(page);
  await page.mouse.click(p.x, p.y);
  await waitForResultAfter(page, s0.seq);
  await expect(counter).toHaveText(`チュートリアル 4/${total}`);

  // スキップ → the stage hints; remembered after a reload
  await card.getByRole('button', { name: 'スキップ' }).click();
  await expect(card).toBeHidden();
  const hints = page.getByRole('region', { name: 'ヒント' });
  await expect(hints).toBeVisible();
  await page.reload();
  await waitForStage(page, STAGE_ID);
  await expect(hints).toBeVisible();
  await expect(card).toHaveCount(0);

  // the hints card restarts it
  await hints.getByRole('button', { name: 'チュートリアル', exact: true }).click();
  await expect(counter).toHaveText(`チュートリアル 1/${total}`);

  expect(errors).toEqual([]);
});
