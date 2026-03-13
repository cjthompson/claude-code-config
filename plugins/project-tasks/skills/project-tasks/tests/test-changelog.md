# Test: Changelog Generation from Completed Tasks

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

The database `~/.claude/tasks.db` contains these rows for this project:

```sql
INSERT INTO tasks(project,seq,type,title,priority,status,tags,reqs,created,updated,in_changelog) VALUES
('claude-monitor',1,'fix','Log lines should never exceed one line','high','completed','["#ui"]','["Replace line breaks","Trim whitespace"]','2026-03-04 14:30','2026-03-04 14:45',0),
('claude-monitor',2,'task','Add keyboard shortcut to pause all panes','medium','completed','["#keybindings","#ux"]','["Bind p key to toggle pause","Show PAUSED indicator"]','2026-03-04 14:35','2026-03-04 15:10',0),
('claude-monitor',3,'todo','Investigate memory leak in long-running sessions','low','pending','["#performance"]','["Profile heap usage","Identify un-GCd objects"]','2026-03-04 15:30',NULL,0),
('claude-monitor',4,'fix','Pane resize causes content to overlap','high','completed','["#ui","#layout"]','["Fix resize handler"]','2026-03-03 09:00','2026-03-03 09:45',0),
('claude-monitor',5,'task','Write integration tests for PaneManager','medium','completed','["#testing"]','["Add integration tests"]','2026-03-03 10:00','2026-03-03 11:30',0);
```

**CHANGELOG.md** does NOT exist yet (first changelog generation).

## Scenario

The user says:

> Generate the changelog

## Expected Behavior

1. The skill queries all completed tasks (`status='completed'`) from the database, ordered by completion date descending.

2. The skill creates `CHANGELOG.md` at the project root.

3. The full expected output of `CHANGELOG.md` is:
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

4. Pending tasks (like "Investigate memory leak") are NOT included.

5. After writing the changelog, the skill updates `in_changelog=1` for all completed tasks.

6. The tasks table rows are not otherwise modified during changelog generation.

## Failure Criteria

- **FAIL** if `CHANGELOG.md` is not created at the project root.
- **FAIL** if the file does not start with `# Changelog`.
- **FAIL** if completed tasks are not grouped by completion date.
- **FAIL** if dates are not sorted newest first.
- **FAIL** if tasks within a date are not grouped under the correct type heading (`### Fixes`, `### Tasks`, `### Todos`).
- **FAIL** if the type prefix (e.g., `fix:`) appears in the bullet point title.
- **FAIL** if tags are missing from entries that have tags.
- **FAIL** if tags JSON is not parsed correctly (e.g. raw `["#ui"]` instead of `(#ui)`).
- **FAIL** if a pending task appears in the changelog.
- **FAIL** if `in_changelog` is not set to `1` after writing.
- **FAIL** if the type section ordering within a date is not Fixes, Tasks, Todos.

---

## Variant: Auto-Update After Task Completion

### Setup (Variant)

**CHANGELOG.md** already exists with previous entries:
```markdown
# Changelog

## 2026-03-03

### Fixes
- Pane resize causes content to overlap (#ui, #layout)

### Tasks
- Write integration tests for PaneManager (#testing)
```

The tasks from 2026-03-03 have `in_changelog=1`. The tasks from 2026-03-04 have `in_changelog=0`.

### Scenario (Variant)

A task completes and the skill auto-updates the changelog.

### Expected Behavior (Variant)

1. The skill queries only `WHERE in_changelog=0 AND status='completed'` — it does NOT re-read all completed tasks.
2. The new date section (`## 2026-03-04`) is added above the existing `## 2026-03-03` section.
3. The existing `## 2026-03-03` section remains unchanged.
4. After writing, `in_changelog` is set to `1` for the newly added tasks.

### Failure Criteria (Variant)

- **FAIL** if the skill queries all completed tasks instead of only `in_changelog=0`.
- **FAIL** if the existing `## 2026-03-03` section is duplicated or modified.
- **FAIL** if `in_changelog` is not updated for the newly written tasks.
