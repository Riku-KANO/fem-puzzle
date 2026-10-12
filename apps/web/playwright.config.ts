// E2E smoke tests (T-306): chromium only, against `vite preview` of an e2e-mode build.
//
//   pnpm --filter @stress-carve/web e2e          # typecheck e2e/ + build + preview + test
//   E2E_PORT=4300 pnpm --filter @stress-carve/web e2e
//
// The web server builds with `--mode e2e` into `e2e/dist` (git-ignored), so the production
// `dist/` is never replaced by a build that carries the `window.__stressCarve` test hook.
// The port is derived from this checkout's path: parallel worktrees each get their own
// server instead of silently reusing another checkout's build (reuseExistingServer: false).

import { defineConfig, devices } from '@playwright/test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('.', import.meta.url));

function checkoutPort(): number {
  const fromEnv = Number(process.env.E2E_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  const hash = createHash('sha1').update(webDir).digest().readUInt32BE(0);
  return 4179 + (hash % 400); // 4179..4578, clear of Vite's 4173/5173 defaults
}

const port = checkoutPort();
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['./e2e/skipReasons.ts']],
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    screenshot: 'on',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command:
      'pnpm exec vite build --mode e2e --outDir e2e/dist --emptyOutDir --logLevel warn && ' +
      `pnpm exec vite preview --outDir e2e/dist --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: webDir,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
