// The carve loop with the real FEM solver (`?backend=wasm`, T-205), then the real judge on
// real solver output. `?backend=wasm` is strict (no silent fallback to the mock), so a
// broken wasm build fails here. Not skipped: `scripts/verify.sh full` and the task verify
// lists run `pnpm build:wasm` first; without the package this fails with that hint.

import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { carveUndoLoop } from './flows.ts';
import { resultCard, shot, submitButton } from './game.ts';

const wasmBinary = fileURLToPath(new URL('../../../crates/fem-wasm/pkg/fem_wasm_bg.wasm', import.meta.url));

test.describe('wasm backend', () => {
  test('carve loop on the real solver; the uncarved block passes without stars', async ({ page }, testInfo) => {
    expect(existsSync(wasmBinary), 'crates/fem-wasm/pkg is not built — run `pnpm build:wasm` before the e2e run').toBe(
      true,
    );
    // load → converged result → carve → undo/redo, ends on the authored block (current result)
    const errors = await carveUndoLoop(page, testInfo, 'wasm');

    const env = await page.evaluate(() => ({
      isolated: crossOriginIsolated,
      ready: window.__stressCarve?.solver.ready ?? null,
    }));
    expect(env.isolated, 'COOP/COEP make the page cross-origin isolated').toBe(true);
    expect(env.ready?.backend).toBe('wasm');
    expect(env.ready?.levels, 'multigrid levels of the wasm solver').toBeGreaterThan(0);
    await expect(page.getByRole('region', { name: '応力表示' }).getByTitle('ソルバー')).toHaveText('wasm');

    // the T-301 judge on real FEM output: w1-01 uncarved (max utilisation ~44 %) passes,
    // but its volume (100 %) earns no star
    await expect(submitButton(page)).toBeEnabled();
    await submitButton(page).click();
    const card = resultCard(page);
    await expect(card).toBeVisible();
    await expect(card).toContainText('合格(星なし)');
    await expect(card.locator('[aria-label="星 0"]')).toBeVisible();
    const rules = card.getByRole('list', { name: '判定' });
    await expect(rules.locator('li.fail')).toHaveCount(0);
    await expect(rules.locator('li.pass')).toHaveCount(4); // connectivity, keep, stability, strength
    await shot(page, testInfo, '4-result');
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();

    expect(errors).toEqual([]);
  });
});
