# Task Commands and Changelog

Read this file for task CRUD, task checking, batch execution, and changelog
generation. Running one task uses `task-execution.md`; post-execution decisions
use `validation-flow.md`.

## Log a task

Recognize `task:`, `fix:`, `todo:`, `log task:`, `log fix:`, `run task:`, and
`run fix:`. Parse `#tags`, requirements, priority, and `depends on #NNN`.

Remove a dependency parenthetical such as `(depends on #003, #005)` from the
title and pass each dependency as a separate bare-number `--dep` value. Infer
priority as follows:

- `fix:`, `log fix:`, and `run fix:` default to high because they describe
  broken behavior. Crashes, data loss, and security issues are also high.
- `task:`, `todo:`, `log task:`, and `run task:` default to medium for features
  and enhancements.
- Cosmetic work, cleanup, and documentation may be low when the description
  makes that intent clear.

Infer concrete requirements from the description. Proceed directly when it
names a file, symbol, component, UI element, concrete target, or explicit
steps. When the description is five words or fewer, has no concrete code or UI
reference, or uses a vague action without a target, show the inferred
requirements and ask the user to accept or change them before logging.

Add through the helper:

```bash
$TASK_DB task add --project "$PROJECT" --type {task|fix|todo} \
  --title "..." --priority {low|medium|high} \
  --tag "#tag" --req "requirement" --dep N
```

Pass every tag, requirement, and dependency with its own repeated flag. Report
the assigned `#NNN` returned by the helper.

If dependencies were supplied, validate them after insertion:

```bash
$TASK_DB task deps validate --project "$PROJECT" --dep N [--dep N...]
```

Any output identifies nonexistent dependency sequences. Warn the user, but
leave the newly logged task in place; dependency validation does not roll back
task creation.

Behavior by prefix:

- `todo:`, `log task:`, `log fix:`: log only.
- `run task:`, `run fix:`: log and immediately enter `task-execution.md`.
- `task:`, `fix:`: offer:

  ```text
  a) Run Now
  b) Log Only
  c) Auto-Run All
  ```

Auto-Run All applies to later tasks in the same session without another
execution-choice prompt. Each task still receives its own context and decision.

## List tasks

```bash
$TASK_DB task list --project "$PROJECT"
$TASK_DB task list --project "$PROJECT" --status pending
$TASK_DB task deps blocked --project "$PROJECT"
```

Rows are `#NNN|type|title|priority|status|tags|depends_on|plan`. Render a concise
Markdown table, parse JSON tags/dependencies, and mark pending rows returned by
`deps blocked` as blocked.

## Hide task list

Set `hideListRequested = true`, clear/hide visible entries without changing
their task phase, and confirm that workers continue silently. Later lifecycle
updates affect in-memory state only until the user shows the list again.

## Complete manually

Use the real time and task commit when one exists:

```bash
$TASK_DB task update --project "$PROJECT" --seq "#NNN" \
  --status completed --completed-at "YYYY-MM-DD HH:MM" [--commit-sha SHA]
```

Then report unblocked tasks and update the changelog. Do not attach an unrelated
HEAD SHA.

## Cancel without active execution

If the task has an active/recovered execution context or task-owned work, use
the Reject / Cancel flow in `validation-flow.md`.

Only a task with no active execution context and no task-owned work may use:

```bash
$TASK_DB task update --project "$PROJECT" --seq "#NNN" --status cancelled
```

Simple cancellation has no commit, changelog, dependency, or plan-completion
side effects.

## Change priority

```bash
$TASK_DB task update --project "$PROJECT" --seq "#NNN" --priority high
```

## Remove a task's plan link

Read the task first and retain its `plan_seq` and `plan_project`, then:

```bash
$TASK_DB task update --project "$PROJECT" --seq "#NNN" --clear-plan
```

The task and history remain. If it had a plan, recheck that plan's progress with
the retained identifiers and offer closure only when total is nonzero and no
pending/in-progress/blocked children remain.

## Check a task

Read the task and dispatch the read-only Verifier at Strong tier. It searches
relevant Git history and repository content, then returns per-requirement
Found, Partial, Not Found, or Cannot Verify verdicts with evidence. Present an
overall confidence summary:

- High: every requirement Found or Cannot Verify, with at least one Found.
- Medium: a mix of Found and Partial.
- Low: at least one Not Found.
- Inconclusive: no positive code or Git evidence.

Checking is informational and never changes task status.

## Run all tasks

List pending and blocked tasks. Skip blocked tasks. Recommend isolated
worktrees because multiple tasks may run concurrently. With worktrees, dispatch
unblocked tasks independently; with an explicit direct-checkout override,
serialize them so ownership remains attributable. Each task follows
`task-execution.md` and gets its own completion decision.

## Generate changelog

Auto-update after completion:

```bash
$TASK_DB task changelog list --project "$PROJECT" --new-only
```

Explicit regeneration:

```bash
$TASK_DB task changelog list --project "$PROJECT"
```

Rows are `seq|date|type|title|tags|plan`. Write:

```markdown
# Changelog

## {YYYY-MM-DD}

### {Plan title} (P00N)
- {title} ({#tag1, #tag2})

### Fixes
- {title} ({#tag1, #tag2})

### Tasks
- {title} ({#tag1, #tag2})

### Todos
- {title} ({#tag1, #tag2})
```

Order dates newest first. Within a date, plan groups come first, followed by
unplanned Fixes, Tasks, and Todos. Omit empty sections and empty tag
parentheticals. Do not add boilerplate, `[Unreleased]`, or separators.

After writing new entries, mark their task sequences:

```bash
$TASK_DB task changelog mark --project "$PROJECT" --seq N [--seq N...]
```

For explicit full regeneration, mark `--all`.

## Recent context

At the start of a new project conversation, use:

```bash
$TASK_DB task recent --project "$PROJECT"
```

Use the result to avoid reimplementing completed work; do not treat it as
authorization to modify task state.
