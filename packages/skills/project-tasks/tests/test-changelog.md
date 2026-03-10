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

**docs/TASKS.md** exists with a mix of completed and pending tasks:
```markdown
# Tasks

---

## fix: Log lines should never exceed one line
**Date:** 2026-03-04 14:30 | **Priority:** high | **Tags:** #ui
**Status:** completed (2026-03-04 14:45)

### Requirements
- Replace line breaks with ↵ symbol
- Trim leading/trailing whitespace from each log line before display
- Ensure truncation applies before the line is written to ScrollBuffer

---

## task: Add keyboard shortcut to pause all panes
**Date:** 2026-03-04 14:35 | **Priority:** medium | **Tags:** #keybindings, #ux
**Status:** completed (2026-03-04 15:10)

### Requirements
- Bind `p` key to toggle pause on all visible panes
- Show "PAUSED" indicator in the status bar when paused
- Resume output streaming on second press of `p`

---

## todo: Investigate memory leak in long-running sessions
**Date:** 2026-03-04 15:30 | **Priority:** low | **Tags:** #performance
**Status:** pending

### Requirements
- Profile heap usage over 30-minute session
- Identify objects that are not being garbage collected
- Document findings in a comment on this task

---

## fix: Pane resize causes content to overlap
**Date:** 2026-03-03 09:00 | **Priority:** high | **Tags:** #ui, #layout
**Status:** completed (2026-03-03 09:45)

---

## task: Write integration tests for PaneManager
**Date:** 2026-03-03 10:00 | **Priority:** medium | **Tags:** #testing
**Status:** completed (2026-03-03 11:30)

---
```

**docs/CHANGELOG.md** does NOT exist yet (first changelog generation).

## Scenario

The user says:

> Generate the changelog

## Expected Behavior

1. The skill scans `docs/TASKS.md` and identifies all tasks with `**Status:** completed (...)`.

2. The skill creates `docs/CHANGELOG.md` starting with:
   ```
   # Changelog
   ```

3. Completed tasks are grouped by their completion date (from the `completed (YYYY-MM-DD ...)` timestamp), with the most recent date first:
   ```
   ## 2026-03-04

   ...

   ## 2026-03-03

   ...
   ```

4. Within each date, tasks are grouped by their type prefix (`fix:` -> `### Fixes`, `task:` -> `### Tasks`, `todo:` -> `### Todos`). The ordering of type sections within a date follows: Fixes, then Tasks, then Todos.

5. Each completed task appears as a bullet point with its title and tags:
   ```
   - Log lines should never exceed one line (#ui)
   ```
   - The type prefix (`fix:`, `task:`, `todo:`) is stripped from the title.
   - Tags are included in parentheses at the end, comma-separated, with the `#` preserved.
   - If a task has no tags, no parenthetical is appended.

6. The full expected output of `docs/CHANGELOG.md` is:
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

7. Pending tasks (like "Investigate memory leak in long-running sessions") are NOT included in the changelog.

8. The skill does not modify `docs/TASKS.md` during changelog generation.

## Failure Criteria

- **FAIL** if `docs/CHANGELOG.md` is not created.
- **FAIL** if the file does not start with `# Changelog`.
- **FAIL** if completed tasks are not grouped by completion date.
- **FAIL** if dates are not sorted in reverse chronological order (most recent first).
- **FAIL** if tasks within a date are not grouped under the correct type heading (`### Fixes`, `### Tasks`, `### Todos`).
- **FAIL** if the type prefix (e.g., `fix:`) appears in the bullet point title.
- **FAIL** if tags are missing from entries that have tags in TASKS.md.
- **FAIL** if a pending task appears in the changelog.
- **FAIL** if `docs/TASKS.md` is modified as a side effect of changelog generation.
- **FAIL** if the type section ordering within a date is not Fixes, Tasks, Todos.

---

## Variant: Updating an Existing Changelog

### Setup (Variant)

**docs/CHANGELOG.md** already exists from a previous generation:
```markdown
# Changelog

## 2026-03-03

### Fixes
- Pane resize causes content to overlap (#ui, #layout)

### Tasks
- Write integration tests for PaneManager (#testing)
```

**docs/TASKS.md** is the same as in the primary setup (contains both 2026-03-03 and 2026-03-04 completed tasks).

### Scenario (Variant)

The user says:

> Generate the changelog

### Expected Behavior (Variant)

1. The skill detects that `docs/CHANGELOG.md` already exists.
2. The new date section (`## 2026-03-04`) is added above the existing `## 2026-03-03` section.
3. The existing `## 2026-03-03` section remains unchanged — it is not duplicated or rewritten.
4. The final file contains both date sections in reverse chronological order.

### Failure Criteria (Variant)

- **FAIL** if the existing `## 2026-03-03` section is duplicated (appears twice).
- **FAIL** if the existing `## 2026-03-03` section content is modified from its original form.
- **FAIL** if the `## 2026-03-04` section does not appear before the `## 2026-03-03` section.
- **FAIL** if any completed task from 2026-03-04 is missing from the new date section.
