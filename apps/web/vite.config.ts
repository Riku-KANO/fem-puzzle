import { svelte } from '@sveltejs/vite-plugin-svelte';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// COOP/COEP make the page cross-origin isolated (SharedArrayBuffer for the future
// multi-threaded solver). Production uses public/_headers on Cloudflare Pages.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// `fem-wasm` → the wasm-pack output when it has been built (`pnpm build:wasm`), else a stub
// whose init fails, so the worker falls back to the mock (src/solver/wasm/femWasm.ts).
// Resolved once at startup: restart Vite after building the package.
const femWasmPkg = fileURLToPath(new URL('../../crates/fem-wasm/pkg/fem_wasm.js', import.meta.url));
const femWasmBuilt = existsSync(femWasmPkg) && existsSync(femWasmPkg.replace(/\.js$/, '_bg.wasm'));
const femWasmStub = fileURLToPath(new URL('./src/solver/wasm/femWasmStub.ts', import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      'fem-wasm': femWasmBuilt ? femWasmPkg : femWasmStub,
    },
  },
  server: { headers: isolationHeaders, fs: { allow: ['../..'] } },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
