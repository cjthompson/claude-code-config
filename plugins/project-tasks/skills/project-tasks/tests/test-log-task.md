# Test: Task Logging through task-db

## Isolated database setup

Create and export a unique task store before running `commands/init.md` or any
helper command:

```bash
TEST_PROJECT_TASKS_HOME=$(mktemp -d "${TMPDIR:-/tmp}/project-tasks-log.XXXXXX")
export PROJECT_TASKS_HOME="$TEST_PROJECT_TASKS_HOME"
```

Then run the canonical initialization in `commands/init.md`; its database
initialization must use this exported temporary store.

Clean up only the exact directory returned by `mktemp` after the scenario. The
test must never use the default Claude/Codex task store, create `tasks.db` in the
worktree, invoke `sqlite3`, construct SQL, or inspect the database file.

Use project identifier `claude-monitor`.

## Scenario

The user says:

> fix: Log lines should never exceed one line

## Expected behavior

1. Isolation is established before initialization or task commands.
2. The skill interprets at least one concrete requirement and adds the task
   through the helper, equivalent to:

   ```bash
   $TASK_DB task add --project "claude-monitor" --type fix \
     --title "Log lines should never exceed one line" --priority high \
     --req "Replace line breaks with spaces and trim surrounding whitespace"
   ```

3. The helper returns `#001`, which the skill reports to the user.
4. `$TASK_DB task get --project "claude-monitor" --seq "#001"` shows:
   - `type`: `fix`
   - `title`: `Log lines should never exceed one line`
   - `priority`: `high`
   - `status`: `pending`
   - at least one concrete requirement
5. The skill presents:

   ```text
   a) Run Now
   b) Log Only
   c) Auto-Run All
   ```

6. If the user selects Log Only, no subagent is dispatched and the task remains
   pending.

## Failure criteria

- **FAIL** if `PROJECT_TASKS_HOME` is not redirected to the unique temporary
  directory before `$TASK_DB db init` or any task command.
- **FAIL** if the default Claude/Codex task store or a repository-local database
  is used.
- **FAIL** if the skill invokes `sqlite3`, constructs SQL, or reads `tasks.db`.
- **FAIL** if the task is not created with `$TASK_DB task add`.
- **FAIL** if the assigned helper ID is not reported.
- **FAIL** if `priority` is not `high` for a `fix:` prefix.
- **FAIL** if the task has no concrete requirement.
- **FAIL** if the tri-modal choice is not presented.
- **FAIL** if Log Only dispatches a subagent or changes the pending status.

---

## Variant: Second task in a fresh isolated store

### Setup

Create a new unique `mktemp` task store, export it before `db init`, and seed the
first task through the helper, never through SQL:

```bash
$TASK_DB task add --project "claude-monitor" --type task \
  --title "Add keyboard shortcut to pause all panes" --priority low \
  --tag "#keybindings" --tag "#ux" \
  --req "Bind p key to toggle pause" --req "Show PAUSED indicator"
$TASK_DB task update --project "claude-monitor" --seq "#001" \
  --status completed --completed-at "2026-03-03 10:00"
```

### Scenario

The user says:

> todo: Add unit tests for the scroll buffer module

### Expected behavior

1. `$TASK_DB task add` returns `#002`.
2. The new task type is `todo` and its status is `pending`.
3. Task `#001` remains unchanged.
4. The skill confirms the todo was logged without presenting an execution
   choice.

### Failure criteria

- **FAIL** if the helper does not assign `#002` in the fresh isolated store.
- **FAIL** if task `#001` is modified.
- **FAIL** if the new task type is not `todo`.
- **FAIL** if an execution choice is presented for `todo:`.
