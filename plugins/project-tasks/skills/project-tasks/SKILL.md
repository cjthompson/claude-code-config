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

| Request | Required reference | Covers |
|---|---|---|
| Every invocation | [commands/init.md](../../commands/init.md) | helper resolution, database setup, project ID, host capabilities, recovery of interrupted `in_progress` tasks |
| Create/list/update/check/complete/cancel/prioritize a task, hide or show the task list, recent context, or generate changelog | [references/task-commands.md](references/task-commands.md) | task logging syntax, task CRUD, plan-link removal, check verdicts, hide list, changelog |
| Run all tasks | [references/task-commands.md](references/task-commands.md) and [references/task-execution.md](references/task-execution.md) | batch rules, isolation, per-task pipeline |
| Run one task, dispatch Scout/Executor, accept work, or handle worker failure | [references/task-execution.md](references/task-execution.md) | preconditions, isolation, baseline and `ownedPaths` derivation, task-list lifecycle, dispatch prompts, Accept and commit |
| Validate, repair, restart, clarify, reject, or cancel an executing task | [references/validation-flow.md](references/validation-flow.md) | callback matching and stale callbacks, validation, repair and restart pipelines, cancellation cleanup |
| Run a plan | [references/plans.md](references/plans.md) and [references/task-execution.md](references/task-execution.md) | pending/unblocked child-task selection, then per-task pipeline |
| Any plan operation | [references/plans.md](references/plans.md) | `P###` vs `--plan-id`, propose/apply, drift, notes, `--output-file` |

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
    ownedPaths: deduplicated, normalized repository-relative POSIX paths[],
    recoveryRequired?
  }
}
```

`ownedPaths` is evidence for acceptance and cleanup, not a write-authorization
list: Executors may make any repository changes their Implementation Map
requires, and workers never decide ownership.

## Completion decision

After an Executor returns and ownership has been derived, keep the database task
`in_progress`, set the task-list phase to `awaiting_decision`, and present:

```text
a) Accept — mark complete and update changelog
b) Validate with Strong tier — run a read-only verifier
c) Validate with Top tier — run a read-only verifier
d) Reject / Cancel — cancel the task and choose what happens to the work
```

There is no Retry choice.

## Output formats

`task-db` accepts an optional `--format md|json|pipe` on every command; it defaults
to `pipe`. These reads return formatted results: `task get`, `task list`,
`task recent`, `task deps check`, `task deps validate`, `task deps blocked`,
`task deps unblocked`, `task changelog list`, `plan list`, `plan get`, `plan tasks`,
`plan note list`. Always pass `--format` on them:

- `--format md` to show the result to the user — print it verbatim; never retype or
  hand-convert rows into a table.
- `--format json` to read fields. Output is always one JSON object keyed by part name,
  each part an array of row objects, e.g. `{"task":[{…}]}` — read `task[0].plan_seq`,
  not the top level. An empty part is `[]`.

Never parse `pipe` output. `plan get --content-only` prints the raw body and rejects
`--format`.
