---
id: T-310
title: Workshop environment, jigs and debris physics in the web view (Rapier)
status: review
phase: 1
depends: [T-102, T-307]
owns:
  - apps/web/src/render/env/**
touches:
  - apps/web/src/render/scene.ts
  - apps/web/package.json
  - pnpm-lock.yaml
  - apps/web/e2e/env.spec.ts   # un-skip T-313's spec (main's request)
  - apps/web/e2e/hook.ts       # its hook fields
verify:
  - pnpm --filter @stress-carve/web typecheck
  - pnpm --filter @stress-carve/web test
  - pnpm --filter @stress-carve/web build
---
## Goal
Design doc: 演出 (削ったボクセルは小さな破片になって落ち、作業台に積もる).

## Requirements
- Load the T-307 glbs (lazy), place jigs at stage supports/loads (replacing placeholders).
- Debris: carved and floating voxels spawn chips simulated by Rapier (WASM, lazy-loaded,
  capped count, sleeping bodies merged into a static pile); independent of the FEM solve.

## Acceptance criteria
- [x] Frame time on a W2 stage while carving logged; no main-thread stalls > 50 ms from debris.

## Log

### 2026-10-13 — T-310 worker (branch worktree-agent-aff23da52ac2bd50b) → review

**Built** (all in `apps/web/src/render/env/`; `scene.ts` gets +25 lines of wiring):
- `assetSpec.ts` — T-307 numbers the code needs before/without the glbs (jig bounds, clamp/pin
  scaling, pad Ø, rod travel, spreader thickness, bench colliders, debris piece extents);
  `assetSpec.test.ts` checks each against `manifest.json` and the glb root `extras`.
- `placement.ts` (pure, three.js maths only) — `computeLayout(stage)`: bench origin
  (domain centre x/z, y −0.16), one support jig per 4-connected cluster (clamp / pin / roller
  per the README rule, local X = patch long axis, +Y = outward normal, README scaling), risers
  from the bench top to each jig's underside (none for jigs on top; pushed out along a
  horizontal normal so the column clears the part), load jigs (origin = contact-patch centre,
  −Y = F̂, cylinder on the face behind the load; weight on the underside when that face is
  covered and F̂ ≈ −Y; spreader scaled to the patch when wider than the Ø32 pad; tilted
  forces get a `lift` so the tilted plate/pad never dips into the part; a patch inside a
  bigger one on the same face stands on that plate instead of stacking a second one; identical
  patch+direction across load cases → one jig listing all `cases`). Local X of a load jig is
  world +X (else +Z) so the cylinder's details face the camera side.
  `placement.test.ts`: invariants for **every** `stages/*.json` (20 stages: orthonormal
  right-handed basis, +Y = n / −Y = F̂, jig bodies sampled as oriented boxes never inside
  material, risers from the bench top to the jig underside and never through the part), exact
  poses for w1-01 / w2-01, all 6 faces × (clamp, roller), pins per cluster, all ±X/±Y/±Z and a
  tilted force, covered → weight, small patch → no spreader, multi-case dedupe, nested patches.
- `assets.ts` — lazy `GLTFLoader` (dynamic import) + per-page template cache; per-session
  instances share geometry, clone materials.
- `workshop.ts` — `Workshop` (one per StageScene / game session): glTF bench + room at the
  bench origin (unlit, `toneMapped = false`), jigs, load-jig roots `{name:'load', userData:
  {kind, caseIndex, cases, loadIndex, setStroke(t)}}` (T-302 drives `position`; setStroke moves
  `cylinder_rod` / `weight_stack`), RoomEnvironment → PMREM env map for the metal jigs,
  `compileAsync` before the swap, swap deferred while `jigsLocked()` (load test active);
  placeholders hidden (`jigs.visible = false`), placeholder bench removed. Part shadow on the
  test bed: `ShadowMaterial` plane + an **intensity-0** shadow-casting light at the baked lamp
  (darkens nothing else; opaque meshes under `domain` get `castShadow`, refreshed every 10
  frames so T-302's deformed mesh casts too). `envReady`, `loaded`, `loadJigs()`, `debris`.
- `debris/plan.ts` (pure) — `resolveFx` (physics | fade for prefers-reduced-motion | off in
  the e2e build; `?debris=physics|fade|off`, `?env=0`), seeded RNG, chip budget spread,
  outward direction of a carved cell, chip initial state, 6-connected components, greedy box
  decomposition (chunk colliders), settle verdict (moving / pile / fade / kill).
- `debris/physics.ts` — lazy `@dimforge/rapier3d-compat@0.21` (dynamic import, WASM inlined),
  world with `lengthUnit = 0.01` (at metre scale 300 chips cost ~10× more per step and never
  sleep — measured in node: 15 ms → 1.5 ms mean), the part (+ obstacles) as ONE voxel collider
  updated with `setVoxel` on every solid flip, bench + jig boxes static, chips = small cuboids
  (convex hulls cost 3–4×, balls vs voxels panic in 0.21), chunks = compound of greedy boxes.
  Every call is guarded: a WASM panic disables physics and the show falls back to fading.
- `debris/view.ts` — live chips: one InstancedMesh per piece (debris.glb `chip_0..3`,
  `swarf_0`), compacted each frame; **pile**: settled chips are baked into static instanced
  meshes (ring buffer 800/piece, no physics body; the newest 250 keep a fixed collider so the
  pile builds up); fade ghosts; chunk surface mesh.
- `debris/debris.ts` — `DebrisFx`: carve → 2 chips/cell (≤ 60 per removal, ≤ 40 bodies
  created per frame, queue ≤ 240), outward + pop velocity, colour = mix(aluminium, the voxel's
  stress colour, 0.6); floating → one rigid chunk per component ≥ 4 cells (smaller crumble to
  chips), undo that restores a chunk's cells shrinks it away; fixed 60 Hz step, ≤ 2 steps per
  frame (slow frames → slow motion, backlog dropped), live cap 300, lowered 20 % whenever a step
  takes > 6 ms (min 60) and regrown slowly; chips resting at bench level → pile, resting on
  the part or a jig → shrink away (keeps the stress colours readable), age 8 s → forced.
  Rapier + debris.glb load 400 ms after the scene; until ready (and after a failure) removals
  fade in place. First world step (~25 ms, lazy WASM compile) is paid in its own task at init;
  off-screen warm-up draws build the GPU pipelines before the first carve. Never writes the
  carve state (test asserts the solid array is untouched). Stats: `debris.stats`.
- e2e: un-skipped T-313's `e2e/env.spec.ts`, its hook fields moved into `e2e/hook.ts`
  (`scene.workshop.{envReady, loadJigs(), debris.stats}`).

**Measurements** (Apple M5 Pro, Chromium headless via Playwright with ANGLE Metal, e2e-mode
production build under `vite preview`, mock backend, synthetic carving through the app's own
pick → controller path; rAF frame deltas, `longtask` observer, `performance.measure` marks):

| run | strokes / cells | chips (max live) | frame mean / p99 / max | step avg / max | update max | long tasks while carving |
| --- | --- | --- | --- | --- | --- | --- |
| w2-01, 3×3 every 150 ms, 8 s | 50 / 313 | 626 (89) | 16.67 / 16.7 / 16.7 ms | 0.45 / 6.4 ms | 7.5 ms | none |
| w2-01, 5×5 every 40 ms, 8 s | 92 / 1089 | 2184 (268) | 16.67 / 16.7 / 16.7 ms | 0.33 / 6.7 ms | 7.7 ms | none |
| w2-02, 5×5 every 40 ms, 8 s | 145 / 1510 | 3026 (268) | 16.67 / 16.7 / 16.7 ms | 0.31 / 6.7 ms | 7.8 ms | none |
| w1-01 / w2-03, 5×5 every 40 ms | 627 / 541 cells | 1260 / 1082 (≤ 277) | max 16.7 ms | ≤ 0.5 / 9 ms | ≤ 10.6 ms | none |
| baseline `?env=0&debris=off`, w2-01 5×5/40 ms | 92 / 1089 | – | 16.67 / 16.7 / 16.7 ms | – | – | none |

Settling (9 s after the last stroke): max frame 16.7 ms in every run. Load-time slices (async
unless noted): glbs fetch+parse ~50 ms, PMREM split into a room-cube render task 35–45 ms +
prefilter 5–7 ms (one `fromScene` was a single 46–58 ms task), env `compileAsync` 12–31 ms,
Rapier import 140–160 ms (4.3 MB chunk, no long task), `init()` 21–24 ms, world 2 ms, warm-up
step 21–33 ms (own task), debris `compileAsync` 12 ms; Workshop constructor 0.8 ms. One 117–167 ms
frame gap without any main-thread long task appeared twice before the GPU warm-up draws were
added (ANGLE builds Metal pipelines at first draw); not seen in 12 runs since. Unit tests:
431 web tests (83 in render/env incl. 8 end-to-end DebrisFx runs with the real Rapier WASM in
node), `pnpm --filter @stress-carve/web e2e` 15/15 twice, `verify.sh fast` green.

**Coordination**: T-302 — agreed contract (I own the jig objects; T-302 writes only
`position`, calls `userData.setStroke`, skips its lift for roots with setStroke); wired
`loadTest.loadJigs = () => workshop.loadJigs()` and `workshop.jigsLocked = () =>
loadTest.active`; checked in the browser: rod extends (0.04 → 0), root follows the load-point
displacement. T-313 — hook fields + `?debris=physics` agreed, spec activated here. T-303 — no
global clipping planes, environment untouched by the section view. T-304/T-311 — Workshop is
created in the StageScene constructor and disposed in `StageScene.dispose()` before the scene
traversal (frees the Rapier world, PMREM texture, shadow map; late async loads check
`disposed`; `compileAsync` waits are bounded by 4 s because they never settle on a disposed
renderer).

**Follow-ups**
- Bundle: the Rapier compat chunk is 4.3 MB (1.67 MB gzip; base64 WASM). The non-compat
  `@dimforge/rapier3d` ships a separate 3 MB `.wasm` (≈ 25 % smaller over the wire) but needs
  `vite-plugin-wasm` + top-level await in `vite.config.ts` — T-309 (bundle) territory.
- A first-time visitor with a cold OS shader cache saw one 135 ms PMREM run (vs 5–7 ms warm);
  all app shaders share that cold-start cost. If it matters, drop the env map and tune the
  jig materials (metalness ↓) instead.
- The load cylinder is tall (0.245 m) and can hide part of the domain from the default camera
  on short W2 beams; a camera/jig-scale pass (T-102 camera or a smaller cylinder in T-307)
  could help.
- Chips that land on the part shrink away instead of piling (by design: the stress colours
  stay readable); a tilt/brush-off effect could replace it later.

