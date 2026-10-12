# The development loop

This repo is set up so that several agents can build the game **in parallel and
unattended**, with a human (or an orchestrator session) only choosing what goes next and
reviewing outcomes. Everything an agent needs is in the repo; nothing depends on chat
history.

```
            ┌──────────────── docs/tasks/*.md (board) ◀───────────────┐
            │  node scripts/tasks.mjs plan N                           │ status, Log
            ▼                                                          │
   orchestrator ── spawns ──▶ task-worker #1 (git worktree, branch) ───┤
   (/dispatch)               task-worker #2 (git worktree, branch) ───┤
            │                task-worker #3 (git worktree, branch) ───┘
            │                   each: read spec → implement → verify → commit
            ▼
   reviewer agent (diff vs acceptance criteria)  ──▶  scripts/integrate.sh <branch>
                                                      (merge into temp branch → verify → ff main)
```

## Building blocks

| piece | file | role |
| --- | --- | --- |
| Task board | `docs/tasks/T-*.md`, `scripts/tasks.mjs` | front matter: `status`, `depends`, `owns`, `touches`, `verify`; body: goal, acceptance criteria, **Log** |
| Contracts | `docs/specs/*.md`, `crates/stage`, `packages/protocol` | interfaces fixed *before* parallel work starts, so streams never wait on each other |
| Gates | `scripts/verify.sh` (fast/full), task `verify` lists, perf budget (T-204) | the automatic feedback signal; "done" means green |
| Merge gate | `scripts/integrate.sh` | merge → verify → fast-forward; main is always green |
| Agents | `.claude/agents/task-worker.md`, `.claude/agents/reviewer.md` | role prompts used for every spawned agent |
| Orchestration | `.claude/skills/dispatch/SKILL.md` (`/dispatch`) | one round of plan → spawn → review → integrate → update board |
| CI | `.github/workflows/ci.yml` | the same `verify.sh full` on every push / PR |

## Why parallel work does not collide

- **Ownership.** Each task lists the paths it `owns`. `tasks.mjs ready/plan` never schedules
  two tasks with overlapping `owns` at once and `tasks.mjs check` fails if in-progress tasks
  overlap. Shared wiring files go under `touches` and must only get minimal edits.
- **Contracts first.** Solver API, worker protocol and stage format were written before any
  stream started (T-002). The web app runs against a mock backend that speaks the real
  protocol, so UI work never blocks on the solver.
- **Isolation.** Each worker runs in its own git worktree/branch with its own `target/` and
  `node_modules/`; integration happens one branch at a time through the merge gate.

## Running a round (in a Claude Code session)

```
/dispatch            # or: /dispatch 3   (max parallel workers)
```

or manually: `node scripts/tasks.mjs plan 3` → spawn one `task-worker` per task with
worktree isolation → review → `scripts/integrate.sh <branch>` for each → mark `done`.
For continuous operation combine with `/loop` (e.g. `/loop /dispatch`), which re-runs a
round whenever the previous one finishes. Stop conditions: nothing `ready`, a gate fails
twice on the same task, or a task needs a human decision (`blocked` + a question in its Log).

## Writing good tasks

A task is a prompt for an agent with no other context. Include: the goal with a pointer to
the design-doc section, the specs to read, the exact `owns`/`touches`, machine-checkable
acceptance criteria (tests, numbers, commands) and the `verify` commands. Size it so one
agent can finish it in one sitting; split otherwise. Prefer adding a new module directory
per feature (`apps/web/src/<feature>/`) so features own disjoint paths.

## Human checkpoints

The design doc's gates are human decisions: Gate 0 (solver speed, T-204 report),
Gate 1 (MVP W1/W2 playtest), etc. Agents prepare the evidence; people decide.
