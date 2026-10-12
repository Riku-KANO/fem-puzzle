# ADR 0002 — Deploy with the `cf` CLI to Workers + Static Assets

Date: 2026-10-12 · Status: accepted (user decision)

## Context

The design doc plans static hosting on Cloudflare Pages with a `_headers` file for COOP/COEP.
Cloudflare released `cf` (npm `cf`, open beta 2026-09-28), the successor to Wrangler: one CLI
for the whole Cloudflare API, `cloudflare.config.ts` instead of `wrangler.jsonc`, Vite plugin
2.0 based builds. Wrangler gets a final major version after the beta and 18 months of
maintenance. `cf` deploys **Workers** projects; Pages is not part of it.

## Decision

- Use `cf`, never Wrangler, for anything Cloudflare (build, deploy, account/DNS operations).
- Host the game as a **Workers + Static Assets** site serving `apps/web/dist`; still serverless
  and free-tier friendly, same COOP/COEP requirement.
- Pin the `cf` beta version; CI authenticates with `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID` and sets `DO_NOT_TRACK=1`.

- Build backend for `cf build`: **@cloudflare/vite-plugin v2 (beta)**, no Wrangler package at
  all (user decision 2026-10-12). Verified by T-309: `cf` beta.14 cannot build an assets-only
  site without a backend; the alternative (Wrangler as cf's backend) was rejected because the
  user wants zero Wrangler, and Wrangler is being deprecated in favour of `cf`.

## Consequences

- The beta can change commands/config; `deploy/README.md` (T-309) records the verified version.
- References to "Cloudflare Pages" in the design doc mean "Cloudflare static hosting" from now on.
