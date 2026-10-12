---
id: T-314
title: Per-stage difficulty knobs — allowable-stress margin and hanging (pulling) loads
status: todo
phase: 1
depends: [T-305, T-310]
owns:
  - tools/blender/stagekit.py
  - crates/topopt/src/**
touches:
  - stages/src/**
  - apps/web/src/render/jigs.ts
  - docs/specs/stage-format.md
verify:
  - cargo test -p topopt
  - bash scripts/build-stages.sh --check
---
## Goal
Design doc 難易度のつまみ: "許容応力の余裕 — 序盤は余裕を大きく、後半ほど最適解に近い形しか通らない".
Today topopt always calibrates the benchmark to 0.9 utilisation, so the margin knob cannot vary
per stage (raised by T-305).

## Requirements
- Stage source property (e.g. `stage_props(benchmark_utilization=0.75)`) carried through the
  exporter to topopt calibrate; default 0.9 keeps current stages byte-identical. If it must be
  stored in the stage JSON, that is a contract change: update spec + both twins (ask main first).
- Hanging/pulling loads: draw the load arrow / weight outside the material (render/jigs.ts and the
  T-310 jig placement) so stages can pull as well as push; then T-305's three reworked stages may
  use pulls again where that teaches more.

## Log
