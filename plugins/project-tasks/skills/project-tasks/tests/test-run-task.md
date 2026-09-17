# Test: Running a Task and Choosing a Completion Action

## Setup

The project contains `AGENTS.md`, `README.md`, and a pending task `#1`:

```text
fix: Log lines should never exceed one line
Requirements:
- Replace line breaks with a visible symbol
- Trim leading and trailing whitespace from each log line
```

The task store is accessed only through the resolved `$TASK_DB` helper. The
working tree is clean and contains one task, so direct execution is recommended.

## Scenario

The user says:

> run task #1

The skill checks dependencies, creates the TaskList entry, records the clean
baseline and direct execution context, and dispatches the default two-stage
pipeline. It does not call `sqlite3` directly.

## Expected Behavior

1. Run `$TASK_DB task get --project "..." --seq 1` and
   `$TASK_DB task deps check --project "..." --seq 1`.
2. Set the task `in_progress` and create the Scout/Execute TaskList entries.
3. Record path, branch, base commit, baseline snapshot, and later task-owned
   paths before dispatching write-capable work.
4. Dispatch a background read-only Planning Scout at the host's Strong tier.
5. Chain a background write-capable Execution Agent at the host's Fast tier.
6. Do not commit automatically from the Executor. When it completes, present:

   ```text
   a) Accept — mark complete and update changelog
   b) Validate with Strong tier — run a read-only verifier
   c) Validate with Top tier — run a read-only verifier
   d) Reject / Cancel — cancel the task and choose what happens to the work
   ```

7. Accept re-verifies ownership, stages only task-owned paths, commits, marks
   the task completed with timestamp and commit SHA, and performs the existing
   changelog/dependency/plan post-processing.
8. Validation is read-only and leaves the task `in_progress` until the user
   confirms a resulting Accept, Repair, Restart, or cancellation action.

## Dirty-Tree Variant

If the working tree is dirty, recommend an isolated worktree and do not dispatch
directly until the selected worktree is clean. If the user explicitly overrides
the recommendation, record the dirty baseline and warn that ownership-sensitive
Accept, Restart, Revert changes, or cleanup may be refused.

## Failure Criteria

- **FAIL** if the task is dispatched without the dependency check or baseline
  execution context.
- **FAIL** if raw database access bypasses `$TASK_DB`.
- **FAIL** if the default pipeline omits either background stage.
- **FAIL** if an automatic commit uses `git add -A`.
- **FAIL** if validation changes files, task status, or completion metadata.
- **FAIL** if the completion menu still contains Retry or literal provider model
  names.
- **FAIL** if a direct dirty-tree override promises safe cleanup without proving
  task ownership.

## Auto-Run All Variant

When the user selects `Auto-Run All` while logging a task, dispatch each
unblocked task independently without another execution-choice prompt. Each task
gets its own requirements, execution context, Scout, Executor, and completion
decision; one task's validation or cancellation must not alter another task.
