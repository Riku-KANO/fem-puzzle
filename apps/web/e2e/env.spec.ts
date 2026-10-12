// Workshop environment + Rapier debris (T-310) — smoke step, SKIPPED until T-310 is on main.
//
// Written against the hook T-310 announced (agent message, 2026-10-12):
// - `scene.workshop.envReady: boolean` (glTF bench/room/jigs replaced the placeholders),
//   `scene.workshop.loadJigs()` (w1-01 → 1 root),
// - `scene.workshop.debris.stats` (updated every frame): `{ mode, ready, failed, live, queued,
//   pile, spawned, piled, faded, lost, liveCap, … }`,
// - the e2e build defaults debris to OFF; `?debris=physics` enables it, Rapier is a lazy
//   dynamic import (`assets/rapier-<hash>.js`, wasm inlined) started ~400 ms after the scene.
// To activate once T-310 lands: delete the `test.skip` line, move `EnvHook`'s fields into
// `e2e/hook.ts` (so the typecheck guards them) and run `pnpm --filter @stress-carve/web e2e`.

import { expect, test, type Page, type Request } from '@playwright/test';
import { STAGE_ID } from './flows.ts';
import { findCarveRun, openStage, selectBrush, shot, skipTutorial, trackErrors, waitForResultAfter } from './game.ts';

interface DebrisStats {
  mode: 'physics' | 'fade' | 'off';
  ready: boolean;
  failed: boolean;
  live: number;
  queued: number;
  pile: number;
  spawned: number;
  piled: number;
  faded: number;
  lost: number;
  liveCap: number;
}

/** The T-310 part of the test hook (not on `GameSession` yet, hence not in hook.ts). */
interface EnvHook {
  scene: {
    workshop?: {
      envReady: boolean;
      loadJigs(): unknown[];
      debris: { stats: DebrisStats };
    };
  };
}

function env(page: Page) {
  return page.evaluate(() => {
    const w = (window.__stressCarve as unknown as EnvHook | undefined)?.scene.workshop;
    return w ? { envReady: w.envReady, jigs: w.loadJigs().length, debris: { ...w.debris.stats } } : null;
  });
}

const isRapier = (r: Request) => /rapier/i.test(r.url());

test.describe('workshop environment and debris (T-310)', () => {
  test.skip(true, 'T-310 (env/debris) is not on main yet — spec written against its announced hook, see header');

  test('debris is off by default in the e2e build (no Rapier fetched)', async ({ page }) => {
    const rapier: string[] = [];
    page.on('request', (r) => isRapier(r) && rapier.push(r.url()));
    await openStage(page, STAGE_ID, 'mock');
    await expect.poll(async () => (await env(page))?.envReady, { timeout: 10_000 }).toBe(true);
    expect((await env(page))?.jigs).toBe(1);
    expect((await env(page))?.debris.mode).toBe('off');
    expect(rapier).toEqual([]);
  });

  test('carved voxels fall as chips and settle (?debris=physics)', async ({ page }, testInfo) => {
    const errors = trackErrors(page);
    const rapier: string[] = [];
    page.on('request', (r) => isRapier(r) && rapier.push(r.url()));
    const s0 = await openStage(page, STAGE_ID, 'mock', 'debris=physics');
    await skipTutorial(page);
    await expect.poll(async () => (await env(page))?.debris.ready, { timeout: 10_000 }).toBe(true);
    expect(rapier.length, 'Rapier loaded lazily, once').toBe(1);

    await selectBrush(page, 3);
    const { from: p } = await findCarveRun(page);
    await page.mouse.click(p.x, p.y);
    await waitForResultAfter(page, s0.seq);
    await expect
      .poll(
        async () => {
          const d = (await env(page))?.debris;
          return !!d && d.spawned > 0 && (d.live > 0 || d.piled + d.faded > 0);
        },
        { timeout: 2_000, message: 'chips spawned' },
      )
      .toBe(true);
    await shot(page, testInfo, '1-chips');
    await expect
      .poll(
        async () => {
          const d = (await env(page))?.debris;
          return !!d && d.live === 0 && d.queued === 0 && d.piled + d.faded + d.lost > 0;
        },
        { timeout: 10_000, message: 'chips settled' },
      )
      .toBe(true);
    expect((await env(page))?.debris.failed).toBe(false);
    expect(errors).toEqual([]);
  });
});
