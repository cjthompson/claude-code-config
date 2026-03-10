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

The database `~/.claude/tasks.db` contains this pending task:

```sql
INSERT INTO tasks(project,seq,type,title,priority,status,tags,reqs,created)
VALUES('claude-monitor',1,'fix','Log lines should never exceed one line','high','pending','["#ui"]','["Replace line breaks with ↵ symbol","Trim leading/trailing whitespace from each log line before display","Ensure truncation applies before the line is written to ScrollBuffer"]','2026-03-04 14:30');
```

**src/services/ScrollBuffer.ts** exists (the file the subagent would need to modify).

## Scenario

The user says:

> fix: Log lines should never exceed one line

The skill detects this matches the pending task. It presents the tri-modal choice. The user selects:

> a) Run Now

## Expected Behavior

1. The skill queries the task from the database:
   ```bash
   sqlite3 ~/.claude/tasks.db -json "SELECT seq,type,title,priority,tags,reqs FROM tasks WHERE project='$P' AND seq=1;"
   ```

2. The skill updates status to `in_progress`:
   ```bash
   sqlite3 ~/.claude/tasks.db "UPDATE tasks SET status='in_progress',updated='...' WHERE project='$P' AND seq=1;"
   ```

3. The skill dispatches a subagent with a **minimal context payload** containing ONLY:
   - The contents of `CLAUDE.md`
   - The contents of `README.md`
   - The task requirements extracted from the `reqs` JSON array:
     ```
     fix: Log lines should never exceed one line

     Requirements:
     - Replace line breaks with ↵ symbol
     - Trim leading/trailing whitespace from each log line before display
     - Ensure truncation applies before the line is written to ScrollBuffer
     ```

4. The subagent does NOT receive:
   - The full tasks database or any SQL queries
   - Any other source files pre-loaded (it must discover and read them itself)
   - Chat history or conversation context from the parent session

5. The subagent executes the task autonomously — it reads the necessary source files, makes edits, and runs verification commands.

6. Upon subagent completion, the skill presents the Accept/Retry choice. If accepted:
   - Status is updated to `completed` with the actual completion timestamp
   - Changes are committed via `git add -A && git commit`
   - Changelog is auto-updated

7. The skill reports a summary of what the subagent did back to the user.

## Failure Criteria

- **FAIL** if a subagent is not dispatched when the user selects "Run Now".
- **FAIL** if the subagent receives files beyond CLAUDE.md, README.md, and the task requirements.
- **FAIL** if the subagent receives the parent session's chat history.
- **FAIL** if the task status is not updated to `in_progress` before dispatch.
- **FAIL** if the task status is not updated to `completed` after acceptance.
- **FAIL** if the completion timestamp is missing or not in `YYYY-MM-DD HH:MM` format.
- **FAIL** if no summary of subagent actions is reported back to the user.
- **FAIL** if the subagent is given raw database content (it should only get the extracted requirements).

---

## Variant: Auto-Run All Mode

### Setup (Variant)

Same as above, but the database contains two pending tasks:

```sql
INSERT INTO tasks(project,seq,type,title,priority,status,tags,reqs,created) VALUES
('claude-monitor',1,'fix','Log lines should never exceed one line','high','pending','["#ui"]','["Replace line breaks with ↵ symbol","Trim whitespace"]','2026-03-04 14:30'),
('claude-monitor',2,'task','Add keyboard shortcut to pause all panes','medium','pending','["#keybindings","#ux"]','["Bind p key to toggle pause","Show PAUSED indicator","Resume on second press"]','2026-03-04 14:35');
```

### Scenario (Variant)

The user says:

> fix: Log lines should never exceed one line

The skill presents the tri-modal choice. The user selects:

> c) Auto-Run All

### Expected Behavior (Variant)

1. The first task is dispatched to a subagent immediately.
2. After the first subagent completes, the second task is dispatched automatically without prompting.
3. Each subagent receives only CLAUDE.md + README.md + its own task requirements.
4. Both tasks are updated to `completed` after their respective subagents finish and are accepted.
5. The user receives a summary for each completed task.

### Failure Criteria (Variant)

- **FAIL** if the user is prompted again between task executions after selecting "Auto-Run All".
- **FAIL** if both tasks are sent to the same subagent.
- **FAIL** if either task remains `pending` after both subagents complete and are accepted.
- **FAIL** if a subagent for one task receives the requirements of the other task.
