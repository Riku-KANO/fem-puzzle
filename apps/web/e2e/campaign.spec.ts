// Campaign (T-304): title → stage select → stage → back, unlock after a ★1 clear (a 0-star
// pass does not unlock), local records and the in-progress carve surviving a reload.
// Mock backend: the known w1-01 carve gives exact verdicts. Each test starts with empty
// localStorage (fresh browser context).

import { expect, test, type Page } from '@playwright/test';
import { CARVE_KEY_PREFIX } from '../src/game/progress/records.ts';
import { STAGE_ID } from './flows.ts';
import {
  brushStrokes,
  expectScreen,
  findCarveRun,
  openStage,
  percent1,
  resultCard,
  selectBrush,
  shot,
  skipTutorial,
  slotStrokes,
  snapshot,
  submitButton,
  titleUrl,
  trackErrors,
  VIEW_CANVAS,
  volumeText,
  W1_01_SLOT,
  waitForResultAfter,
  waitForStage,
} from './game.ts';

test.use({ reducedMotion: 'reduce' });

/** Stage card on the select screen by its number ("1-2"); its accessible name carries the status. */
function stageCard(page: Page, label: string) {
  return page.getByRole('button', { name: new RegExp(`^${label} `) });
}

function backToSelect(page: Page) {
  return page.getByRole('navigation', { name: 'ゲームメニュー' }).getByRole('button', { name: '← ステージ選択' });
}

function savedCarve(page: Page, stageId: string): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), `${CARVE_KEY_PREFIX}${stageId}`);
}

