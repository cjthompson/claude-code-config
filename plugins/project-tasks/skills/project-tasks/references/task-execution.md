# Task Execution

Read this file before running a task, accepting worker output, or handling a
Scout/Executor failure. Read `validation-flow.md` as well when presenting or
acting on the post-execution decision menu.

## Contents

- Preconditions and isolation
- Execution context and ownership
- Planning Scout
- Execution Agent
- Completion and Accept
- Worker failures

## Preconditions

1. Read the task and require status `pending`. Do not duplicate an
   `in_progress`, `scouting`, `executing`, `awaiting_decision`, or `validating`
   pipeline. Completed/cancelled work needs a new task or explicit rerun with a
   fresh context.
2. Check dependencies:

   ```bash
   $TASK_DB task deps check --project "$PROJECT" --seq "#{SEQ}"
   ```

   Any output means blocked; report each `#NNN|title|status` row and stop.
3. Create/reuse the deterministic Scout task-list entry and sync `pending`.
4. Require `activeDispatch` to be empty.

## Isolation

- Dirty checkout or multiple concurrent tasks: recommend an isolated worktree.
- Clean checkout with one task: recommend direct execution unless the user or
  host requested isolation.
- A user may override the recommendation, but warn that ambiguous ownership
  prevents automatic commit, restart, revert, or cleanup.

For an isolated run, record whether this task created the worktree and branch.
Never infer branch ownership merely because the task created a worktree.

## Execution context

Before any write-capable dispatch, record:

- isolation mode, absolute path, current branch, and `git rev-parse HEAD`;
- separate `worktreeCreatedByTask` and `branchCreatedByTask` flags;
- `git status --porcelain=v1 --untracked-files=all --ignored=matching`;
- `git diff --cached --binary` and `git diff --binary HEAD`;
- the untracked-path manifest and relevant ignored-path state.

This is `baselineSnapshot`. Generate a fresh `executionGeneration` and include
it in every dispatch identity for this pass.

When the Executor returns, recheck path, branch, and base commit. Derive
`ownedPaths` from changes relative to the baseline, including task-created
untracked files. If a path was already dirty or concurrent changes make
ownership ambiguous, preserve everything and refuse automatic commit or
cleanup.

## Start the task

Set the database status before dispatch:

```bash
$TASK_DB task update --project "$PROJECT" --seq "#{SEQ}" --status in_progress
```

If the task has a `plan_id`, this also promotes its plan to `in_progress`.

### Planning Scout

Sync `scouting`, then dispatch the read-only Planning Scout at Strong tier in
the recorded execution location. Record `{generation, stage: scout, id}`.

Prompt shape:

```text
You are a read-only Planning Scout. Do not modify files or create another
worktree.

Project instructions: {AGENTS.md or CLAUDE.md}
Project overview: {README.md}
Task: #{SEQ} {type}: {title}
Requirements:
- {each requirement}

Inspect the repository and return one Implementation Map containing:
- ownership decision;
- exact files/functions to modify or create;
- precise behavior changes;
- tests and commands to run.

Report uncertainty rather than inventing missing requirements.
```

A missing Implementation Map is a Scout failure. When the callback matches the
active dispatch, clear it before starting the Executor. For the initial Scout,
store the full map as both `originalImplementationMap` and
`currentImplementationMap`, and initialize `repairPassCount` to `0`.

### Execution Agent

Before dispatch, recheck that the checkout still matches the baseline. Sync
`executing`, dispatch the write-capable Execution Agent at Fast tier in the same
location, and record `{generation, stage: executor, id}`.

Prompt shape:

```text
You are a task Executor. Work only in {path}; do not create another worktree and
do not commit.

Task: #{SEQ} {type}: {title}
Requirements:
- {each requirement}

Implementation Map:
{full Scout output}

Follow the map, run its tests, and report files changed, tests run/results, and
any issue that prevented completion. Do not add unrelated refactors or features.
```

When the matching callback returns, clear `activeDispatch`, store the full
report as `lastExecutorReport`, recompute `ownedPaths` from the original
execution baseline, sync `awaiting_decision`, and show the completion menu from
`SKILL.md`. A zero-change result is a worker failure unless the user explicitly
confirms that no code change was required.

## Accept

Acceptance requires an empty `activeDispatch` and explicit user confirmation.

If Accept follows validation, first capture the same status/diff/untracked
snapshot and require equality with `validationSnapshot`. If it changed, do not
commit; offer validation again or Reject / Cancel.

For changed work:

1. Recheck execution path, branch, base commit, and `ownedPaths`.
2. Inspect staged paths and diff. Refuse acceptance if unrelated staged content
   is present; do not reset or unstage it.
3. Stage only owned paths:

   ```bash
   git add -- {owned_path_1} {owned_path_2} ...
   ```

4. Verify the cached path set and binary diff contain exactly the intended task
   work.
5. Commit:

   ```bash
   git commit -m "{type}: {title}"
   ```

6. Record the real completion time and commit SHA:

   ```bash
   $TASK_DB task update --project "$PROJECT" --seq "#{SEQ}" \
     --status completed --completed-at "YYYY-MM-DD HH:MM" --commit-sha {sha}
   ```

For explicitly accepted zero-change work, omit the commit and `--commit-sha`
but still record the real completion time.

After completion:

- run `task deps unblocked` and report newly unblocked tasks;
- if linked to a plan, use the task's returned `plan_seq` and `plan_project` to
  check `plan progress --counts`; offer closure only when total is nonzero and
  pending/in-progress/blocked are all zero;
- update `CHANGELOG.md` using `task-commands.md`;
- sync both task-list entries to completed.

## Failures and interruption

On Scout/Executor failure, timeout, interruption, missing map, or unexpected
zero-change output:

1. Request cancellation if the worker may still be active.
2. Set `cancellationRequested` before cancellation so later callbacks cannot
   mutate state.
3. Wait for a matching termination callback and clear `activeDispatch`.
4. Preserve partial work, keep the database task `in_progress`, and sync
   `awaiting_decision`.
5. Report whether task-owned changes are absent or partial, then present the
   normal completion menu. Do not clean up implicitly.

If termination cannot be verified, defer all decision actions and report that
the worker is still active.
