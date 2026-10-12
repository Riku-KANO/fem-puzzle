# 応力彫刻 STRESS CARVE — agent guide

Browser puzzle: carve a loaded voxel block into the lightest structure that survives a
real 3D FEM analysis. Design doc: `docs/削り出しパズル 企画・技術設計書.md`.

## Map

| path | what | language |
| --- | --- | --- |
| `crates/stage` | stage JSON types + bitmask codec (contract) | Rust |
| `crates/fem` | Hex8 voxel FEM solver: matrix-free PCG / MGCG, stress, connectivity | Rust |
| `crates/fem-wasm` | wasm-bindgen `Session` for the browser worker | Rust → WASM |
| `crates/topopt` | offline SIMP/OC optimiser: benchmark solutions, calibration | Rust (native CLI) |
| `packages/protocol` | TS twin of the contracts: stage types/codec, worker messages | TS |
| `apps/web` | game: Svelte 5 UI + Three.js view + solver worker | TS / Svelte |
| `tools/blender` | headless Blender stage exporter + asset scripts | Python (Blender 5.2) |
| `stages/` | built stage JSON (`stages/src/` = sources) | JSON / Python |
| `docs/specs/` | **contracts** — read before touching an interface | |
| `docs/tasks/` | task board (one file per task) | |
| `docs/loop/` | how the parallel development loop works | |

## Commands

```bash
pnpm install                    # JS deps (pnpm only — never npm/yarn)
bash scripts/verify.sh fast     # tasks + rust fmt/clippy/test + ts typecheck/test
bash scripts/verify.sh full     # + wasm build + web build + e2e + perf gate
node scripts/tasks.mjs          # board;  `ready`, `plan 3`, `show T-101`, `set T-101 doing`
pnpm dev                        # web app (http://localhost:5173)
pnpm build:wasm                 # wasm-pack → crates/fem-wasm/pkg (git-ignored)
bash scripts/build-stages.sh    # Blender → stages/*.json   (BLENDER env overrides path)
```

Blender: `/Applications/Blender.app/Contents/MacOS/Blender` (not on PATH).

## Working rules

1. **Work through a task file.** Every change belongs to a task in `docs/tasks/`. Read the
   task, its `depends`, and the specs it links before writing code. Stay inside the task's
   `owns` paths; edits to `touches` paths are allowed but must be minimal (wiring only).
   Anything else → note it in the task's `## Log` as a follow-up instead of doing it.
2. **Contracts are stable.** `docs/specs/*`, `crates/stage`, `packages/protocol` change only
   in a task that updates the spec, both language twins and their tests together.
3. **Done = green.** Run the task's `verify` commands and `bash scripts/verify.sh fast`
   before reporting done. Never weaken/skip a test or lint to get green; if a check is
   wrong, say so in the log.
4. **Leave a trail.** Append dated notes to the task's `## Log` (decisions, measurements,
   follow-ups). The log is the hand-off to the next agent — assume no shared memory.
5. **Small commits on the task branch**, message `T-xxx: <what>`. Do not merge to `main`
   yourself; the orchestrator integrates with `scripts/integrate.sh`.
6. Tests live next to the code (`#[cfg(test)]`, `crates/*/tests`, `apps/web/test`).
   Numerical code gets a test against an analytic or reference result.

## Conventions

- Units SI (m, N, Pa). Stage axes Y-up; Blender is Z-up (convert in the exporter only).
- Element index `x + nx*(y + ny*z)`; node index `i + (nx+1)*(j + (ny+1)*k)`; DOF `3n+c`.
- Rust: edition 2024, `cargo fmt`, clippy `-D warnings`, no `unwrap()` on user/stage input.
- TS: strict + `noUncheckedIndexedAccess`; Svelte 5 runes; no default exports except
  Svelte components. UI text in Japanese, code/comments in English.
