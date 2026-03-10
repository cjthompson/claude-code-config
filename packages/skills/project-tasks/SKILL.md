---
name: project-tasks
description: Use when the user says "task:", "fix:", "todo:", or asks to log, run, list, or manage project tasks. Also use when asked to generate or update a changelog from completed tasks.
TRIGGER when: user message starts with "task:", "fix:", or "todo:" (these are definitive triggers — always invoke this skill). Also trigger when user says "list tasks", "run task", "run all tasks", "update changelog", or "generate changelog".
DO NOT TRIGGER when: user is asking a general question about tasks/todos unrelated to project management.
model: haiku
---

# Project Tasks

## Overview

Capture small tasks and fixes to a SQLite database (`~/.claude/tasks.db`) and execute them cheaply via minimal-context subagents. Auto-generate `CHANGELOG.md` from completed work.

**Core principle:** The lead agent is always available. Every task — even a single one — is dispatched to a subagent so the user can keep issuing commands.

## When to Use

- User says `task: <description>`, `fix: <description>`, or `todo: <description>`
- User asks to "list tasks", "run task #NNN", "run all tasks"
- User asks to "complete task", "mark completed", "cancel task", "set priority", "check task"
- User asks to "update changelog" or "generate changelog"

## Prerequisites

Run these steps at the start of **every** skill invocation, before any other operation:

1. Check sqlite3 is available:
```bash
command -v sqlite3 >/dev/null 2>&1 || echo "ERROR: sqlite3 is required but not installed"
```
If missing, inform the user and stop.

2. Initialize the database (idempotent):
```bash
sqlite3 ~/.claude/tasks.db "CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,project TEXT NOT NULL,seq INTEGER NOT NULL,type TEXT NOT NULL CHECK(type IN('fix','task','todo')),title TEXT NOT NULL,priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN('high','medium','low')),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','in_progress','completed','cancelled')),tags TEXT DEFAULT '[]',reqs TEXT DEFAULT '[]',depends_on TEXT DEFAULT '[]',created TEXT NOT NULL,updated TEXT,in_changelog INTEGER NOT NULL DEFAULT 0,UNIQUE(project,seq));"
```

Then add the `depends_on` column if it doesn't exist (for databases created before this feature):
```bash
sqlite3 ~/.claude/tasks.db "ALTER TABLE tasks ADD COLUMN depends_on TEXT DEFAULT '[]';" 2>/dev/null
```

3. Determine the project identifier:
```bash
git remote get-url origin 2>/dev/null | sed 's/\.git$//' || basename "$(git rev-parse --show-toplevel)"
```
Store this value as `$P` for all subsequent queries. **Escape single quotes** in `$P` by doubling them (`'` → `''`).

## Logging a Task

When the user provides a task/fix/todo prefix:

1. **Parse the message** — extract the title (everything after the prefix), tags (any `#word` in the message), dependencies, and infer priority.

   **Dependencies:** If the message contains `(depends on #NNN)` or `(depends on #NNN, #NNN)`, extract the seq numbers as a JSON array (e.g. `[3, 5]`) and remove the parenthetical from the title. If no dependencies, use `[]`.

   **Priority:**
   - `high` — bugs, crashes, data loss, security issues, broken functionality. **`fix:` prefix defaults to `high`.**
   - `medium` — features, UX improvements, enhancements. **`task:` and `todo:` default to `medium`.**
   - `low` — cosmetic changes, nice-to-have, cleanup, documentation

2. **Interpret requirements** — infer concrete action items from the description.

   **Proceed directly if the description includes ANY of:**
   - A specific file, function, variable, component, or UI element name
   - A concrete action with a clear target (e.g. "rename X to Y", "remove the X button")
   - Explicit step-by-step instructions from the user

   **Propose an interpretation if the description:**
   - Contains no specific code, file, or component reference
   - Is 5 words or fewer after the prefix
   - Uses a vague action word with no clear target

   If proposing, use AskUserQuestion before logging:

   > Here's how I interpreted this task:
   > - {inferred requirement 1}
   > - {inferred requirement 2}
   >
   > a) Accept — log with these requirements
   > b) Change — describe what's different

   Repeat until accepted.

