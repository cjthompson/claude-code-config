---
name: project-tasks
description: Use when the user says "task:", "fix:", "todo:", "log task:", "log fix:", "run task:", "run fix:", or asks to log, run, list, or manage project tasks. Also use when asked to generate or update a changelog from completed tasks.
TRIGGER when: user message starts with "task:", "fix:", "todo:", "log task:", "log fix:", "run task:", or "run fix:" (these are definitive triggers — always invoke this skill). Also trigger when user says "list tasks", "run task #NNN", "run all tasks", "update changelog", or "generate changelog".
DO NOT TRIGGER when: user is asking a general question about tasks/todos unrelated to project management.
model: haiku
---

# Project Tasks

## Overview

Capture small tasks and fixes to a SQLite database (`~/.claude/tasks.db`) and execute them cheaply via minimal-context subagents. Auto-generate `CHANGELOG.md` from completed work.

**Core principle:** The lead agent is always available. Every task — even a single one — is dispatched to a subagent so the user can keep issuing commands.

> **IMPORTANT:** All database operations MUST use `node ~/.claude/task-db.mjs <command>`. Do NOT call sqlite3 directly — ever. The helper script handles all SQL internally.

## Rules

- **ALWAYS** use `node ~/.claude/task-db.mjs <command>` for every database operation.
- **NEVER** call sqlite3 directly, construct SQL strings, or use heredocs with SQL.
- **NEVER** reference `~/.claude/tasks.db` directly — let `task-db.mjs` manage the path.

## When to Use

- User says `task: <description>`, `fix: <description>`, or `todo: <description>`
- User says `log task: <description>` or `log fix: <description>` (log only, no execution prompt)
- User says `run task: <description>` or `run fix: <description>` (log and run immediately)
- User asks to "list tasks", "run task #NNN", "run all tasks"
- User asks to "complete task", "mark completed", "cancel task", "set priority", "check task"
- User asks to "update changelog" or "generate changelog"

## Prerequisites

**All commands below use `node ~/.claude/task-db.mjs`. Do not use sqlite3 directly.**

Run these steps at the start of **every** skill invocation, before any other operation:

1. Check that `node` is available and `task-db.mjs` is installed:
```bash
command -v node >/dev/null 2>&1 || echo "ERROR: node is required"
test -f ~/.claude/task-db.mjs || echo "ERROR: task-db.mjs not found — run 'npm run install-packages' from the claude-code-config repo"
```
If either check fails, inform the user and stop.

2. Initialize the database:
```bash
node ~/.claude/task-db.mjs init
```
- Exit code `0` — database already existed, continue normally
- Exit code `2` — **first-time setup**: database was just created. Show the user this tip:
  > **First-time setup tip:** To avoid approval prompts for every task-db command, add this to `~/.claude/settings.json`:
  > ```json
  > {
  >   "permissions": {
  >     "allow": ["Bash(node ~/.claude/task-db.mjs *)"]
  >   }
  > }
  > ```
  > This is optional — without it, you will be prompted to approve each command individually.

3. Determine the project identifier:
```bash
git remote get-url origin 2>/dev/null | sed 's/\.git$//' || basename "$(git rev-parse --show-toplevel)"
```
Store this value as `$PROJECT` for use in all subsequent commands.

## Logging a Task

When the user provides a task/fix/todo prefix (including `log task:`, `log fix:`, `run task:`, `run fix:`):

1. **Parse the message** — extract the title (everything after the prefix), tags (any `#word` in the message), dependencies, and infer priority.

   **Dependencies:** If the message contains `(depends on #NNN)` or `(depends on #NNN, #NNN)`, extract the seq numbers and remove the parenthetical from the title. If no dependencies, omit `--dep` flags.

   **Priority:**
   - `high` — bugs, crashes, data loss, security issues, broken functionality. **`fix:`, `log fix:`, and `run fix:` prefixes default to `high`.**
   - `medium` — features, UX improvements, enhancements. **`task:`, `todo:`, `log task:`, and `run task:` default to `medium`.**
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

3. **Insert the task** using `node ~/.claude/task-db.mjs insert`. Pass each requirement as a separate `--req` flag, each tag as a separate `--tag` flag, each dependency seq number as a separate `--dep` flag. All values are passed as plain strings — no escaping of any kind is needed.

