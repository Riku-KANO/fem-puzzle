# Deploying STRESS CARVE to Cloudflare (cf CLI)

The game is a static site: `apps/web/dist` (HTML/JS/CSS + the solver `.wasm`) served by an
**assets-only Worker** (Workers + Static Assets) named `stress-carve`. It has no server code.
The site is built and deployed with Cloudflare's **`cf` CLI** (ADR 0002). Wrangler is not used
anywhere. Nothing here has been deployed yet; the steps below are for you, the account owner.

```
repo root   pnpm build ──────────────▶ apps/web/dist   (wasm-pack + vite build, incl. _headers)
deploy/     cf build --mode production ▶ .cloudflare/output/v0/workers/default/assets  (= dist)
deploy/     cf deploy --prebuilt ─────▶ Worker "stress-carve" → https://stress-carve.<you>.workers.dev
```

`deploy/` is a separate pnpm project with its own lockfile. It is not part of the root
workspace, so cf, the Vite plugin and workerd (~100 MB) are kept out of the game's install,
verify and CI. Install it with `pnpm --dir deploy install`.

## Verified versions (2026-10-12)

| tool | version | note |
| --- | --- | --- |
| `cf` | `1.0.0-beta.14` | open beta; pinned exactly in `deploy/package.json` |
| `@cloudflare/vite-plugin` | `2.0.0-beta.sha-91c870c02` | the build/dev backend that `cf` drives; pinned exactly |
| `vite` (deploy/) | `8.3.4` | same as apps/web |
| workerd | `1.20261006.1` | comes with the plugin; used by `cf dev` / `vite preview` |
| Node | ≥ 22.18 (CI: 24) | needed by cf |
| pnpm | 11.20.0 | `deploy/pnpm-workspace.yaml` denies the workerd/esbuild postinstalls (see the comment there) |
| wasm-pack | 0.15.0 | builds `crates/fem-wasm` for the web |

## 1. One-time setup

1. **Cloudflare account.** If you have never used Workers, open *Workers & Pages* in the
   dashboard once and pick your `*.workers.dev` subdomain. There is no project to create:
   the first `cf deploy` creates the Worker.
2. **Install** (repo root):
   ```bash
   pnpm install
   pnpm --dir deploy install
   ```
3. **Sign in** (opens a browser; cf keeps its own login and ignores any Wrangler login):
   ```bash
   pnpm --dir deploy exec cf auth login
   pnpm --dir deploy exec cf auth whoami
   ```
   Telemetry is on by default. To turn it off, run `pnpm --dir deploy exec cf cli telemetry
   disable`, or set `DO_NOT_TRACK=1` in your shell.

## 2. Deploy from your machine

```bash
pnpm --dir deploy deploy:dry-run   # build everything + checks + `cf deploy --dry-run` (uploads nothing)
pnpm deploy:cf                     # same, then `cf deploy --prebuilt --mode production`
```

`deploy:cf` runs these steps:
1. `pnpm build` at the root. This runs wasm-pack on `crates/fem-wasm`, then vite builds `apps/web/dist`.
2. `cf build --mode production` in `deploy/`.
3. `node check.mjs --build-output`.
4. `cf deploy --prebuilt --mode production`.

cf prints the Worker URL (`https://stress-carve.<subdomain>.workers.dev`). Then check the live site:

```bash
node deploy/check.mjs --url https://stress-carve.<subdomain>.workers.dev
```

In the browser console, `crossOriginIsolated` must be `true`.

**Rollback:** run `pnpm --dir deploy exec cf workers deployments --help` (deployments and
versions), or use the dashboard: Workers & Pages › stress-carve › Deployments › Rollback.

## 3. Deploy from GitHub Actions (`.github/workflows/deploy.yml`)

The workflow has a manual trigger only: Actions › **deploy** › *Run workflow*. Its
`dry_run` checkbox builds and validates without uploading.

1. **API token**: dashboard › My Profile › API Tokens › *Create Token* › *Custom token*.
   - Minimal permission: **Account › Workers Scripts › Edit**, with *Account Resources* set to
     your account only.
   - With a custom domain (section 4), also add **Zone › Workers Routes › Edit** for that zone only.
   - The cf beta does not document the exact set it needs. If `cf deploy` fails with an
     authentication or permission error, use the **"Edit Cloudflare Workers"** template
     instead, still limited to your account (and zone).
2. **Repository secrets** (Settings › Secrets and variables › Actions):
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID` (dashboard › Workers & Pages, right-hand column)

   The deploy job uses the environment `production` (or `dry-run`). GitHub creates it on the
   first run. You can add required reviewers to it, or keep the two secrets there instead of
   at repository level.
3. Optional **repository variable** `SITE_URL` (for example `https://carve.example.com`). The
   live check then also runs against it.

