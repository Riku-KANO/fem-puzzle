import { cloudflare } from '@cloudflare/vite-plugin';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Deploy-only Vite project — it does not build the game. `pnpm build` at the repo root builds
// apps/web/dist with the game's own Vite config (wasm included); here that directory is the
// publicDir, which Vite copies verbatim into the Worker's static assets
// (.cloudflare/output/v0/workers/default/assets). deploy/ has no index.html, so the Cloudflare
// plugin compiles a throwaway fallback entry and the output holds exactly apps/web/dist.
// `cf build` / `cf dev` find this file because package.json lists @cloudflare/vite-plugin.
const webDist = fileURLToPath(new URL('../apps/web/dist', import.meta.url));

// = apps/web/public/_headers. Only for `cf dev`, where Vite serves the public files itself and
// _headers reaches documents only. Never add these to `preview`: workerd applies _headers
// there and a header set twice is comma-joined ("require-corp, require-corp" breaks isolation).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(() => {
  if (!existsSync(`${webDist}/index.html`)) {
    throw new Error(`${webDist}/index.html is missing — run \`pnpm build\` at the repo root first.`);
  }
  return {
    publicDir: webDist,
    plugins: [cloudflare({ experimental: { headersAndRedirectsDevModeSupport: true } })],
    // `cf dev` cannot forward --port/--host to Vite yet, so ports live here.
    server: { port: 8787, strictPort: true, headers: isolationHeaders },
    preview: { port: 8788, strictPort: true },
  };
});