3. **Insert the task.** Escape single quotes in all user-provided values by doubling them (`'` → `''`). Build tags as a JSON array like `["#ui","#layout"]` (use `[]` if none). Build reqs as a JSON array like `["requirement 1","requirement 2"]`. Build depends_on as a JSON array of seq numbers like `[3,5]` (use `[]` if none).

```bash
sqlite3 ~/.claude/tasks.db "INSERT INTO tasks(project,seq,type,title,priority,tags,reqs,depends_on,created) VALUES('$P',(SELECT COALESCE(MAX(seq),0)+1 FROM tasks WHERE project='$P'),'fix','Log lines shouldn''t exceed one line','high','[]','[\"Replace line breaks\",\"Trim whitespace\"]','[]','2026-03-10 14:30'); SELECT printf('#%03d',seq) FROM tasks WHERE id=last_insert_rowid();"
```

The output is the assigned task ID (e.g. `#001`). Report it to the user.

   If the task has dependencies, validate they exist:
   ```bash
   sqlite3 ~/.claude/tasks.db "SELECT j.value FROM json_each('$DEPS_JSON') j WHERE j.value NOT IN (SELECT seq FROM tasks WHERE project='$P');"
   ```
   If any rows are returned, warn the user that those task IDs don't exist in this project (e.g. `Warning: #999 does not exist`). The task is still logged but the user should fix the dependency.

4. **Determine execution behavior** based on the prefix:

   - **`todo:` prefix** — skip the execution choice entirely. Inform the user the todo was logged.
   - **`task:` or `fix:` prefix** — present the execution choice using AskUserQuestion:

```
a) Run Now — dispatch a subagent immediately
b) Log Only — save for later
c) Auto-Run All — run this and all future tasks without asking
```

If the user previously chose "Auto-Run All" in this session, skip asking and dispatch immediately.

## Running a Task

**Core principle: The lead agent NEVER blocks on task execution.** Every task is dispatched to a subagent so the lead agent stays available.

When dispatching a task (via "Run Now", "run task #NNN", or "Auto-Run All"):

### Step 0: Check Dependencies

If the task has dependencies (`depends_on` is not `[]`), check whether all dependencies are completed:
```bash
sqlite3 ~/.claude/tasks.db "SELECT printf('#%03d',seq),title,status FROM tasks WHERE project='$P' AND seq IN (SELECT j.value FROM tasks t,json_each(t.depends_on) j WHERE t.project='$P' AND t.seq=$N) AND status!='completed';"
```

If any rows are returned, the task is **blocked**. Report the incomplete dependencies to the user and do NOT dispatch. Example:
> Task #005 is blocked. These dependencies must be completed first:
> - #003 (pending): Create settings modal skeleton
> - #004 (in_progress): Add theme support

### Step 1: Recommend Isolation Strategy

- **Dirty working tree** (unstaged/uncommitted changes) → recommend worktree
- **Multiple pending tasks** being run together → recommend worktree
- **Clean tree + single task** → recommend direct (current directory)

Present recommendation with brief reasoning. Let user override.

### Step 2: Dispatch Task Runner Subagent

First, read the task data:
```bash
sqlite3 ~/.claude/tasks.db -json "SELECT seq,type,title,priority,tags,reqs,depends_on FROM tasks WHERE project='$P' AND seq=$N;"
```

Update status to in_progress:
```bash
sqlite3 ~/.claude/tasks.db "UPDATE tasks SET status='in_progress',updated='2026-03-10 14:35' WHERE project='$P' AND seq=$N;"
```

Dispatch a **single subagent** using the Agent tool with `subagent_type: "general-purpose"`. If worktree was chosen, add `isolation: "worktree"`.

Task Runner prompt — extract `type`, `title`, and each element of the `reqs` JSON array to build this:

```
You are a task runner. You will scout the codebase, implement changes, and report results.
You are working on the project at {repo_root}.

## Project Context
{Read and paste the full contents of CLAUDE.md here, if it exists}

## Project Overview
{Read and paste the full contents of README.md here}

## Task
{type}: {title}

### Requirements
- {reqs[0]}
- {reqs[1]}

{If this is a retry, include:}
## Retry Notes
A previous attempt was rejected. User feedback: {feedback}

## Phase 1: Scout (read-only)
Do NOT write any code yet. First, map the codebase:
1. Use Glob to find all files relevant to this task.
2. Use Read to read every relevant file — including ones not explicitly mentioned
   in Requirements but logically impacted.
3. Produce an Implementation Map with this exact format:

### Files to Modify
- **{relative/path/file.ts}** — {one-line summary of change}
  - Location: `{function name}` (line ~{N})
  - Change: {precise description}

### Files to Create
- **{relative/path/file.md}** — {one-line summary}
  - Content: {description of what the file must contain}

### No Changes Needed
- {file you read but determined needs no modification}

## Phase 2: Execute
Now implement using your Implementation Map:
1. Use Read to read each file listed under "Files to Modify".
2. Make exactly the changes described for each file.
3. Create any files listed under "Files to Create".
4. Use Bash to run existing tests. Check README for the test command if unsure.

## Phase 3: Report
Output a structured summary:
- **Files changed:** list each file and what was done
- **Tests:** passed / failed / none found
- **Commit:** none yet (pending Accept)
- **Issues:** any problems encountered

## Rules
- Do not ask questions. Follow the Implementation Map exactly as written.
- Do not add features, refactor unrelated code, or make changes not listed in the Implementation Map.
- Make the smallest change that satisfies Requirements.
```

**After dispatching, immediately inform the user** the task is running and that they can continue issuing commands.

**Model selection:**
- Default: `model: "sonnet"`
- Retry (same model): `model: "sonnet"`
- Retry with Opus: `model: "opus"`

### Step 3: Handle Completion

When a task runner subagent completes, report results and present review choice using AskUserQuestion:

```
a) Accept — mark complete and update changelog
b) Retry — revert and re-run with Sonnet (provide feedback to guide the retry)
c) Retry with Opus — revert and re-run with the most capable model (for harder tasks)
```

### Step 4: Accept or Retry

**If accepted:**

1. Update task status:
```bash
sqlite3 ~/.claude/tasks.db "UPDATE tasks SET status='completed',updated='2026-03-10 15:00' WHERE project='$P' AND seq=$N;"
```

2. Check if any tasks were unblocked by this completion:
```bash
sqlite3 ~/.claude/tasks.db -separator '|' "SELECT printf('#%03d',seq),title FROM tasks WHERE project='$P' AND status='pending' AND depends_on!='[]' AND EXISTS (SELECT 1 FROM json_each(depends_on) j WHERE j.value=$N) AND NOT EXISTS (SELECT 1 FROM json_each(depends_on) j JOIN tasks d ON d.project='$P' AND d.seq=j.value WHERE d.status!='completed');"
```
If rows are returned, inform the user: `Unblocked: #003 "Create settings modal skeleton" is now ready to run.`

3. Commit the changes: `git add -A && git commit -m "{type}: {task title}"`

3. Auto-update `CHANGELOG.md` — see Changelog section below.

**If retry:**

1. Revert changes:
   - Worktree isolation: discard the worktree
   - Direct: run `git checkout .` to restore modified files

2. Ask for optional feedback using AskUserQuestion: "What was wrong with the result? (optional — press Enter to skip)"

3. Re-dispatch a new subagent with the appropriate model and include `## Retry Notes` with user feedback.
   Update status back to `in_progress`.

4. Return to accepting commands — don't block waiting for the retry.

## Listing Tasks

When user says "list tasks", query the database:

```bash
sqlite3 ~/.claude/tasks.db -separator '|' "SELECT printf('#%03d',seq),type,title,priority,status,tags,depends_on FROM tasks WHERE project='$P' AND status!='cancelled' ORDER BY seq DESC;"
```

For filtered listing (e.g. `list tasks pending`):
```bash
sqlite3 ~/.claude/tasks.db -separator '|' "SELECT printf('#%03d',seq),type,title,priority,status,tags,depends_on FROM tasks WHERE project='$P' AND status='pending' ORDER BY seq DESC;"
```

Render the pipe-separated output as a markdown table:

```
| ID   | Type | Title                                    | Priority | Status  | Tags         | Deps         |
|------|------|------------------------------------------|----------|---------|--------------|--------------|
| #007 | task | Add keyboard shortcut to pause all panes | medium   | pending | #keybindings | #003, #004   |
| #005 | fix  | Log lines should never exceed one line   | high     | blocked | #ui          | #003         |
```