What the job does (Ubuntu, Node 24):
1. Installs the Rust toolchain from `rust-toolchain.toml` (incl. `wasm32-unknown-unknown`).
2. Installs wasm-pack 0.15.0 (the release binary).
3. `pnpm install --frozen-lockfile` at the root and in `deploy/`.
4. `pnpm build`: wasm-pack builds `crates/fem-wasm/pkg`, then `vite build` builds `apps/web/dist`.
5. `cf build --mode production`, which needs no credentials.
6. `pnpm --dir deploy test` and `node deploy/check.mjs --serve`. These check `_headers`, the
   size limits and the Build Output, then serve the output in workerd and check
   COOP/COEP/MIME over HTTP.
7. `cf deploy --prebuilt --mode production --dry-run`.
8. `cf deploy --prebuilt --mode production` with the secrets.
9. `check.mjs --url` against the printed `*.workers.dev` URL and against `SITE_URL`.

Telemetry is off in CI (`DO_NOT_TRACK=1`, `CF_SEND_TELEMETRY=false`).

## 4. Custom domain (optional)

The domain's zone must be on the same Cloudflare account.

1. In `deploy/cloudflare.config.ts`, uncomment `domains: ['carve.example.com']`.
2. Deploy. Cloudflare creates the DNS record and the certificate.
3. Give the CI token the extra zone permission from section 3.

Alternative: dashboard › Workers & Pages › stress-carve › Settings › Domains & Routes ›
*Add* › Custom domain. `_headers` applies on every hostname, so cross-origin isolation is
the same as on workers.dev. Set `SITE_URL` so CI checks the custom domain too.

## 5. Headers and MIME types

- **COOP/COEP.** They come from `apps/web/public/_headers`:
  `/*` → `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`.
  - vite copies it into `dist`, and the Vite plugin copies it into the Build Output assets.
  - cf deploy reads `<assets>/_headers` and uploads it with the assets config (seen in the
    cf 1.0.0-beta.14 source).
  - Workers Static Assets then applies it to every asset response. It is not applied to
    responses generated by Worker code, but this Worker has none.
  - The file itself is not served: `/_headers` returns the SPA `index.html`.
  - Limits: 100 rules, 2,000 characters per line.
  - If several rules match the same header, their values are joined with a comma, and
    `require-corp, require-corp` breaks isolation. So keep COOP/COEP in one rule;
    `check.mjs` fails otherwise.
- **`.wasm`.** Workers Static Assets sets Content-Type from the file extension, so `.wasm` is
  `application/wasm` and `WebAssembly.instantiateStreaming` works. At the edge the response
  is compressed (br/gzip); local previews serve it uncompressed.
- **Default headers** added by Cloudflare: `Cache-Control: public, max-age=0, must-revalidate`,
  `ETag`, `CF-Cache-Status`. Hashed files are not cached as immutable yet (see Follow-ups).
- **Unknown paths.** `notFoundHandling: 'single-page-application'` returns `index.html` for
  them, which is what Pages did without a `404.html`.

Verified locally on 2026-10-12. The probe was a build that loads `fem_wasm_bg.wasm`, because
the game does not import the wasm until T-205.

| served by | `/` COOP/COEP | `.wasm` Content-Type | `crossOriginIsolated` |
| --- | --- | --- | --- |
| `cf build` → plugin `vite preview` (workerd, production asset handling) | ✓ | `application/wasm` | `true` |
| `cf dev` (Vite dev server via the plugin) | ✓ | `application/wasm` | `true` |
| apps/web `vite preview` (game build, no wasm yet) | ✓ | (n/a) | `true` |

## 6. Local commands

| command | what |
| --- | --- |
| `node deploy/check.mjs` | static checks of `apps/web/dist`: `_headers` isolation for every file, limits (20,000 files, 25 MiB per file), wasm size raw/gzip/brotli. Add `--require-wasm` once T-205 lands |
| `node deploy/check.mjs --build-output` | also checks that `deploy/.cloudflare/output/v0` is a `production` build whose assets equal `dist` (catches a stale `cf build`) |
| `node deploy/check.mjs --serve` | also serves the Build Output with the plugin's `vite preview` (workerd, port 8788) and checks COOP/COEP, script COEP and wasm MIME over HTTP |
| `node deploy/check.mjs --url <base>` | the same HTTP checks against any running server or the live site |
| `pnpm --dir deploy dev` | `cf dev` at http://localhost:8787. It serves the current `apps/web/dist`; it does not rebuild the game, so run `pnpm build` after changes |
| `pnpm --dir deploy preview` | the Build Output in workerd at http://localhost:8788 |
| `pnpm --dir deploy test` | unit tests of the checker, plus the pinning / no-Wrangler policy |