test.describe('campaign (mock backend)', () => {
  test('title → W1 → stage → back to select → title', async ({ page }, testInfo) => {
    const errors = trackErrors(page);
    await page.goto(titleUrl('mock'));
    await expectScreen(page, 'title');
    await expect(page.getByRole('heading', { name: /応力彫刻/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^はじめる/ }), 'nothing played yet').toBeVisible();
    await expect(page.getByLabel(/^獲得した星 0 \/ \d+$/)).toBeVisible();

    await page.getByRole('button', { name: 'ステージ選択', exact: true }).click();
    await expectScreen(page, 'select');
    await expect(page).toHaveURL(/#\/select/);
    await expect(page.getByRole('tab', { name: /^W1/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /^W2/ }), 'W2 opens after most of W1').toHaveAccessibleName(/未解放/);
    await expect(stageCard(page, '1-1')).toBeEnabled();
    await expect(stageCard(page, '1-1')).toHaveAccessibleName(/未クリア/);
    await expect(stageCard(page, '1-2')).toBeDisabled();
    await expect(stageCard(page, '1-2')).toHaveAccessibleName(/未解放/);
    await shot(page, testInfo, '1-select');

    await stageCard(page, '1-1').click();
    const s0 = await waitForStage(page, STAGE_ID);
    expect(s0.backend, '?backend= survives the hash navigation').toBe('mock');
    await expect(page).toHaveURL(/#\/stage\/w1-01$/);
    await skipTutorial(page);

    await backToSelect(page).click();
    await expectScreen(page, 'select');
    await expect(page).toHaveURL(/#\/select\/w1$/);
    await expect(page.locator(VIEW_CANVAS), 'the game session is disposed').toHaveCount(0);
    expect(await page.evaluate(() => window.__stressCarve === undefined)).toBe(true);

    await page.getByRole('button', { name: '← タイトル' }).click();
    await expectScreen(page, 'title');
    await expect(page.getByRole('button', { name: /^つづきから/ }), 'a stage was opened').toBeVisible();

    expect(errors).toEqual([]);
  });

  test('★1 clear unlocks the next stage; a 0-star pass does not; records survive a reload', async ({
    page,
  }, testInfo) => {
    const errors = trackErrors(page);
    const slot = W1_01_SLOT;
    const card = resultCard(page);
    await page.goto(titleUrl('mock'));
    await page.getByRole('button', { name: /^はじめる/ }).click();
    let s = await waitForStage(page, STAGE_ID);
    await skipTutorial(page);
    await selectBrush(page, 5);

    // 0-star pass → recorded, but 1-2 stays locked; the carve is kept for later
    await brushStrokes(page, slotStrokes(slot.noStars.centres));
    s = await waitForResultAfter(page, s.seq);
    expect(s.solidCount).toBe(slot.noStars.solidCount);
    await submitButton(page).click();
    await expect(card).toContainText('合格(星なし)');
    // (waiting for the autosave is no longer required since T-315 flushes it on route change)
    await expect.poll(() => savedCarve(page, STAGE_ID), { message: 'carve autosaved' }).not.toBeNull();
    await card.getByRole('button', { name: 'ステージ選択へ' }).click();
    await expectScreen(page, 'select');
    await expect(stageCard(page, '1-1')).toHaveAccessibleName(
      new RegExp(`星 0、最良 体積率 ${slot.noStars.volume}、途中 体積率 ${slot.noStars.volume}`),
    );
    await expect(stageCard(page, '1-2'), 'a pass without stars does not unlock').toBeDisabled();

    // back in: the saved carve is resumed (no undo history), one more column → ★1
    await stageCard(page, '1-1').click();
    s = await waitForStage(page, STAGE_ID);
    expect(s.solidCount, 'resumed carve').toBe(slot.noStars.solidCount);
    expect(s.canUndo).toBe(false);
    await expect(volumeText(page)).toHaveText(slot.noStars.volume);
    await selectBrush(page, 5);
    await brushStrokes(page, slotStrokes(slot.oneStar.centres));
    s = await waitForResultAfter(page, s.seq);
    expect(s.solidCount).toBe(slot.oneStar.solidCount);
    await submitButton(page).click();
    await expect(card.locator('[aria-label="星 1"]')).toBeVisible();

    // 次のステージへ opens the unlocked w1-02
    await card.getByRole('button', { name: '次のステージへ' }).click();
    await waitForStage(page, 'w1-02');
    await expect(page).toHaveURL(/#\/stage\/w1-02$/);
    await expect(card).toBeHidden();

    await backToSelect(page).click();
    await expectScreen(page, 'select');
    const cleared = new RegExp(`星 1、最良 体積率 ${slot.oneStar.volume}`);
    await expect(stageCard(page, '1-1')).toHaveAccessibleName(cleared);
    await expect(stageCard(page, '1-2')).toBeEnabled();
    await expect(stageCard(page, '1-3')).toBeDisabled();
    await expect(page.getByRole('tabpanel')).toContainText('クリア 1 / ');
    await shot(page, testInfo, '1-unlocked');

    // records are in localStorage: a reload shows the same campaign state
    await page.reload();
    await expectScreen(page, 'select');
    await expect(stageCard(page, '1-1')).toHaveAccessibleName(cleared);
    await expect(stageCard(page, '1-2')).toBeEnabled();
    await page.getByRole('button', { name: '← タイトル' }).click();
    await expect(page.getByLabel(/^獲得した星 1 \/ \d+$/)).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('a reload resumes the in-progress carve; 最初から discards it', async ({ page }, testInfo) => {
    const errors = trackErrors(page);
    const s0 = await openStage(page, STAGE_ID, 'mock');
    await skipTutorial(page);
    await selectBrush(page, 3);
    const { from: p } = await findCarveRun(page);
    await page.mouse.click(p.x, p.y);
    const s1 = await waitForResultAfter(page, s0.seq);
    expect(s1.solidCount).toBeLessThan(s0.solidCount);

    // autosave (every 500 ms when the bitmask changed)
    await expect.poll(() => savedCarve(page, STAGE_ID), { message: 'carve autosaved' }).not.toBeNull();
    await page.reload();
    const r = await waitForStage(page, STAGE_ID);
    expect(r.solidCount).toBe(s1.solidCount);
    expect(r.volume).toBe(s1.volume);
    expect(r.canUndo, 'the resumed shape is the new baseline').toBe(false);
    await expect(volumeText(page)).toHaveText(percent1(s1.volume));
    await expect(page.getByRole('status').filter({ hasText: '前回の続きから再開しました' })).toBeVisible();
    await shot(page, testInfo, '1-resumed');

    // 最初から asks for a second press, then restores the authored block and drops the save
    await page.getByRole('button', { name: '最初から' }).click();
    await page.getByRole('button', { name: '本当に最初から?' }).click();
    const fresh = await waitForStage(page, STAGE_ID);
    expect(fresh.solidCount).toBe(s0.solidCount);
    await expect(volumeText(page)).toHaveText(percent1(1));
    expect(await savedCarve(page, STAGE_ID)).toBeNull();
    expect((await snapshot(page)).canUndo).toBe(false);

    expect(errors).toEqual([]);
  });

  // T-315 regression: the carve is flushed before the route switches.
  test('leaving right after a carve shows 途中 on the select screen', async ({ page }) => {
    await openStage(page, STAGE_ID, 'mock');
    await skipTutorial(page);
    await selectBrush(page, 5);
    // carve and leave in one task, so the autosave interval cannot run in between
    const volume = await page.evaluate((strokes) => {
      const s = window.__stressCarve;
      if (!s) throw new Error('window.__stressCarve missing');
      const [nx, ny] = s.controller.state.stage.grid;
      for (const { cell, face } of strokes) {
        const element = cell[0] + nx * (cell[1] + ny * cell[2]);
        s.controller.strokeStart({ element, cell, face, t: 0, point: cell });
        s.controller.strokeEnd();
      }
      const v = s.controller.state.volumeFraction;
      const back = [...document.querySelectorAll('nav[aria-label="ゲームメニュー"] button')].find((b) =>
        b.textContent?.includes('ステージ選択'),
      );
      if (!(back instanceof HTMLButtonElement)) throw new Error('← ステージ選択 not found');
      back.click();
      return v;
    }, slotStrokes([3]));
    await expectScreen(page, 'select');
    expect(await savedCarve(page, STAGE_ID), 'saved on close').not.toBeNull();
    await expect(stageCard(page, '1-1')).toHaveAccessibleName(new RegExp(`途中 体積率 ${percent1(volume)}`), {
      timeout: 2_000,
    });
  });
});
