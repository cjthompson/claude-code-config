# Test: Changelog Generation from Completed Tasks

## Isolated database setup

Create and export a unique task store before running `commands/init.md` or any
helper command:

```bash
TEST_PROJECT_TASKS_HOME=$(mktemp -d "${TMPDIR:-/tmp}/project-tasks-changelog.XXXXXX")
export PROJECT_TASKS_HOME="$TEST_PROJECT_TASKS_HOME"
```

Then run the canonical initialization in `commands/init.md`; its database
initialization must use this exported temporary store.

Clean up only the exact directory returned by `mktemp` after the scenario. The
test must never use the default Claude/Codex task store, create `tasks.db` in the
worktree, invoke `sqlite3`, construct SQL, or inspect the database file.

Use project identifier `claude-monitor`. Seed the fixture exclusively through
the helper:

```bash
$TASK_DB task add --project "claude-monitor" --type fix \
  --title "Log lines should never exceed one line" --priority high \
  --tag "#ui" --req "Replace line breaks" --req "Trim whitespace" \
  --created "2026-03-04 14:30"
$TASK_DB task update --project "claude-monitor" --seq "#001" \
  --status completed --completed-at "2026-03-04 14:45"

$TASK_DB task add --project "claude-monitor" --type task \
  --title "Add keyboard shortcut to pause all panes" --priority medium \
  --tag "#keybindings" --tag "#ux" --req "Bind p key to toggle pause" \
  --req "Show PAUSED indicator" --created "2026-03-04 14:35"
$TASK_DB task update --project "claude-monitor" --seq "#002" \
  --status completed --completed-at "2026-03-04 15:10"

$TASK_DB task add --project "claude-monitor" --type todo \
  --title "Investigate memory leak in long-running sessions" --priority low \
  --tag "#performance" --req "Profile heap usage" \
  --req "Identify uncollected objects" --created "2026-03-04 15:30"

$TASK_DB task add --project "claude-monitor" --type fix \
  --title "Pane resize causes content to overlap" --priority high \
  --tag "#ui" --tag "#layout" --req "Fix resize handler" \
  --created "2026-03-03 09:00"
$TASK_DB task update --project "claude-monitor" --seq "#004" \
  --status completed --completed-at "2026-03-03 09:45"

$TASK_DB task add --project "claude-monitor" --type task \
  --title "Write integration tests for PaneManager" --priority medium \
  --tag "#testing" --req "Add integration tests" \
  --created "2026-03-03 10:00"
$TASK_DB task update --project "claude-monitor" --seq "#005" \
  --status completed --completed-at "2026-03-03 11:30"
```

`CHANGELOG.md` does not exist before the scenario.

## Scenario

The user says:

> Generate the changelog

## Expected behavior

1. The skill runs:

   ```bash
   $TASK_DB task changelog list --project "claude-monitor"
   ```

2. It creates `CHANGELOG.md` with exactly:

   ```markdown
   # Changelog

   ## 2026-03-04

   ### Fixes
   - Log lines should never exceed one line (#ui)

   ### Tasks
   - Add keyboard shortcut to pause all panes (#keybindings, #ux)

   ## 2026-03-03

   ### Fixes
   - Pane resize causes content to overlap (#ui, #layout)

   ### Tasks
   - Write integration tests for PaneManager (#testing)
   ```

3. The pending todo is excluded.
4. After successfully writing the file, the skill marks the returned completed
   tasks through the helper:

   ```bash
   $TASK_DB task changelog mark --project "claude-monitor" --all
   ```

5. Task status, requirements, tags, titles, and completion timestamps are not
   otherwise modified.

## Failure criteria

- **FAIL** if the isolated `PROJECT_TASKS_HOME` is not established before any
  helper command.
- **FAIL** if the default Claude/Codex task store or a repository-local database
  is used.
- **FAIL** if the skill invokes `sqlite3`, constructs SQL, or reads `tasks.db`.
- **FAIL** if full regeneration omits completed tasks, includes pending tasks,
  or fails to call `task changelog mark --all` after writing.
- **FAIL** if the changelog differs from the expected headings, ordering,
  titles, or tag formatting.
- **FAIL** if unrelated task fields change.

---

## Variant: Auto-update after task completion

### Setup

Use a fresh isolated store with the same helper-created fixture. Mark the older
tasks as already written:

```bash
$TASK_DB task changelog mark --project "claude-monitor" --seq 4 --seq 5
```

Create the existing `CHANGELOG.md` containing only the 2026-03-03 section.

### Scenario

A task completes and the skill auto-updates the changelog.

### Expected behavior

1. The skill requests only new entries:

   ```bash
   $TASK_DB task changelog list --project "claude-monitor" --new-only
   ```

2. It prepends the 2026-03-04 section without changing or duplicating the
   existing 2026-03-03 section.
3. After successfully writing the new entries, it marks only their sequences:

   ```bash
   $TASK_DB task changelog mark --project "claude-monitor" --seq 1 --seq 2
   ```

### Failure criteria

- **FAIL** if auto-update omits `--new-only`.
- **FAIL** if the existing section is duplicated or modified.
- **FAIL** if the newly written sequences are not marked through the helper.
- **FAIL** if already-written or pending task sequences are marked as new.