Parse the `tags` column (JSON array) for display: `["#ui","#layout"]` → `#ui, #layout`. Display `—` if the array is empty (`[]`).

Parse the `depends_on` column (JSON array) for display: `[3,5]` → `#003, #005`. Display `—` if empty.

For pending tasks with dependencies, check if any dependency is not completed. If so, display the status as **blocked** instead of `pending` in the table. To determine this:
```bash
sqlite3 ~/.claude/tasks.db "SELECT seq FROM tasks WHERE project='$P' AND status='pending' AND depends_on!='[]' AND EXISTS (SELECT 1 FROM json_each(depends_on) j JOIN tasks d ON d.project='$P' AND d.seq=j.value WHERE d.status!='completed');"
```
This returns the seq numbers of all blocked tasks.

## Completing a Task Manually

When user says "complete task #NNN" or "mark #NNN completed":

```bash
sqlite3 ~/.claude/tasks.db "UPDATE tasks SET status='completed',updated='2026-03-10 15:00' WHERE project='$P' AND seq=$N;"
```

Check if any tasks were unblocked by this completion:
```bash
sqlite3 ~/.claude/tasks.db -separator '|' "SELECT printf('#%03d',seq),title FROM tasks WHERE project='$P' AND status='pending' AND depends_on!='[]' AND EXISTS (SELECT 1 FROM json_each(depends_on) j WHERE j.value=$N) AND NOT EXISTS (SELECT 1 FROM json_each(depends_on) j JOIN tasks d ON d.project='$P' AND d.seq=j.value WHERE d.status!='completed');"
```
If rows are returned, inform the user (e.g. `Unblocked: #005 "Add theme row" is now ready to run.`).

Then auto-update `CHANGELOG.md` (see below), commit the changelog change, and confirm to the user.

## Cancelling a Task

When user says "cancel task #NNN":

```bash
sqlite3 ~/.claude/tasks.db "UPDATE tasks SET status='cancelled' WHERE project='$P' AND seq=$N;"
```

Confirm to the user: `Task #NNN cancelled.`

## Setting Task Priority

When user says "set priority of #NNN to high/medium/low":

```bash
sqlite3 ~/.claude/tasks.db "UPDATE tasks SET priority='high' WHERE project='$P' AND seq=$N;"
```

Confirm to the user: `Task #NNN priority set to {priority}.`

## Checking a Task

When user says "check task #NNN":

1. Read the task:
```bash
sqlite3 ~/.claude/tasks.db -json "SELECT seq,type,title,reqs FROM tasks WHERE project='$P' AND seq=$N;"
```

2. Dispatch a **read-only subagent** using the Agent tool with `subagent_type: "haiku"`. Extract requirements from the `reqs` JSON array. Pass this prompt:

```
You are a read-only task verifier. Do NOT modify any files.
You are working on the project at {repo_root}.

## Task to Verify
{type}: {title}
ID: #{NNN}

### Requirements
- {reqs[0]}
- {reqs[1]}

## Verification Pipeline

### Step 1: Search git log
- `git log --oneline --grep="#{NNN}"`
- `git log --oneline --grep="{title}"`

### Step 2: Extract keywords
From the requirements, identify specific searchable terms: filenames, function names,
variable names, class names, config keys, CLI flags. Ignore generic words.

### Step 3: Search the codebase
For each keyword, use Glob and Grep to search. Use Read to inspect promising matches.

### Step 4: Verdict per requirement
- **Found** — clear evidence in code (file:line) or git (commit hash)
- **Partial** — some evidence but only partly addressed
- **Not Found** — searched thoroughly, no evidence
- **Cannot Verify** — too abstract to search for

### Step 5: Return structured report

## Verification Report: #{NNN} {title}

### Commits referencing this task
{list commits found, or "None found"}

### Per-requirement verdicts
- [ ] {requirement 1} — **{verdict}**
  Evidence: {file:line, commit hash, or "none"}

### Keywords searched
{comma-separated list}

## Rules
- Do NOT write, edit, or delete any files.
- Do NOT run any commands other than git log, Glob, Grep, and Read.
```

3. Present the report with an overall confidence summary:
   - **High** — all requirements Found or Cannot Verify, with at least one Found
   - **Medium** — mix of Found and Partial
   - **Low** — one or more Not Found
   - **Inconclusive** — all Cannot Verify or Not Found with no git evidence

