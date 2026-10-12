import { defineConfig } from 'cf/config';

// The game on Cloudflare: an assets-only Worker (no entrypoint, no server code).
// Which files are served is decided by the build (vite.config.ts → apps/web/dist); this file
// only sets runtime behaviour. COOP/COEP come from apps/web/public/_headers, which ships
// inside the assets and is applied by Workers Static Assets. See README.md.
export default defineConfig({
  worker: {
    name: 'stress-carve',
    compatibilityDate: '2026-10-01',
    assets: {
      // Single page: unknown paths get index.html (what Pages did without a 404.html).
      notFoundHandling: 'single-page-application',
    },
    // Optional custom domain on a zone in the same account (README "Custom domain"):
    // domains: ['carve.example.com'],
  },
});
