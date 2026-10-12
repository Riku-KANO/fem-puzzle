---
id: T-309
title: Cloudflare Pages deployment config and CI artefact
status: todo
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
Design doc: 配信 (Cloudflare Pages, COOP/COEP via `_headers`).

## Requirements
- `pnpm build` produces `apps/web/dist` with the wasm and `_headers`; verify that the
  preview server is cross-origin isolated (`crossOriginIsolated === true`).
- A deploy workflow template that needs only `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` secrets —
  do **not** deploy or create accounts; the user does that.

## Acceptance criteria
- [ ] `deploy/README.md` with the exact steps for the user.

## Log