4. Do NOT change the task's status. This is purely informational.

## Running All Tasks

When user says "run all tasks":

1. Query all pending tasks:
```bash
sqlite3 ~/.claude/tasks.db -json "SELECT seq,type,title,priority,tags,reqs,depends_on FROM tasks WHERE project='$P' AND status='pending' ORDER BY seq ASC;"
```

2. Present them to the user. Mark any tasks with incomplete dependencies as **blocked**. Recommend worktree isolation (multiple tasks = always recommend worktree).

3. **Only dispatch unblocked tasks** (tasks with no dependencies, or whose dependencies are all completed). Skip blocked tasks and inform the user which ones were skipped and why.

4. Dispatch based on isolation strategy:
   - **Worktree:** Dispatch all **unblocked** tasks as separate subagents simultaneously (parallel).
   - **No worktree (user override):** Dispatch the first **unblocked** pending task only. After acceptance, re-check dependencies (a just-completed task may unblock others) and dispatch the next unblocked task.

5. Return to accepting commands immediately after dispatching.

## Generating Changelog

When user says "update changelog" or "generate changelog", OR automatically after any task completion:

**Auto-update** (after each task completion) — query only tasks not yet in the changelog:
```bash
sqlite3 ~/.claude/tasks.db -separator '|' "SELECT seq,substr(updated,1,10),type,title,tags FROM tasks WHERE project='$P' AND status='completed' AND in_changelog=0 ORDER BY updated DESC;"
```

After writing entries to `CHANGELOG.md`, mark them:
```bash
sqlite3 ~/.claude/tasks.db "UPDATE tasks SET in_changelog=1 WHERE project='$P' AND seq IN ($WRITTEN_SEQS);"
```

**Regenerate** (on explicit "generate changelog") — query all completed tasks:
```bash
sqlite3 ~/.claude/tasks.db -separator '|' "SELECT seq,substr(updated,1,10),type,title,tags FROM tasks WHERE project='$P' AND status='completed' ORDER BY updated DESC;"
```

After regenerating, mark all:
```bash
sqlite3 ~/.claude/tasks.db "UPDATE tasks SET in_changelog=1 WHERE project='$P' AND status='completed';"
```

Write `CHANGELOG.md` in **this exact format**:

```markdown
# Changelog

## {YYYY-MM-DD}

### Fixes
- {title} ({#tag1, #tag2})

### Tasks
- {title} ({#tag1, #tag2})

### Todos
- {title} ({#tag1, #tag2})
```

**Format rules:**
- Group by **completion date** (from `updated` column), newest date first
- Within each date, group by type: **Fixes**, then **Tasks**, then **Todos**
- Within each type group, newest first by completion time
- Omit empty type sections
- Each bullet: title followed by tags in parentheses. Parse tags JSON: `["#ui","#layout"]` → `(#ui, #layout)`
- If a task has no tags (empty array), no parenthetical
- **Only completed tasks** — pending, in_progress, and cancelled are excluded
- No boilerplate, no `[Unreleased]`, no `---` separators

## Task History as Context

When the user starts a new conversation in a project, query recent tasks for context:
```bash
sqlite3 ~/.claude/tasks.db -separator '|' "SELECT printf('#%03d',seq),type,title,status FROM tasks WHERE project='$P' ORDER BY seq DESC LIMIT 20;"
```

This helps avoid re-implementing completed work and understand the project trajectory.

## Quick Reference

| Command | Action |
|---------|--------|
| `task: description #tags` | Log new task |
| `task: description (depends on #NNN, #NNN)` | Log task with dependencies |
| `fix: description #tags` | Log new fix |
| `todo: description #tags` | Log new todo (always Log Only) |
| `list tasks` | Show all tasks (except cancelled) |
| `list tasks pending` | Filter by status |
| `run task #NNN` | Execute specific task by ID |
| `run all tasks` | Execute all pending tasks |
| `complete task #NNN` | Manually mark completed + update changelog |
| `cancel task #NNN` | Cancel a pending task |
| `set priority of #NNN to high` | Change priority |
| `check task #NNN` | Verify task in codebase (read-only) |
| `update changelog` | Regenerate changelog from completed tasks |
