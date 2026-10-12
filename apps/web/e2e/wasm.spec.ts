// The same carve loop with the real FEM solver (`?backend=wasm`, T-205). `?backend=wasm` is
// strict (no silent fallback to the mock), so a broken wasm build fails here.
// Skipped — with the reason in the report — while the WASM backend or its build is missing.

import { test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { carveUndoLoop } from './flows.ts';

const wasmBackendSrc = fileURLToPath(new URL('../src/solver/wasm', import.meta.url));
const wasmBinary = fileURLToPath(new URL('../../../crates/fem-wasm/pkg/fem_wasm_bg.wasm', import.meta.url));

test.describe('wasm backend', () => {
  test.skip(
    !existsSync(wasmBackendSrc),
    'T-205 WASM backend (apps/web/src/solver/wasm) is not on this branch yet',
  );
  test.skip(
    !existsSync(wasmBinary),
    'crates/fem-wasm/pkg is not built — run `pnpm build:wasm` before the e2e run',
  );

  test('carve loop: load, render, carve, newer result, undo restores volume', async ({ page }, testInfo) => {
    await carveUndoLoop(page, testInfo, 'wasm');
  });
});
