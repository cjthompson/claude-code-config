<!-- This test covers the 2-stage pipeline (Sonnet scout + Haiku executor) with TaskList integration. For single-agent dispatch, see test-run-task.md. -->
# Test: 2-Stage Pipeline (Scout + Executor) with TaskList

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

**plugins/project-tasks/skills/project-tasks/SKILL.md** contains the full skill instructions including the 2-stage pipeline (Step 2, Stages 1 and 2).

The database `~/.claude/tasks.db` contains this pending task:

```sql
INSERT INTO tasks(project,seq,type,title,priority,status,tags,reqs,created)
VALUES('claude-monitor',1,'fix','Log lines should never exceed one line','high','pending','["#ui"]','["Replace line breaks with ↵ symbol","Trim whitespace"]','2026-03-04 14:30');
```

## Scenario

The user says:

> run task #1

The skill presents the isolation recommendation. The user accepts (or the tree is clean with a single task, so direct execution is recommended). The user then selects to run the task.

## Expected Behavior

### Step 0–2 (Task Selection and Isolation)

1. The skill queries the task from the database.
2. The skill calls `syncTaskToList(seq, "pending")` — a TaskList entry is created showing `○ pending`.
3. The skill recommends an isolation strategy based on git status.
4. The skill proceeds to Step 2: Dispatch Scout + Executor.

### Stage 1: Sonnet Scout (read-only)

5. The skill dispatches a **background subagent** using the Agent tool with:
   - `subagent_type: "general-purpose"`
   - `model: "sonnet"`
   - `run_in_background: true`
   - `description: "Scout: #1 Log lines..."`

6. The skill immediately calls `syncTaskToList(seq, "scouting")` — the TaskList entry updates to `◎ scouting`.

7. The scout subagent is given a **minimal context payload** containing ONLY:
   - Full contents of `CLAUDE.md`
   - Full contents of `README.md`
   - The task line: `fix: Log lines should never exceed one line`
   - The requirements extracted from `reqs`:
     ```
     Requirements:
     - Replace line breaks with ↵ symbol
     - Trim whitespace
     ```
   - The full Scout prompt from the SKILL.md (lines 287–363), including:
     - Implementation Map instructions
     - Step 1: Glob to find relevant files
     - Step 2: Read and understand architecture
     - Step 3: Ownership analysis
     - Step 4: Produce Implementation Map
     - Rules: Do NOT write, edit, or create files

8. The scout subagent returns a **structured Implementation Map** — it does NOT make any edits.

### Stage 2: Haiku Executor (follows map literally)

9. When the scout completes, the skill calls `syncTaskToList(seq, "executing")` — the TaskList entry updates to `◉ executing`.

10. The skill dispatches a **background subagent** using the Agent tool with:
    - `subagent_type: "general-purpose"`
    - `model: "haiku"`
    - `run_in_background: true`
    - `description: "Execute: #1 Log lines..."`

11. The executor subagent is given the **full Implementation Map verbatim** from the scout, plus:
    - The task line
    - The executor instructions (lines 381–412 of SKILL.md): Follow the map literally, use Read/Edit/Write, run test command, output structured report

12. The executor makes **no tool calls except** Read, Edit, Write, and Bash (for the test command). It follows the map exactly.

13. The executor reports back with a structured report: files changed, test result, commit status, any issues.

### TaskList State Transitions

14. The TaskList entry transitions through these states in order:
    - `○ pending` (after Step 0b)
    - `◎ scouting` (after scout dispatch)
    - `◉ executing` (after scout completes, before executor completes)
    - Deleted (after accept/retry/fail)

### Completion

15. Upon subagent completion, the skill presents the review choice:
    ```
    a) Accept — mark complete and update changelog
    b) Retry — revert and re-run with Sonnet
    c) Retry with Opus — revert and re-run with the most capable model
    ```

16. If accepted:
    - Status is updated to `completed` with timestamp
    - Changelog is auto-updated
    - `syncTaskToList(seq, "completed")` is called — entry deleted

## Failure Criteria

- **FAIL** if the skill dispatches only one subagent instead of two (scout + executor).
- **FAIL** if the scout subagent uses `model` other than `"sonnet"`.
- **FAIL** if the executor subagent uses `model` other than `"haiku"`.
- **FAIL** if either subagent is not dispatched with `run_in_background: true`.
- **FAIL** if `syncTaskToList` is not called for all three status transitions (pending, scouting, executing).
- **FAIL** if the scout subagent receives any source files beyond CLAUDE.md, README.md, and the task requirements.
- **FAIL** if the executor subagent does not receive the full scout's Implementation Map verbatim.
- **FAIL** if the skill does not present the Accept/Retry/Retry with Opus choice after completion.
- **FAIL** if TaskList entries are not created/updated/deleted according to the status transition table.

---

## Variant: Retry with Sonnet (2-stage)

### Setup (Variant)

Same as above. The executor completed and the user selected **b) Retry**.

### Expected Behavior (Variant)

1. The skill reverts changes (`git checkout .`).
2. The skill updates status back to `in_progress`.
3. The skill re-dispatches the scout with `## Retry Notes` appended to the prompt.
4. After the scout completes, the executor is chained automatically.
5. The skill calls `syncTaskToList(seq, "scouting")` (not "executing") since this is a retry that starts at the scouting phase.

### Failure Criteria (Variant)

- **FAIL** if the skill does not include `## Retry Notes` in the scout prompt on retry.
- **FAIL** if the skill reverts changes before re-dispatching.
- **FAIL** if `syncTaskToList` is not called with `"scouting"` for a standard retry.

---

## Variant: Retry with Opus (single combined agent)

### Setup (Variant)

Same as initial setup. The executor completed and the user selected **c) Retry with Opus**.

### Expected Behavior (Variant)

1. The skill reverts changes (`git checkout .`).
2. The skill dispatches a **single background subagent** using the Agent tool with:
   - `subagent_type: "general-purpose"`
   - `model: "opus"`
   - `run_in_background: true`
   - `description: "Execute: #1 Log lines..."`

3. The combined prompt merges the scout and executor instructions: the full Implementation Map instructions from the scout AND the executor instructions from Step 2.

4. The skill calls `syncTaskToList(seq, "executing")` immediately (Opus is a combined scout+execute, goes straight to executing).

5. No `## Retry Notes` are needed — Opus handles it as a single agent.

### Failure Criteria (Variant)

- **FAIL** if the skill dispatches two subagents for a Retry with Opus.
- **FAIL** if the single subagent does not use `model: "opus"`.
- **FAIL** if `syncTaskToList` is not called with `"executing"` for Retry with Opus.

### Test Command

No automated test runner found (`npm test` is not defined in `package.json`, no `vitest`/`jest`/`tap` configuration present). The test scenarios in `tests/` are read by humans. Verify by reading the created file to confirm correct structure.