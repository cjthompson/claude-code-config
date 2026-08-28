---
description: Show a full menu of project-tasks actions
---

Walk the user through a tiered picker with `AskUserQuestion` so every common
action is reachable, plus a reference of everything else that exists
(`AskUserQuestion` caps a single question at 4 options, so this uses short
steps instead of one long list):

**Step 1 — scope** (header "Scope"): "What do you want to do?"
- Tasks
- Plans
- More actions

**Step 2 — only if "Tasks" or "Plans"** (header "Action"), options depend on Step 1:
- Tasks: Add a task / Update a task / View tasks / Run a task
- Plans: Add a plan / Update a plan / View plans / Run a plan

**Step 3 — only if "View" was picked** (header "View"): "List all, or look up one?"
- List all
- Look up one by ID

Dispatch to the matching command's instructions, prompting conversationally
for any detail it needs ($ARGUMENTS is empty since this came from a picker):

| Step 1 | Step 2 | Step 3 | Command |
|---|---|---|---|
| Tasks | Add a task | — | `task-add` |
| Tasks | Update a task | — | `task-update` |
| Tasks | View tasks | List all | `task-list` |
| Tasks | View tasks | Look up one by ID | `task-read` |
| Tasks | Run a task | — | `task-run` |
| Plans | Add a plan | — | `plan-add` |
| Plans | Update a plan | — | `plan-update` |
| Plans | View plans | List all | `plan-list` |
| Plans | View plans | Look up one by ID | `plan-read` |
| Plans | Run a plan | — | `plan-run` |

**"More actions" — no further picker.** These are real but low-frequency, so
just print this reference (do not call `AskUserQuestion` again) and let the
user reply in plain language; the project-tasks skill already knows how to
run each one:

Things you can ask for directly:
| Say | Does |
|---|---|
| `check task #NNN` | Verify a task's work actually exists in the codebase (read-only) |
| `close plan PNNN` | Mark a plan completed (confirms if child tasks remain) |
| `cancel plan PNNN` | Cancel a plan, cascading to its tasks (confirms first) |
| `update changelog` | Regenerate CHANGELOG.md from completed tasks |
| `hide list` | Hide the persistent task list (running tasks keep going) |

Internal building blocks (the skill calls these itself during `run task`,
`update plan`, etc. — mention them for visibility, but they're not typically
invoked directly):
- `task deps check/validate/blocked/unblocked` — dependency-satisfaction checks
- `task changelog mark` — marks tasks as already included in a changelog run
- `plan propose` / `plan apply` / `plan discard` — stage, review, then commit
  or drop a plan's source-file changes
- `plan attach` / `plan detach` — link or unlink a plan to a file on disk
- `plan note add/list/replace/delete` — the audit-trail notes attached to a plan
