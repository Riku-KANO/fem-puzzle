---
id: T-002
title: Contracts — stage format, solver API spec, worker protocol, stage crate & TS codec
status: done
phase: 0
depends: []
owns:
  - docs/specs/**
  - crates/stage/**
  - packages/protocol/**
verify:
  - cargo test -p stage
  - pnpm --filter @stress-carve/protocol test
---
## Goal
Pin the interfaces every parallel stream codes against, before the streams start.

## Log
- 2026-10-12: stage-format.md, solver.md, worker-protocol.md; `stage` crate and
  `@stress-carve/protocol` (types, bitmask codec, validation) with tests.
