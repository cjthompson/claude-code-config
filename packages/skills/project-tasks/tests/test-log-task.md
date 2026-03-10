# Test: Task Logging to SQLite

## Setup

The following files exist in the project root:

**CLAUDE.md**
```markdown
# Claude Monitor

A terminal multiplexer monitor built with Ink (React for CLI).

## Commands
- `npm run dev` — start in development mode
- `npm run build` — compile TypeScript
- `npm run test` — run test suite
```

**README.md**
```markdown
# claude-monitor
Real-time terminal multiplexer monitor. Displays pane output, handles scrolling, and supports keyboard shortcuts.
```

The database `~/.claude/tasks.db` has no existing rows for this project.

## Scenario

The user says:

> fix: Log lines should never exceed one line

## Expected Behavior

1. The skill runs the prerequisite steps: checks `sqlite3` availability, runs `CREATE TABLE IF NOT EXISTS`, and determines the project identifier.

2. A new row is inserted into the `tasks` table with:
   - `type` = `fix`
   - `title` = `Log lines should never exceed one line`
   - `priority` = `high` (fix prefix defaults to high)
   - `status` = `pending`
   - `tags` = `[]`
   - `reqs` = a JSON array with at least one concrete requirement string
   - `created` = current date/time in `YYYY-MM-DD HH:MM` format
   - `seq` = `1` (first task in this project)

3. The INSERT and SELECT are combined in a single `sqlite3` invocation to retrieve the assigned ID via `last_insert_rowid()`.

4. The skill reports the assigned ID (`#001`) to the user.

5. The skill presents a tri-modal choice:
   ```
   a) Run Now
   b) Log Only
   c) Auto-Run All
   ```

6. If the user selects **b) Log Only**, no subagent is dispatched. The task remains `pending`.

## Failure Criteria

- **FAIL** if `sqlite3` prerequisite check is skipped.
- **FAIL** if `CREATE TABLE IF NOT EXISTS` is not run.
- **FAIL** if the project identifier is not determined before the INSERT.
- **FAIL** if single quotes in user input are not escaped (doubled) in the SQL.
- **FAIL** if the INSERT and ID retrieval use separate `sqlite3` invocations (breaks `last_insert_rowid()`).
- **FAIL** if `priority` is not `high` for a `fix:` prefix.
- **FAIL** if `reqs` is empty or not a valid JSON array.
- **FAIL** if `created` is missing or not in `YYYY-MM-DD HH:MM` format.
- **FAIL** if the tri-modal choice (`a/b/c`) is not presented after logging.
- **FAIL** if selecting "Log Only" triggers a subagent dispatch.

---

## Variant: Second Task in Same Project

### Setup (Variant)

The database already has one row for this project:

```sql
INSERT INTO tasks(project,seq,type,title,priority,status,tags,reqs,created)
VALUES('claude-monitor',1,'task','Add keyboard shortcut to pause all panes','low','completed','["#keybindings","#ux"]','["Bind p key to toggle pause","Show PAUSED indicator"]','2026-03-03 10:00');
```

### Scenario (Variant)

The user says:

> todo: Add unit tests for the scroll buffer module

### Expected Behavior (Variant)

1. The new task gets `seq` = `2` (auto-incremented from max existing seq).
2. The `type` is `todo`.
3. The existing row is not modified.
4. Since the prefix is `todo:`, the execution choice is **not** presented — the skill simply confirms the todo was logged.

### Failure Criteria (Variant)

- **FAIL** if `seq` is not `2`.
- **FAIL** if the existing task row is modified in any way.
- **FAIL** if the heading prefix is not `todo`.
- **FAIL** if an execution choice is presented for a `todo:` prefix.
