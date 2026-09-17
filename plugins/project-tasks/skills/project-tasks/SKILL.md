---
name: project-tasks
description: Use when the user says "task:", "fix:", "todo:", "plan:", "log task:", "log fix:", "run task:", or "run fix:", or asks to log, run, list, check, complete, cancel, or prioritize project tasks; manage project plans; or generate a changelog from completed tasks.
TRIGGER when: user message starts with "task:", "fix:", "todo:", "plan:", "log task:", "log fix:", "run task:", or "run fix:". Also trigger for task/plan listing, execution, checking, completion, cancellation, priority, plan-link, and changelog requests.
DO NOT TRIGGER when: user is asking a general question about tasks or todos unrelated to project management.
model: haiku
---

# Project Tasks

## Purpose

Store project tasks and plans through the bundled `task-db` helper, execute
tasks through background agents, validate results before destructive retries,
and generate `CHANGELOG.md` entries from completed work.

The lead agent remains available while task workers run. Never perform task
database operations with `sqlite3` or by reading the database file directly.

## Required routing

Read only the references needed for the current request:

| Request | Required reference |
|---|---|
| Every invocation | [commands/init.md](../../commands/init.md) |
| Create/list/update/check/complete/cancel/prioritize a task, or generate changelog | [references/task-commands.md](references/task-commands.md) |
| Run all tasks | [references/task-commands.md](references/task-commands.md) and [references/task-execution.md](references/task-execution.md) |
| Run one task, dispatch Scout/Executor, accept work, or handle worker failure | [references/task-execution.md](references/task-execution.md) |
| Validate, repair, restart, clarify, reject, cancel, or recover an executing task | [references/validation-flow.md](references/validation-flow.md) |
| Run a plan | [references/plans.md](references/plans.md) and [references/task-execution.md](references/task-execution.md) |
| Any plan operation | [references/plans.md](references/plans.md) |

For a completion decision after a worker returns, read both
`task-execution.md` and `validation-flow.md`. References are one level deep;
do not look for another workflow file through a reference.

## Core invariants

1. Use `$TASK_DB <command>` for every database operation. Never invoke
   `sqlite3`, construct SQL, delete `tasks.db`, or read the database file.
2. Quote task display IDs in shell commands: `--seq "#004"`. Plan display IDs
   use `P###`; a plan's global numeric `id` is used only by `--plan-id`.
3. A write-capable worker never commits. Acceptance stages only proven
   task-owned paths and commits after the user confirms.
4. Validation and checking are read-only. They do not change files, the index,
   task status, requirements, or completion metadata.
5. Repair keeps the current implementation. Restart discards task-owned work
   only after explicit confirmation. Neither action uses broad
   `git checkout .`, `git reset --hard`, `git clean`, or `git add -A`.
6. Do not dispatch, accept, repair, restart, or clean up while another callback
   is active for the same task. Ignore callbacks whose generation or dispatch
   identity is stale.
7. If path ownership, branch/worktree identity, or the baseline cannot be
   proven, leave work unchanged and ask the user how to proceed.
8. Nested agents are selected by capability and tier, never by a provider name.

## Agent roles and tiers

| Role | Required capabilities | Default tier |
|---|---|---|
| Planning Scout | Read/search/network/worktree; no write, skill, agent, or MCP delegation | Strong |
| Execution Agent | Read/edit/write/shell/worktree | Fast |
| Verifier | Read/search/network/worktree; no write, skill, agent, or MCP delegation | User-selected Strong or Top |

Resolve `Fast < Strong < Top` through the current host's model roster. Omit the
`model` parameter when the host cannot select one. The frontmatter
`model: haiku` controls skill exercise/verification; it does not select nested
agents.

When the host's agent roster includes the optional `lean-agents` plugin, use
the fully qualified `lean-agents:read-only` profile for Planning Scouts and
Verifiers, and `lean-agents:lean-executor` for Execution Agents. Never try
those names on a host where they are absent.

Otherwise, use a capability-equivalent host profile. When no structurally
read-only profile is available, use the host's general subagent and reinforce
the prompt with:

