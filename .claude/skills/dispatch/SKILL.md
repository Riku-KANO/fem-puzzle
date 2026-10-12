---
name: dispatch
description: Run one round of the parallel development loop for STRESS CARVE — pick ready tasks from docs/tasks, spawn task-worker agents in isolated worktrees, review, integrate green branches into main and update the board. Use when asked to "continue development", "run the loop", "dispatch tasks", or via /dispatch [N].
---

# /dispatch [N] — one loop round

`N` = max parallel workers (default 3). Read `docs/loop/README.md` once if you have not.

## 1. Preflight
- `git status` must be clean on `main`; `bash scripts/verify.sh fast` must pass. If main is
  red, fix that first (it is the only thing worth doing).
- `node scripts/tasks.mjs plan N --json` → the tasks for this round (disjoint `owns`).
  Nothing ready → report the board (`node scripts/tasks.mjs`) and what blocks progress; stop.
- Stub tasks (body says "Stub") must be fleshed out (goal, requirements, acceptance
  criteria, verify) and committed before dispatch.

## 2. Spawn workers (parallel, one message)
For each planned task: `node scripts/tasks.mjs set <ID> doing`, commit the board change on main
(`T-xxx: start`), then in ONE message spawn one Agent per task:
- `subagent_type: task-worker` (fall back to `general-purpose` with the contents of
  `.claude/agents/task-worker.md` prepended if that type is not available)
- `isolation: "worktree"`, `run_in_background: true`
- prompt: `Task <ID>: docs/tasks/<file>. Branch: task/<ID>-<slug>.` plus anything learned
  in earlier rounds that the task file does not say yet (put it in the task file instead
  when possible).

## 3. Review & integrate (as each worker finishes)
1. Read the worker's report. If verify was not green or criteria are unmet, either send it
   back (SendMessage to the same agent with the findings) or mark the task `blocked` with
   the reason in its Log.
2. Spawn a `reviewer` agent on the branch for non-trivial tasks (solver numerics,
   protocol, state management). Send `CHANGES` findings back to the worker; at most 2 cycles.
3. `bash scripts/integrate.sh <branch> fast` from the main checkout. On conflict: ask the
   worker to rebase onto main and re-verify. Never force-merge a red branch.
4. On success: `node scripts/tasks.mjs set <ID> done`, commit `T-xxx: done`.

## 4. Close the round
- `bash scripts/verify.sh full` on main (wasm, web build, e2e/perf gates when present).
- Newly ready tasks? Start the next round (or let `/loop` do it).
- Report to the user: integrated tasks, measurements worth knowing (perf, stage stats),
  blocked tasks with the decision needed, and what the next round will pick up.
