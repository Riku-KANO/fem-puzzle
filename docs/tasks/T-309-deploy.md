---
id: T-309
title: Cloudflare deployment with the cf CLI (Workers + Static Assets) and CI template
status: doing
phase: 1
depends: [T-202]
owns:
  - deploy/**
  - .github/workflows/deploy.yml
touches:
  - apps/web/public/_headers
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
- [ ] `cf build` output verified locally: assets present, headers configured, wasm MIME ok.
- [ ] `deploy/README.md` with the exact steps for the user (auth, first deploy, custom domain).
- [ ] Note in the Log which beta version was used and any rough edges found.

## Log
