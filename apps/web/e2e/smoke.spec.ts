// Smoke test against the mock backend (fast and deterministic; the default e2e signal).

import { test } from '@playwright/test';
import { carveUndoLoop, dragIsOneUndo } from './flows.ts';

test.describe('mock backend', () => {
  test('carve loop: load, render, carve, newer result, undo restores volume', async ({ page }, testInfo) => {
    await carveUndoLoop(page, testInfo, 'mock');
  });

  test('one drag is one history entry', async ({ page }, testInfo) => {
    await dragIsOneUndo(page, testInfo, 'mock');
  });
});
