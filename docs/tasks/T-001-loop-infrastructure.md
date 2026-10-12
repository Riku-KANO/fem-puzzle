---
id: T-001
title: Loop infrastructure (task board, verify gates, agents, CI)
status: done
phase: 0
depends: []
owns:
  - scripts/tasks.mjs
  - scripts/verify.sh
  - scripts/integrate.sh
  - docs/loop/**
  - .claude/**
  - .github/**
  - CLAUDE.md
verify:
  - node scripts/tasks.mjs check
  - bash scripts/verify.sh fast
---
## Goal
Make the repo drivable by several agents in parallel: a machine-readable task board,
one verify entry point, a merge gate, agent definitions and CI.

## Log
- 2026-10-12: initial version (orchestrator session).
