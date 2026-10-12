import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// COOP/COEP make the page cross-origin isolated (SharedArrayBuffer for the future
// multi-threaded solver). Production uses public/_headers on Cloudflare Pages.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      'fem-wasm': fileURLToPath(new URL('../../crates/fem-wasm/pkg/fem_wasm.js', import.meta.url)),
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