> You have write tools available only because the read-only profile is not
> installed. Do not use them. Do not modify files, the index, or task data.

Tell the user when prompt-level enforcement is required:

> Note: this host does not expose a structurally read-only subagent, so
> read-only enforcement is prompt-level for this dispatch.

## Session state

Maintain one entry per running task:

```text
runningTasks[seq] = {
  status: pending | scouting | executing | awaiting_decision | validating |
          completed | cancelled | failed,
  executionGeneration,
  validationTier?: strong | top,
  validationSnapshot?,
  repairPassCount: 0 | 1 | 2,
  originalImplementationMap?,
  currentImplementationMap?,
  lastExecutorReport?,
  scoutStatus,
  taskListEntryIds: { scout, execute? },
  activeDispatch?: { generation, stage, id, cancellationRequested? },
  executionContext?: {
    isolation: worktree | direct,
    path, branch, baseCommit, baselineSnapshot,
    worktreeCreatedByTask?, branchCreatedByTask?,
    ownedPaths: repository-relative POSIX paths[],
    recoveryRequired?
  }
}
```

Generate a fresh opaque `executionGeneration` before the initial Scout and
before every confirmed repair or restart pipeline. Each dispatch record contains
that generation, a stage, and the host dispatch ID. A callback may mutate state
only when all three still match and cancellation was not requested.

`ownedPaths` is a deduplicated list of normalized repository-relative POSIX
paths currently attributable to the task. The parent recomputes it from the
recorded baseline after every Executor and revalidates it before staging,
selective restore, or removal. It is evidence for acceptance and cleanup, not a
write-authorization list: Executors may make any repository changes required by
their Implementation Map. Workers report changes but never decide ownership.

## Task-list lifecycle

Use stable entry IDs `scout-{seq}` and `execute-{seq}`. Never create duplicate
entries for validation, repair, or restart.

| Phase | Scout entry | Execute entry |
|---|---|---|
| pending | pending | absent |
| scouting | in progress | pending if already present |
| executing | completed | in progress |
| awaiting_decision | preserve honest Scout result | awaiting decision |
| validating | preserve honest Scout result | validating |
| completed | completed | completed |
| cancelled/failed | clear or mark terminal, never completed |

Every synchronization updates `runningTasks[seq].status` first. If the user has
hidden the list, update only in-memory state and do not create, update, or show
task-list entries.

The persistent task-list UI is optional. When the host does not expose one,
maintain the same `runningTasks` lifecycle in memory and report phase changes in
normal progress messages; do not treat the missing UI as an execution blocker.

At session start, query `in_progress` tasks. A task without live session context
is recovered into `awaiting_decision` with `recoveryRequired: true`. Do not
accept, repair, restart, revert, delete, or dispatch from that entry. Offer to
leave it for manual recovery or explicitly adopt the current checkout as a new
baseline. Adoption requires no active worker, clears previous ownership and
validation state, creates a fresh generation, and starts a new initial Scout.

## Completion decision

After an Executor returns and ownership has been derived, keep the database task
`in_progress`, set the task-list phase to `awaiting_decision`, and present:

```text
a) Accept — mark complete and update changelog
b) Validate with Strong tier — run a read-only verifier
c) Validate with Top tier — run a read-only verifier
d) Reject / Cancel — cancel the task and choose what happens to the work
```

There is no Retry choice. Validation never mutates work. Repair preserves the
current implementation; restart is the only validation outcome that discards
task-owned implementation work, and it requires confirmation.

## Quick reference

| User request | Action |
|---|---|
| `task:` / `fix:` | Log and ask Run Now / Log Only / Auto-Run All |
| `todo:` | Log only |
| `log task:` / `log fix:` | Log only |
| `run task:` / `run fix:` | Log and run immediately |
| `run task #NNN` | Run one pending task |
| runner completion | Accept, Validate Strong/Top, or Reject / Cancel |
| `check task #NNN` | Read-only verification; no status change |
| `run all tasks` | Run all unblocked pending tasks |
| `hide list` | Hide task-list entries; workers continue |
| `generate changelog` | Rebuild from completed tasks |
| any `plan` request | Read `references/plans.md` first |
