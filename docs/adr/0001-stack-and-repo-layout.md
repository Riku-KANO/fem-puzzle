# ADR 0001 — Stack and repository layout

Date: 2026-10-12 · Status: accepted

## Decisions

| topic | choice | why |
| --- | --- | --- |
| Repo | single monorepo: Cargo workspace + pnpm workspace | solver, bindings, optimiser and web share contracts; one `verify.sh` |
| Package manager | pnpm 11 | requested; strict, fast worktree installs from the shared store |
| UI framework | Svelte 5 (runes) | design doc allows Svelte/Preact; Svelte's reactive stores suit HUD meters with no VDOM cost next to Three.js |
| Build | Vite 8 + TypeScript 6.0 | TS 7 (native) is not yet supported by svelte-check |
| 3D | Three.js 0.186 | design doc (InstancedMesh, clipping planes, glTF) |
| Solver | Rust stable 1.97 → wasm32 with `+simd128`, wasm-bindgen via wasm-pack | design doc; threads (wasm-bindgen-rayon) need nightly + build-std and are deferred to T-402 |
| Stage sources | Python scripts driving Blender headless (`stages/src/*.py`) | diffable text instead of binary .blend; still the Blender naming convention from the design doc |
| Tests | cargo test, vitest, Playwright (T-306), Blender-internal tests | every stream has an automatic signal |

## Consequences

- Workers can run in parallel worktrees; each needs `pnpm install` (fast, hard-linked) and
  its own `target/` (first Rust build ≈ 20 s).
- `crates/fem-wasm/pkg` is generated; the web app must keep working with the mock backend
  when it is absent.
