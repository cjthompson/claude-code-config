# Test: Subagent Dispatch for Task Execution

## Setup

The following files exist in the project root:

**CLAUDE.md**
```markdown
# Claude Monitor

A terminal multiplexer monitor built with Ink (React for CLI).

## Project Structure
- `src/components/` — React/Ink UI components
- `src/services/` — business logic (PaneManager, ScrollBuffer)
- `src/index.ts` — entry point

## Commands
- `npm run dev` — start in development mode
- `npm run build` — compile TypeScript
- `npm run test` — run test suite

## Conventions
- All components use functional React with hooks
- Log output is stored in ScrollBuffer (ring buffer, max 10k lines)
- Never mutate pane state directly; use PaneManager methods
```

**README.md**
```markdown
# claude-monitor
Real-time terminal multiplexer monitor. Displays pane output, handles scrolling, and supports keyboard shortcuts.

## Install
npm install && npm run build

## Usage
npx claude-monitor --config ./monitor.yml
```

**docs/TASKS.md** already exists with the task to be run:
```markdown
# Tasks

---

## fix: Log lines should never exceed one line
**Date:** 2026-03-04 14:30 | **Priority:** high | **Tags:** #ui
**Status:** pending

### Requirements
- Replace line breaks with ↵ symbol
- Trim leading/trailing whitespace from each log line before display
- Ensure truncation applies before the line is written to ScrollBuffer

---
```

**src/services/ScrollBuffer.ts** exists (the file the subagent would need to modify).

## Scenario

The user says:

> fix: Log lines should never exceed one line

The skill detects this matches the pending task in `docs/TASKS.md`. It presents the tri-modal choice. The user selects:

> a) Run Now

## Expected Behavior

1. The skill dispatches a subagent to execute the task.

2. The subagent receives a **minimal context payload** containing ONLY:
   - The contents of `CLAUDE.md`
   - The contents of `README.md`
   - The task requirements extracted from `docs/TASKS.md`:
     ```
     fix: Log lines should never exceed one line

     Requirements:
     - Replace line breaks with ↵ symbol
     - Trim leading/trailing whitespace from each log line before display
     - Ensure truncation applies before the line is written to ScrollBuffer
     ```

3. The subagent does NOT receive:
   - The full `docs/TASKS.md` file
   - Any other source files pre-loaded (it must discover and read them itself)
   - Chat history or conversation context from the parent session

4. The subagent executes the task autonomously — it reads the necessary source files, makes edits, and (if applicable) runs verification commands like `npm run build` or `npm run test`.

5. Upon subagent completion, the skill updates `docs/TASKS.md` to reflect completion:
   ```
   **Status:** completed (2026-03-04 HH:MM)
   ```
   - The completion timestamp must be the actual time the subagent finished.
   - The `pending` status is replaced, not appended to.

6. The skill reports a summary of what the subagent did back to the user, including:
   - Which files were modified
   - A brief description of changes made
   - Whether build/tests passed (if the subagent ran them)

## Failure Criteria

- **FAIL** if a subagent is not dispatched when the user selects "Run Now".
- **FAIL** if the subagent receives files beyond CLAUDE.md, README.md, and the task requirements in its initial context. The subagent must operate with minimal context and discover other files on its own.
- **FAIL** if the subagent receives the parent session's chat history or prior conversation turns.
- **FAIL** if `docs/TASKS.md` still shows `**Status:** pending` after the subagent completes successfully.
- **FAIL** if the completion status does not follow the format `completed (YYYY-MM-DD HH:MM)`.
- **FAIL** if no summary of subagent actions is reported back to the user.
- **FAIL** if the subagent is given the full TASKS.md file (it should only get the specific task's requirements).

---

## Variant: Auto-Run All Mode

### Setup (Variant)

Same as above, but `docs/TASKS.md` contains two pending tasks:

```markdown
# Tasks

---

## fix: Log lines should never exceed one line
**Date:** 2026-03-04 14:30 | **Priority:** high | **Tags:** #ui
**Status:** pending

### Requirements
- Replace line breaks with ↵ symbol
- Trim leading/trailing whitespace from each log line before display
- Ensure truncation applies before the line is written to ScrollBuffer

---

## task: Add keyboard shortcut to pause all panes
**Date:** 2026-03-04 14:35 | **Priority:** medium | **Tags:** #keybindings, #ux
**Status:** pending

### Requirements
- Bind `p` key to toggle pause on all visible panes
- Show "PAUSED" indicator in the status bar when paused
- Resume output streaming on second press of `p`

---
```

### Scenario (Variant)

The user says:

> fix: Log lines should never exceed one line

The skill presents the tri-modal choice. The user selects:

> c) Auto-Run All

### Expected Behavior (Variant)

1. The first task ("Log lines should never exceed one line") is dispatched to a subagent immediately.
2. After the first subagent completes, the second task ("Add keyboard shortcut to pause all panes") is dispatched to a new subagent automatically, without prompting the user.
3. Each subagent receives only CLAUDE.md + README.md + its own task requirements (not the other task's requirements).
4. Both tasks are updated to `completed` status in `docs/TASKS.md` after their respective subagents finish.
5. The user receives a summary for each completed task.

### Failure Criteria (Variant)

- **FAIL** if the user is prompted again between task executions after selecting "Auto-Run All".
- **FAIL** if both tasks are sent to the same subagent (each task must get its own subagent with isolated minimal context).
- **FAIL** if either task remains `pending` after both subagents complete.
- **FAIL** if a subagent for one task receives the requirements of the other task.
