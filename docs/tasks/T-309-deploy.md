---
id: T-309
title: Cloudflare deployment with the cf CLI (Workers + Static Assets) and CI template
status: review
phase: 1
depends: [T-202]
owns:
  - deploy/**
  - .github/workflows/deploy.yml
touches:
  - apps/web/public/_headers
  - package.json
verify:
  - pnpm build
---
## Goal
Design doc: 配信 (static hosting on Cloudflare, COOP/COEP headers). **Use the new `cf` CLI
(npm package `cf`, github.com/cloudflare/cf, open beta since 2026-09-28) — not Wrangler.**
`cf` deploys Workers projects (config `cloudflare.config.ts`, Vite plugin 2.0 beta); Pages is
not covered by it, so the target is a **Workers + Static Assets** site serving `apps/web/dist`.

## Requirements
- Pin `cf` as a devDependency (pnpm; Node ≥ 22.18). Prefer an assets-only project under
  `deploy/` whose assets directory is `../apps/web/dist`, so `apps/web` (Vite config owned by
  T-102) needs no Cloudflare plugin. Investigate with `cf --help`, `cf cli search ...`,
  `cf schema ...`; record what the beta actually supports in `deploy/README.md`.
- COOP/COEP (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy:
  require-corp`) on every response, `.wasm` served as `application/wasm`; keep
  `apps/web/public/_headers` if Workers Static Assets honours it, otherwise configure headers
  the way `cf` supports and document it.
- Build backend: `@cloudflare/vite-plugin` v2 beta (user decision) — **no wrangler package**.
  Prefer `deploy/vite.config.ts` reusing apps/web; a conditional plugin in apps/web/vite.config.ts
  (explicit mode only) is the fallback.
- `cf build` (no credentials) must succeed locally; `pnpm deploy:cf` script runs build-wasm →
  web build → `cf deploy`. Do **not** run `cf deploy`, `cf auth login`, or create accounts.
- `.github/workflows/deploy.yml` template: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
  secrets (minimal token permissions documented), `DO_NOT_TRACK=1` to disable cf telemetry,
  `cf build` then `cf deploy --prebuilt`; manual trigger (`workflow_dispatch`) only.

## Acceptance criteria
- [x] `cf build` output verified locally: assets present, headers configured, wasm MIME ok.
- [x] `deploy/README.md` with the exact steps for the user (auth, first deploy, custom domain).
- [x] Note in the Log which beta version was used and any rough edges found.

## Log

### 2026-10-12 — T-309 worker (agent-a84c54b78ccd058c9)

**Result.** `deploy/` is a standalone pnpm project. It has its own `pnpm-lock.yaml`, and its
`pnpm-workspace.yaml` (`allowBuilds`) denies the workerd/esbuild postinstalls. It pins **cf
1.0.0-beta.14**, **@cloudflare/vite-plugin 2.0.0-beta.sha-91c870c02** and vite 8.3.4.
- `deploy/vite.config.ts` = `cloudflare()` + `publicDir: '../apps/web/dist'`, with no
  `index.html`. `deploy/cloudflare.config.ts` declares the assets-only Worker `stress-carve`
  (SPA not-found handling). apps/web is untouched apart from a comment in `public/_headers`.
- `pnpm deploy:cf` runs `pnpm build`, then `cf build --mode production`,
  `check.mjs --build-output` and `cf deploy --prebuilt --mode production`. It is a one-line
  alias in the root package.json, approved by main and added to `touches`.
- `.github/workflows/deploy.yml` is `workflow_dispatch` only, with a `dry_run` input. It sets
  `DO_NOT_TRACK=1` and `CF_SEND_TELEMETRY=false`, builds wasm-pack 0.15.0 + `pnpm build`, then
  runs `cf build`, the checks plus a workerd preview check, `cf deploy --dry-run`, `cf deploy
  --prebuilt` with the secrets, and a live check.
- `deploy/check.mjs` + `lib.mjs` (Node built-ins only; 22 node:test tests in `lib.test.mjs`)
  run these checks:
  - `_headers` isolation for every file, including comma-joined duplicates
  - Workers asset limits
  - wasm size (raw/gzip/brotli)
  - Build Output = dist, built in mode production
  - over HTTP: COOP/COEP, script COEP, `application/wasm`
  - policy: exact pins, no Wrangler anywhere

**Verified** (no deploy and no login; `cf deploy` was not run, not even `--dry-run`):
- `pnpm build` passes. `cf build` reports "Delegating to pnpm vite build --mode production".
  `.cloudflare/output/v0` is `{buildContext:{mode:production}}` + `workers/default/{worker.config.json, assets/}`,
  and `assets` is byte-for-byte the dist file set, `_headers` included.
- The game build has no wasm until T-205, so I swapped in a probe build that loads
  `fem_wasm_bg.wasm` (stub from main's scaffold, 13.1 KiB raw / 6.0 KiB gzip / 5.1 KiB brotli).
  With it:
  - Plugin `vite preview` (workerd, production asset handling): "Parsed 1 valid header rule",
    COOP/COEP on every response, `.wasm` → `application/wasm`, SPA fallback,
    `/_headers` not served, `crossOriginIsolated === true` in Chromium.
  - `cf dev`: same, after adding `server.headers`.
- apps/web `vite preview` (real game build): COOP/COEP present and `crossOriginIsolated === true`.
- Earlier, before the cf switch, I verified the Pages path: `wrangler pages dev` honoured
  `_headers` and served wasm as application/wasm + br. That code is dropped.
- `cf deploy` reads `<assets>/_headers` and uploads it in the assets config (cf source,
  `_headers: … ?? read(join(directory, "_headers"))`), so `_headers` is the production
  mechanism and no cf-specific header config is needed.

**Decisions.**
- **Wrangler backend rejected.** In beta.14, `cf build`/`cf dev` need a backend package in
  package.json: `@cloudflare/vite-plugin@2` beta or `wrangler>=4.136`. cf autoconfig
  (`cf init .`) for a static dir generates `wrangler.config.ts` (`assetsDirectory`). That works
  (verified in scratch), but the user wants zero Wrangler, so the Vite plugin is the backend.
- **V2 over V1.** V2 (`publicDir` = dist) ships the exact `pnpm build` artefact. V1 (load
  apps/web/vite.config.ts and add `cloudflare()`) writes the Build Output to
  `apps/web/.cloudflare` and re-bundles with different hashes.
- **Standalone pnpm project.** pnpm 11 fails install on unreviewed postinstalls
  (`ERR_PNPM_IGNORED_BUILDS`). A standalone deploy/ also keeps workerd (~100 MB) out of the
  root workspace, verify and every worktree.

**Rough edges (beta).**
- There is no `assets.directory` in cloudflare.config.ts.
- `cf dev` cannot forward `--port`/`--host` to a Vite backend, so ports are in vite.config.ts
  (8787 dev, 8788 preview).
- `_headers` in Vite dev mode is experimental and reaches documents only. Hence
  `server.headers`, but never `preview.headers`, where workerd applies `_headers` and a
  duplicate would be comma-joined.
- `cf build` records a mode only when `--mode` is passed, and `deploy --prebuilt` must match it.
- The `cf deploy` output format is undocumented. CI extracts the workers.dev URL best-effort
  and also accepts `vars.SITE_URL`.
- The minimal token permission is not documented by cf. The README says Workers Scripts:Edit
  (+ Zone Workers Routes:Edit for a custom domain), with the "Edit Cloudflare Workers"
  template as fallback.
- `cf --help` prints an agent-discovery banner, and the plugin prints an "AI agent detected"
  route list.
- wasm-pack 0.15.0 is still released at github.com/rustwasm/wasm-pack (the release tarball
  URL is used in deploy.yml).

**Follow-ups.**
- After T-205: add `--require-wasm` in deploy.yml and the `deploy:*` scripts.
- Immutable caching for hashed assets needs a Vite `assetsDir` distinct from
  `public/assets/**` (T-307), owned by T-102/T-205.
- Bump `actions/*@v4` in ci.yml and deploy.yml together (v7 exists).
- T-306 could assert `self.crossOriginIsolated === true` in e2e.
- Before the first real deploy, the user runs `pnpm --dir deploy deploy:dry-run`, which runs
  `cf deploy --dry-run` for the first time anywhere.
