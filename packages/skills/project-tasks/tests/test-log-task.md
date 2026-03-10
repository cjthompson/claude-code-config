# Test: Task Logging to docs/TASKS.md

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

**docs/TASKS.md** does NOT exist yet (first task logged).

## Scenario

The user says:

> fix: Log lines should never exceed one line

## Expected Behavior

1. The skill creates `docs/TASKS.md` if it does not already exist.

2. The file begins with a top-level heading:
   ```
   # Tasks
   ```

3. A new task entry is appended with a horizontal rule separator before it:
   ```
   ---
   ```

4. The task entry heading uses the exact prefix from the user input (`fix:`) mapped to `## fix:` followed by the task title:
   ```
   ## fix: Log lines should never exceed one line
   ```

5. The metadata line contains today's date and time in `YYYY-MM-DD HH:MM` format, a priority field, and a tags field. Since the user did not specify priority or tags, sensible defaults are used:
   ```
   **Date:** 2026-03-04 HH:MM | **Priority:** medium | **Tags:** —
   ```
   - The time (`HH:MM`) must reflect the actual current time (not a placeholder).
   - Priority defaults to `medium` when unspecified.
   - Tags defaults to `—` (em dash) when unspecified.

6. The status line is set to pending:
   ```
   **Status:** pending
   ```

7. A `### Requirements` subsection is generated from the task title. The skill should infer at least one concrete requirement bullet. For this example, reasonable inferred requirements would be:
   ```
   ### Requirements
   - Replace line breaks with ↵ symbol or similar single-line representation
   - Trim leading/trailing whitespace from log lines
   ```

8. After writing the file, the skill presents a tri-modal choice to the user:
   ```
   a) Run Now
   b) Log Only
   c) Auto-Run All
   ```

9. If the user selects **b) Log Only**, no subagent is dispatched. The task remains with `**Status:** pending`.

## Failure Criteria

- **FAIL** if `docs/TASKS.md` is not created or is empty after the interaction.
- **FAIL** if the file does not start with `# Tasks`.
- **FAIL** if the task entry is missing the `---` separator before it.
- **FAIL** if the heading does not match the format `## fix: Log lines should never exceed one line`.
- **FAIL** if the `**Date:**` value is missing or not in `YYYY-MM-DD HH:MM` format.
- **FAIL** if the `**Priority:**` field is absent.
- **FAIL** if the `**Status:**` field is absent or not set to `pending` after choosing "Log Only".
- **FAIL** if the `### Requirements` section is missing or contains zero bullet items.
- **FAIL** if the tri-modal choice (`a/b/c`) is not presented to the user after logging.
- **FAIL** if selecting "Log Only" triggers a subagent dispatch.

---

## Variant: Appending to an Existing TASKS.md

### Setup (Variant)

**docs/TASKS.md** already exists with one prior entry:
```markdown
# Tasks

---

## task: Add keyboard shortcut to pause all panes
**Date:** 2026-03-03 10:00 | **Priority:** low | **Tags:** #keybindings, #ux
**Status:** completed (2026-03-03 11:30)

### Requirements
- Bind `p` key to toggle pause on all visible panes
- Show "PAUSED" indicator in status bar

---
```

### Scenario (Variant)

The user says:

> todo: Add unit tests for the scroll buffer module

### Expected Behavior (Variant)

1. The new entry is **prepended** (inserted after `# Tasks` but before existing entries) so newest tasks appear first.
2. The existing entry remains unmodified.
3. The new entry uses `## todo:` as the heading prefix.
4. The file now contains exactly two task entries separated by `---` lines, with the new `todo:` entry appearing before the existing `task:` entry.

### Failure Criteria (Variant)

- **FAIL** if the existing task entry is modified, removed, or reordered.
- **FAIL** if the new entry appears after the existing one (it should be prepended, not appended).
- **FAIL** if the heading prefix is not `## todo:` (must match the user's input prefix).
- **FAIL** if there are fewer than two `---` separators in the final file (one before each entry).