```bash
node ~/.claude/task-db.mjs insert \
  --project "git@github.com:org/repo" \
  --type "fix" \
  --title "Log lines shouldn't exceed one line" \
  --priority "high" \
  --tag "#ui" \
  --req "Replace line breaks with space" \
  --req "Trim leading and trailing whitespace"
```

The output is the assigned task ID (e.g. `#001`). Report it to the user.

   If the task has dependencies, validate they exist:
   ```bash
   node ~/.claude/task-db.mjs validate-deps --project "..." --dep 3 --dep 5
   ```
   If any output is printed, those seq numbers don't exist — warn the user. The task is still logged.

4. **Determine execution behavior** based on the prefix:

   - **`todo:` prefix** — skip the execution choice entirely. Inform the user the todo was logged.
   - **`log task:` or `log fix:` prefix** — skip the execution choice entirely (Log Only). Inform the user the task was logged.
   - **`run task:` or `run fix:` prefix** — skip the execution choice prompt (the answer is "Run Now"). Proceed directly to the **Running a Task** pipeline starting at Step 0 (Check Dependencies). Do not ask the user whether to run.
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

```bash
node ~/.claude/task-db.mjs check-deps --project "..." --seq N
```

If any output is printed, the task is **blocked**. Each line is `#NNN|title|status`. Report to the user and do NOT dispatch:
> Task #005 is blocked. These dependencies must be completed first:
> - #003 (pending): Create settings modal skeleton
> - #004 (in_progress): Add theme support

### Step 1: Recommend Isolation Strategy

- **Dirty working tree** (unstaged/uncommitted changes) → recommend worktree
- **Multiple pending tasks** being run together → recommend worktree
- **Clean tree + single task** → recommend direct (current directory)

Present recommendation with brief reasoning. Let user override.

### Step 2: Dispatch Scout + Executor (2-stage pipeline)

Read the task data:
```bash
node ~/.claude/task-db.mjs get --project "..." --seq N
```

Update status to in_progress:
```bash
node ~/.claude/task-db.mjs update --project "..." --seq N --status in_progress
```

The task runs as a **2-stage pipeline**: a Sonnet scout (read-only) produces an Implementation Map, then a Haiku executor follows it mechanically. Both run as background subagents so the user stays unblocked.

#### Stage 1: Sonnet Scout (read-only)

Dispatch a **background** subagent. Extract `type`, `title`, and each element of the `reqs` JSON array:

```
Agent tool parameters:
  subagent_type: "general-purpose"
  model: "sonnet"
  run_in_background: true
  description: "Scout: #{SEQ} {short_title}"
```

Scout prompt:

```
You are a codebase scout. Analyze the codebase and produce a detailed Implementation Map.
Do NOT write, edit, or create any files. Read-only.
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

## Your Job

### Step 1: Find relevant files
Use Glob to find all files that could be relevant to this task.

### Step 2: Read and understand architecture
Use Read to read every relevant file — including ones not explicitly mentioned
in Requirements but logically impacted.

### Step 3: Ownership analysis (CRITICAL)
Before deciding WHERE to make changes, answer these questions:
- **Data ownership:** If this task adds or tracks new state, which existing class/struct
  already owns related data? Add new fields there, not as globals on the app/main class.
- **Logic ownership:** If this task adds rendering, formatting, or business logic, does a
  base class or shared module already have a similar method? Extend it there rather than
  duplicating in a leaf file.
- **Cross-file impact:** Would changes in a shared module (base class, common utilities,
  types file) be cleaner than changes in the specific file mentioned by the task? If a
  base class method already handles similar work, modify it instead of adding new code
  in the subclass.

Common mistake to avoid: putting new state or logic on the outermost/leaf class when it
belongs on an inner/base class that other code also uses.

### Step 4: Produce Implementation Map
The executor will follow this map LITERALLY. Be precise — include exact line numbers,
function names, and code snippets for every change.

### Ownership Decision
- **New state belongs on:** {class/module name} — because {reason}
- **New logic belongs in:** {class/module name} — because {reason}

### Files to Modify
- **{relative/path/file.ext}** — {one-line summary of change}
  - Location: `{function/class.method name}` (line ~{N})
  - Change: {precise description with exact code snippets where possible}

### Files to Create
- **{relative/path/file.ext}** — {one-line summary}
  - Content: {description of what the file must contain}

### No Changes Needed
- {file you read but determined needs no modification}

### Test Command
- {the command to run tests, from README or CLAUDE.md — or "no tests found"}

## Rules
- Do NOT write, edit, or create any files. Read-only.
- Be extremely precise. Include exact line numbers, function names, and code snippets.
- The executor will follow your map literally — ambiguity causes errors.
- Include every file that needs changing, even if the requirement doesn't mention it explicitly.
- Place new state on the class that owns related data, not as globals on the app class.
- Place new logic in the module that owns similar logic, even if the task description only names a different file.
```