## 7. Why it is built this way

- **cf, not Wrangler.** This is a user decision (ADR 0002).
  - In this beta, `cf build`/`cf dev` cannot build anything alone. They delegate to a
    "dev-server implementation" listed in `package.json`: either `@cloudflare/vite-plugin@2`
    beta or `wrangler>=4.136`. Without one, cf fails with "No Cloudflare dev-server is installed".
  - `cloudflare.config.ts` has no `assets.directory` field.
  - For a static directory, `cf init` autoconfig generates a `wrangler.config.ts` with
    `assetsDirectory`, so it uses the **Wrangler backend**. That works (verified), but it was
    **rejected because the user wants zero Wrangler**, including as a backend package.
  - So the backend here is the **Cloudflare Vite plugin**.
- **The Vite project in `deploy/` ships `dist`; it does not rebuild the game.**
  - `deploy/vite.config.ts` sets `publicDir: '../apps/web/dist'` and has no `index.html`.
  - The plugin compiles a throwaway fallback entry, and the output holds exactly `dist`: the
    same hashed files as `pnpm build`.
  - apps/web (owned by the game tasks) needs no Cloudflare plugin.
  - The alternative was to load `apps/web/vite.config.ts` and add `cloudflare()`. It builds,
    but the plugin writes the Build Output under the Vite root (`apps/web/.cloudflare`), not
    `deploy/`, and it re-bundles the app with different hashes. Rejected.
- **Dev-mode headers.** In `cf dev`, Vite serves the public files itself, and `_headers`
  (experimental in dev) reaches only documents. So `server.headers` adds COOP/COEP for dev.
  Never put them in `preview.headers`: workerd applies `_headers` there, and the values would
  be comma-joined.
- **Standalone pnpm project.**
  - pnpm 11 fails `install` on unapproved postinstalls (`ERR_PNPM_IGNORED_BUILDS` for workerd
    and esbuild).
  - Adding cf to the root workspace would put workerd into every worktree and CI run, and
    would need `allowBuilds` at the root.

## 8. Rough edges found in the beta

- `cf build`/`cf dev` need a backend package (see above). An assets-only project is
  undocumented apart from "the build must provide the asset source".
- `cf dev` rejects arguments for a Vite backend ("Arguments cannot currently be forwarded to
  the detected dev command `pnpm vite`"), so ports live in `deploy/vite.config.ts`. With the
  Wrangler backend, `--port` was silently ignored.
- With `--mode`, cf records the mode in `config.json`. `cf deploy --prebuilt --mode X` must
  match it, so both use `production` (`check.mjs --build-output` enforces this).
- The format of `cf deploy` output is undocumented. CI extracts the `*.workers.dev` URL on a
  best-effort basis.
- `cf --help` prints an "AGENT COMMAND DISCOVERY" banner. The Vite plugin also detects agents
  and prints extra routes.
- `.cloudflare/` (output, generated types, dev state) is created in `deploy/` and ignored by git.

## 9. If the plugin beta breaks

Work through these in order:
1. **Stay pinned.** The versions above are the last known-good set. Bump `cf` and
   `@cloudflare/vite-plugin` **together**, because they share `@cloudflare/config` and
   miniflare. Check with `pnpm --dir deploy why @cloudflare/config`: there must be one
   version.
2. **Re-verify** after a bump:
   ```bash
   pnpm build && pnpm --dir deploy build && node deploy/check.mjs --serve
   pnpm --dir deploy dev
   ```
   Then open http://localhost:8787 and check that `crossOriginIsolated` is `true`.
3. **No-backend fallback.** Build Output v0 for this site is three things:
   - `.cloudflare/output/v0/config.json` = `{"buildContext":{"isPreview":false,"mode":"production"}}`
   - `workers/default/worker.config.json` = the `worker` object from `cloudflare.config.ts` as JSON
   - `workers/default/assets/` = a copy of `apps/web/dist`

   `cf deploy --prebuilt --mode production` deploys such a tree without any build tool. This
   is not verified against a real deploy; try `--dry-run` first.
4. Going back to the Wrangler backend (`wrangler.config.ts` + `wrangler` devDependency) is a
   **user decision**. Do not do it without asking.

## Follow-ups

- After T-205 lands (the app imports fem-wasm): add `--require-wasm` in `deploy.yml` and in
  the `deploy:*` scripts.
- Long-term caching of hashed assets (`Cache-Control: immutable`) needs a path that only
  Vite's hashed output uses. Today `/assets/*` also receives `public/assets/**` (T-307 glTF,
  not hashed).
- `.github/workflows/ci.yml` and `deploy.yml` use `actions/*@v4`. Newer majors exist; bump
  both together.
