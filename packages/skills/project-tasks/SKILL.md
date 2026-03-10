---
name: project-tasks
description: Use when the user says "task:", "fix:", "todo:", or asks to log, run, list, or manage project tasks. Also use when asked to generate or update a changelog from completed tasks.
TRIGGER when: user message starts with "task:", "fix:", or "todo:" (these are definitive triggers — always invoke this skill). Also trigger when user says "list tasks", "run task", "run all tasks", "update changelog", or "generate changelog".
DO NOT TRIGGER when: user is asking a general question about tasks/todos unrelated to project management.
model: haiku
---

# Project Tasks

## Overview

Capture small tasks and fixes to `docs/TASKS.md` and execute them cheaply via minimal-context subagents. Auto-generate `docs/CHANGELOG.md` from completed work.

**Core principle:** The lead agent is always available. Every task — even a single one — is dispatched to a subagent so the user can keep issuing commands. Each task runner subagent scouts the codebase, implements changes, and reports back.

## When to Use

- User says `task: <description>`, `fix: <description>`, or `todo: <description>`
- User asks to "list tasks", "run task", "run all tasks"
- User asks to "complete task", "mark completed", "cancel task", "set priority"
- User asks to "update changelog" or "generate changelog"

## Logging a Task

When the user provides a task/fix/todo prefix:

1. **Parse the message** — extract the title (everything after the prefix), tags (any `#word` in the message), and infer priority:
   - `high` — bugs, crashes, data loss, security issues, broken functionality. **`fix:` prefix defaults to `high`** since fixes imply something is broken.
   - `medium` — features, UX improvements, enhancements. **`task:` and `todo:` default to `medium`.**
   - `low` — cosmetic changes, nice-to-have, cleanup, documentation

2. **Interpret requirements** — infer concrete action items from the description. Apply these rules to decide whether to proceed or propose:

   **Proceed directly if the description includes ANY of:**
   - A specific file, function, variable, component, or UI element name
   - A concrete action with a clear target (e.g. "rename X to Y", "remove the X button", "add X to Y")
   - Explicit step-by-step instructions from the user

   **Propose an interpretation if the description:**
   - Contains no specific code, file, or component reference
   - Is 5 words or fewer after the prefix
   - Uses a vague action word with no clear target — such as "fix", "improve", "update", "clean up", "handle", or "deal with" — without specifying *what*

   If proposing, use AskUserQuestion before logging:

   > Here's how I interpreted this task:
   > - {inferred requirement 1}
   > - {inferred requirement 2}
   >
   > a) Accept — log with these requirements
   > b) Change — describe what's different

   If the user selects "Change", incorporate their correction and re-present the proposed requirements before logging. Repeat until accepted.

3. **Create `docs/TASKS.md`** if it doesn't exist, starting with `# Tasks` header.

4. **Assign a task ID** — scan `docs/TASKS.md` for the highest existing `**ID:** #NNN` value and increment by 1. If no tasks exist yet or no tasks have an ID field, start at `#001`. Tasks without an ID field are legacy entries — do not retroactively assign IDs to them, and do not count them when determining the next ID. IDs are zero-padded to 3 digits and never reused.

5. **Prepend the task** (newest first — insert after `# Tasks` but before existing entries) using this **exact format**:

```
---

## {type}: {title}
**ID:** #{NNN} | **Date:** {YYYY-MM-DD HH:MM} | **Priority:** {high|medium|low} | **Tags:** {#tag1 #tag2}
**Status:** pending

### Requirements
- {requirement 1}
- {requirement 2}
```