#### Stage 2: Haiku Executor

When the scout completes, dispatch the executor as another **background** subagent. Pass the scout's **full Implementation Map** verbatim.

```
Agent tool parameters:
  subagent_type: "general-purpose"
  model: "haiku"
  run_in_background: true
  description: "Execute: #{SEQ} {short_title}"
  (add isolation: "worktree" if worktree was chosen in Step 1)
```

Executor prompt:

```
You are a task executor. Follow the Implementation Map below exactly. Do not deviate.
You are working on the project at {repo_root}.

## Task
{type}: {title}

## Implementation Map
{Paste the FULL Implementation Map returned by the scout — including Ownership Decision,
Files to Modify, Files to Create, and Test Command sections}

## Instructions
1. For each file under "Files to Modify":
   a. Use Read to read the file.
   b. Use Edit to make exactly the change described. Match the Location and Change precisely.
2. For each file under "Files to Create":
   a. Use Write to create the file with the described content.
3. Run the Test Command from the Implementation Map (if any).
4. Output a structured report:
   - **Files changed:** list each file and what was done
   - **Tests:** passed / failed / none found
   - **Commit:** none yet (pending Accept)
   - **Issues:** any problems encountered

## Rules
- Follow the Implementation Map literally. Do not interpret, improve, or add to it.
- Do not ask questions.
- Do not add features, refactor unrelated code, or make changes not in the map.
- If a described location doesn't match (wrong line number, missing function), report it
  as an Issue and make your best effort to apply the intended change nearby.
```

**After dispatching the scout, immediately inform the user** the task is running and that they can continue issuing commands. When the scout completes, chain the executor automatically — do not ask the user between stages.

**Model selection:**
- Default: Sonnet scout → Haiku executor (2-stage)
- Retry (same approach): Sonnet scout → Haiku executor (2-stage)
- Retry with Opus: Single Opus agent (combined scout+execute, no 2-stage)

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
node ~/.claude/task-db.mjs update --project "..." --seq N --status completed
```

2. Check if any tasks were unblocked:
```bash
node ~/.claude/task-db.mjs unblocked --project "..." --seq N
```
Each output line is `#NNN|title`. If any lines are returned, inform the user:
`Unblocked: #003 "Create settings modal skeleton" is now ready to run.`

3. Commit the changes: `git add -A && git commit -m "{type}: {task title}"`

4. Auto-update `CHANGELOG.md` — see Changelog section below.

**If retry:**

1. Revert changes:
   - Worktree isolation: discard the worktree
   - Direct: run `git checkout .` to restore modified files

2. Ask for optional feedback using AskUserQuestion: "What was wrong with the result? (optional — press Enter to skip)"

3. Re-dispatch using the 2-stage pipeline (Sonnet scout → Haiku executor) with `## Retry Notes` included in the scout prompt. If user chose "Retry with Opus", dispatch a single Opus agent (combined scout+execute) instead. Update status back to `in_progress`.

4. Return to accepting commands — don't block waiting for the retry.

## Listing Tasks

```bash
node ~/.claude/task-db.mjs list --project "..."
# Filtered:
node ~/.claude/task-db.mjs list --project "..." --status pending
```

Get blocked task seq numbers:
```bash
node ~/.claude/task-db.mjs blocked --project "..."
```

Render output as a markdown table. Each row is pipe-separated: `#NNN|type|title|priority|status|tags|depends_on`.

```
| ID   | Type | Title                                    | Priority | Status  | Tags         | Deps       |
|------|------|------------------------------------------|----------|---------|--------------|------------|
| #007 | task | Add keyboard shortcut to pause all panes | medium   | pending | #keybindings | #003, #004 |
| #005 | fix  | Log lines should never exceed one line   | high     | blocked | #ui          | #003       |
```

