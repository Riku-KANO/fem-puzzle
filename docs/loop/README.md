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

## Early start and ownership carve-outs

- `node scripts/tasks.mjs plan N --early` also schedules tasks whose dependencies are still
  *in progress*, as long as the interface between them is fixed by a contract. The early
  worker codes against the spec, pulls the producer's in-progress branch when it needs real
  code (`git merge <producer-branch>` — worktrees share one object store), and is integrated
  only **after** its dependencies land on main.
- `owns` entries starting with `!` carve a sub-path out (`crates/fem/**` +
  `!crates/fem/src/mg/**`), so a new module can be built while its parent crate is in progress.

## Talking to each other

Workers coordinate directly with `SendMessage`, so the orchestrator is not a bottleneck.

| who | does what |
| --- | --- |
| orchestrator | sends every worker the **roster** (task → agent id → branch) when a round starts or changes; approves contract changes; relays when a direct send fails |
| producer (a task others depend on) | commits its public surface early ("API skeleton" commit), then messages consumers with the commit hash and what changed; answers questions; never breaks an announced API silently |
| consumer | pulls the producer branch (`git merge`), never edits producer-owned paths — asks the producer instead; reports mismatches with the spec to the producer *and* `main` |

Message format: first line `[T-xxx → T-yyy] <topic>` (self-contained), then specifics —
commit hashes, file paths, exact signatures. Keep it short; long-lived facts belong in the
task file's Log, not in chat. If a send to a sibling fails, send to `main` naming the
intended recipient. Contract changes (`docs/specs`, `crates/stage`, `packages/protocol`) are
proposed to `main` only.

## Running a round (in a Claude Code session)

```
/dispatch            # or: /dispatch 3   (max parallel workers)
```

or manually: `node scripts/tasks.mjs plan 3 [--early]` → spawn one `task-worker` per task with
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