**Format rules:**
- `{type}` is exactly `fix`, `task`, or `todo` (lowercase, matching user's prefix)
- `**ID:** #{NNN}` is the assigned task ID, zero-padded to 3 digits (e.g. `#001`, `#012`, `#100`)
- `{YYYY-MM-DD HH:MM}` is the current date and time
- Tags use `#` prefix. If no tags provided, use `—` as the value (e.g. `**Tags:** —`). Do NOT omit the Tags field — always include it for consistent formatting.
- Status is always `pending` for new tasks
- Requirements is a bullet list — each bullet is one concrete action item
- A `---` separator appears before each task entry

6. **Determine execution behavior** based on the prefix:

   - **`todo:` prefix** — skip the execution choice entirely. The task is saved as `pending` with no dispatch (always "Log Only"). Inform the user the todo was logged.
   - **`task:` or `fix:` prefix** — present the execution choice using AskUserQuestion:

```
a) Run Now — dispatch a subagent immediately
b) Log Only — save for later
c) Auto-Run All — run this and all future tasks without asking
```

If the user previously chose "Auto-Run All" in this session, skip asking and dispatch immediately.

If the user selects "Log Only", do nothing further. The task stays as `pending`.

## Running a Task

**Core principle: The lead agent NEVER blocks on task execution.** Every task — even a single one — is dispatched to a subagent so the lead agent stays available to accept new `task:`, `fix:`, or `todo:` commands at all times.

When dispatching a task (via "Run Now", "run task #NNN", or "Auto-Run All"):

### Step 1: Recommend Isolation Strategy

Check these conditions and recommend accordingly:
- **Dirty working tree** (unstaged/uncommitted changes) → recommend worktree
- **Multiple pending tasks** being run together → recommend worktree
- **Clean tree + single task** → recommend direct (current directory)

Present recommendation with brief reasoning. Let user override.

### Step 2: Dispatch Task Runner Subagent

Dispatch a **single subagent** that owns the entire pipeline: scout → execute → report. Use the Agent tool with `subagent_type: "general-purpose"`. If worktree was chosen, add `isolation: "worktree"`.

**Update TASKS.md status** to `in_progress` before dispatching:
```
**Status:** in_progress (dispatched YYYY-MM-DD HH:MM)
```

Task Runner prompt:

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
{Copy the requirements bullet list from TASKS.md for this specific task}

{If this is a retry, include:}
## Retry Notes
A previous attempt was rejected. User feedback: {feedback}

## Phase 1: Scout (read-only)
Do NOT write any code yet. First, map the codebase:
1. Use Glob to find all files relevant to this task.
2. Use Read to read every relevant file — including ones not explicitly mentioned
   in Requirements but logically impacted (e.g. if a type is added, find every
   place that type is initialized or reset).
3. Produce an Implementation Map with this exact format:

### Files to Modify
- **{relative/path/file.ts}** — {one-line summary of change}
  - Location: `{function name}` (line ~{N})
  - Change: {precise description — what to add, where exactly, what it should look like}

### Files to Create
- **{relative/path/file.md}** — {one-line summary}
  - Content: {description of what the file must contain}

### No Changes Needed
- {file you read but determined needs no modification}

## Phase 2: Execute
Now implement using your Implementation Map:
1. Use Read to read each file listed under "Files to Modify".
2. Make exactly the changes described for each file. Follow the map precisely.
3. Create any files listed under "Files to Create" with the described content.
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

**After dispatching, immediately inform the user** the task is running and that they can continue issuing commands:

```
Task "{title}" dispatched to subagent. You can continue working — type more
task:/fix:/todo: commands or anything else. I'll report results when it completes.
```

**Model selection for the task runner:**
- Default: `model: "sonnet"` (handles both scout and execute phases)
- Retry (same model): `model: "sonnet"` — the value here is corrective feedback from the user, not a model change
- Retry with Opus: `model: "opus"` — escalate to a more capable model for harder tasks

### Step 3: Handle Completion

When a task runner subagent completes, **interrupt-style report** to the user:

1. **Report results** — briefly summarize what the subagent did (files changed, tests passed/failed).

2. **Present review choice** using AskUserQuestion:

   ```
   a) Accept — mark complete and update changelog
   b) Retry — revert and re-run with Sonnet (provide feedback to guide the retry)
   c) Retry with Opus — revert and re-run with the most capable model (for harder tasks)
   ```

### Step 4: Accept or Retry

**If accepted:**

1. **Update TASKS.md** — change the task's status line from:
   ```
   **Status:** in_progress (dispatched YYYY-MM-DD HH:MM)
   ```
   to:
   ```
   **Status:** completed (YYYY-MM-DD HH:MM)
   ```
   Use the **actual current time** (NOT the task's creation date). Do NOT add extra sections.

2. **Commit the changes** — run `git add -A` and `git commit -m "{type}: {task title}"`.

3. **Auto-update CHANGELOG.md** — see Changelog section below.

**If retry:**

1. **Revert the changes:**
   - Worktree isolation: discard the worktree (changes are abandoned automatically)
   - Direct (no worktree): run `git checkout .` to restore modified files

2. **Ask for optional feedback** using AskUserQuestion: "What was wrong with the result? (optional — press Enter to skip)"

3. **Re-dispatch** a new task runner subagent with:
   - Set `model` to `"sonnet"` or `"opus"` based on user's choice
   - Include the `## Retry Notes` section in the prompt with user feedback
   - Update TASKS.md status back to `in_progress`

4. **Return to accepting commands** — don't block waiting for the retry.

## Listing Tasks

When user says "list tasks", read `docs/TASKS.md` and show all tasks **except cancelled** by default:

```
# Tasks

| ID   | Type | Title                                    | Priority | Status      | Tags          |
|------|------|------------------------------------------|----------|-------------|---------------|
| #007 | task | Add keyboard shortcut to pause all panes | medium   | pending     | #keybindings  |
| #005 | fix  | Log lines should never exceed one line   | high     | in_progress | #ui           |
| #003 | task | Update onboarding flow copy              | low      | completed   |               |
```

**Filtering** — if the user qualifies the command, filter accordingly:
- `list tasks pending` — only `pending` tasks
- `list tasks in_progress` — only `in_progress` tasks
- `list tasks completed` — only `completed` tasks

Use the stored `**ID:**` and `**Status:**` values from each task entry. Tasks are listed newest-first (as they appear in the file).

## Completing a Task Manually

When user says "complete task #NNN" or "mark #NNN completed" (and variants like "mark completed"):

1. Find the task entry in `docs/TASKS.md` by its `**ID:** #NNN`
2. Update the status line to:
   ```
   **Status:** completed (YYYY-MM-DD HH:MM)
   ```
   Use the actual current time.
3. Auto-update `CHANGELOG.md` — see Changelog section below.
4. Confirm to the user: `Task #NNN marked as completed.`

## Cancelling a Task

When user says "cancel task #NNN":

1. Find the task entry in `docs/TASKS.md` by its `**ID:** #NNN`
2. Update the status line to:
   ```
   **Status:** cancelled
   ```
3. Confirm to the user: `Task #NNN cancelled.`

Cancelled tasks are excluded from `list tasks` by default. Include them only if the user explicitly says `list tasks cancelled`.

## Setting Task Priority

When user says "set priority of #NNN to high/medium/low" (and natural variants like "make #NNN high priority"):

1. Find the task entry in `docs/TASKS.md` by its `**ID:** #NNN`
2. Update the `**Priority:**` field in the metadata line to the new value.
3. Confirm to the user: `Task #NNN priority set to {priority}.`

## Running All Tasks

When user says "run all tasks":

1. List all pending tasks and present them to the user
2. Recommend worktree isolation (multiple tasks = always recommend worktree)
3. Dispatch tasks based on isolation strategy:
   - **Worktree:** Dispatch ALL tasks as separate subagents simultaneously (parallel). Each gets its own isolated worktree.
   - **No worktree (user override):** Dispatch the FIRST pending task only. After it completes and the user accepts/retries, dispatch the next pending task. This avoids conflicts from concurrent edits to the same working tree.
4. Return to accepting commands immediately after dispatching
5. Handle each completion as it arrives (Step 3 above), updating TASKS.md and CHANGELOG.md after each

## Generating Changelog

When user says "update changelog" or "generate changelog", OR automatically after any task completion:

1. Read all **completed** tasks from `docs/TASKS.md`
2. Write `docs/CHANGELOG.md` in this **exact format**:

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

**Changelog format rules:**
- Group by **completion date** (from `completed (YYYY-MM-DD ...)` timestamp), newest first
- Within each date section, list items newest first by completion time (HH:MM from the completion timestamp)
- Within each date, group by type in this order: **Fixes**, then **Tasks**, then **Todos**
- Omit empty type sections (if no fixes on a date, skip `### Fixes`)
- Each bullet: title (without type prefix) followed by tags in parentheses
- Tags are comma-separated with `#` preserved: `(#ui, #layout)`
- If a task has no tags, no parenthetical
- **Only completed tasks** — pending, in_progress, and cancelled tasks are all excluded from the changelog
- Do NOT add boilerplate like "All notable changes..." or `[Unreleased]` sections
- Do NOT add `---` separators between date sections
- Do NOT include requirement details in bullets — just the title and tags

### Auto-Update vs Regenerate

- **Auto-update** (after each task completion): find the date section matching the task's completion date. If the section exists, insert the new entry into the correct type group (Fixes/Tasks/Todos), maintaining newest-first order by completion time. If the type group doesn't exist yet, add it in the standard order (Fixes → Tasks → Todos). If no section exists for that date, create a new date section in the correct chronological position.
- **Regenerate** (on explicit "generate changelog"): rebuild the entire file from scratch using all completed tasks in TASKS.md.

## Task History as Context

When the user starts a new conversation in a project that has `docs/TASKS.md`, review the completed tasks to understand what has already been changed. This helps you:
- Avoid re-implementing things already done
- Understand the trajectory of the project
- Make better recommendations for new tasks

## Quick Reference

| Command | Action |
|---------|--------|
| `task: description #tags` | Log new task |
| `fix: description #tags` | Log new fix |
| `todo: description #tags` | Log new todo (always Log Only — never dispatched) |
| `list tasks` | Show all tasks |
| `list tasks pending` | Filter by status (pending / in_progress / completed / cancelled) |
| `run task #NNN` | Execute specific task by ID via subagent |
| `run all tasks` | Execute all pending tasks (parallel with worktrees, sequential without) |
| `complete task #NNN` | Manually mark a task completed + update changelog |
| `cancel task #NNN` | Cancel a pending task |
| `set priority of #NNN to high` | Change a task's priority (high / medium / low) |
| `update changelog` | Regenerate changelog from completed tasks |