- Parse `tags` JSON: `["#ui","#layout"]` → `#ui, #layout`. Display `—` if empty.
- Parse `depends_on` JSON: `[3,5]` → `#003, #005`. Display `—` if empty.
- If a pending task's seq appears in the `blocked` output, show status as **blocked**.

## Completing a Task Manually

```bash
node ~/.claude/task-db.mjs update --project "..." --seq N --status completed
```

Check for unblocked tasks:
```bash
node ~/.claude/task-db.mjs unblocked --project "..." --seq N
```

Then auto-update `CHANGELOG.md`, commit, and confirm to the user.

## Cancelling a Task

```bash
node ~/.claude/task-db.mjs update --project "..." --seq N --status cancelled
```

Confirm: `Task #NNN cancelled.`

## Setting Task Priority

```bash
node ~/.claude/task-db.mjs update --project "..." --seq N --priority high
```

Confirm: `Task #NNN priority set to {priority}.`

## Checking a Task

When user says "check task #NNN":

1. Read the task:
```bash
node ~/.claude/task-db.mjs get --project "..." --seq N
```

2. Dispatch a **read-only subagent** using the Agent tool with `subagent_type: "general-purpose"` and `model: "haiku"`. Extract requirements from the `reqs` JSON array. Pass this prompt:

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

1. List all pending tasks:
```bash
node ~/.claude/task-db.mjs list --project "..." --status pending
node ~/.claude/task-db.mjs blocked --project "..."
```

2. Present them to the user. Mark blocked tasks. Recommend worktree isolation (multiple tasks = always recommend worktree).

3. **Only dispatch unblocked tasks.** Skip blocked tasks and inform the user which were skipped and why.

4. Dispatch based on isolation strategy:
   - **Worktree:** Dispatch all unblocked tasks as separate subagents simultaneously (parallel).
   - **No worktree (user override):** Dispatch the first unblocked task only. After acceptance, re-check and dispatch the next unblocked task.

5. Return to accepting commands immediately after dispatching.

## Generating Changelog

When user says "update changelog" or "generate changelog", OR automatically after any task completion:

**Auto-update** (after each task completion):
```bash
node ~/.claude/task-db.mjs changelog --project "..." --new-only
```

After writing entries to `CHANGELOG.md`, mark them:
```bash
node ~/.claude/task-db.mjs mark-changelog --project "..." --seq 1 --seq 2
```

**Regenerate** (on explicit "generate changelog"):
```bash
node ~/.claude/task-db.mjs changelog --project "..."
node ~/.claude/task-db.mjs mark-changelog --project "..." --all
```

Each output row is pipe-separated: `seq|date|type|title|tags`.

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
- Group by completion date, newest first
- Within each date, group by type: **Fixes**, then **Tasks**, then **Todos**
- Within each type, newest first
- Omit empty type sections
- Parse tags JSON: `["#ui","#layout"]` → `(#ui, #layout)`. No parenthetical if tags is `[]`.
- No boilerplate, no `[Unreleased]`, no `---` separators

## Task History as Context

When starting a new conversation in a project:
```bash
node ~/.claude/task-db.mjs recent --project "..."
```

This helps avoid re-implementing completed work and understand the project trajectory.

## Quick Reference

| Command | Action |
|---------|--------|
| `task: description #tags` | Log new task (asks Run Now / Log Only) |
| `task: description (depends on #NNN, #NNN)` | Log task with dependencies |
| `fix: description #tags` | Log new fix (asks Run Now / Log Only) |
| `todo: description #tags` | Log new todo (always Log Only, never runs) |
| `log task: description #tags` | Log new task, Log Only — no execution prompt |
| `log fix: description #tags` | Log new fix, Log Only — no execution prompt |
| `run task: description #tags` | Log new task and run immediately |
| `run fix: description #tags` | Log new fix and run immediately |
| `list tasks` | Show all tasks (except cancelled) |
| `list tasks pending` | Filter by status |
| `run task #NNN` | Execute specific task by ID |
| `run all tasks` | Execute all pending tasks |
| `complete task #NNN` | Manually mark completed + update changelog |
| `cancel task #NNN` | Cancel a pending task |
| `set priority of #NNN to high` | Change priority |
| `check task #NNN` | Verify task in codebase (read-only) |
| `update changelog` | Regenerate changelog from completed tasks |
