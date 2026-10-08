# Plan Context in Task Execution Design

## Goal

When a task is linked to a plan, surface the plan title, step anchor, and the
matching step body in the lead agent's context so the Scout and Executor
prompts carry the same information the task is rooted in. The plan link
already exists in the schema; this design makes it visible at run time.

## Scope

Three files in `plugins/project-tasks` and one test file:

- `lib/handlers.mjs` — extend the `taskGet` SELECT.
- `skills/project-tasks/references/task-execution.md` — read the plan once
  before dispatch and inline a `Plan:` block into both prompt templates.
- `commands/task-read.md` — add the plan hint line only; the md table
  carries the plan columns.
- `task-db.integration.test.mts` — extend existing fixtures. This file sits at
  the plugin root, not under `lib/`.

No schema migration. No `create-tasks` workflow change. No new CLI subcommand.

## `taskGet` output

The handler at `lib/handlers.mjs:325–347` currently returns
`seq, type, title, priority, tags, reqs, depends_on, status, plan_id,
plan_seq, plan_project` from a `LEFT JOIN plans p ON p.id = t.plan_id`. That
field list appears twice: in the SELECT, and in the `records('task', [...])`
column list at line 345. The Result model emits only the listed columns, so
both must change.

Add two fields to both:

- `p.title AS plan_title` — alias is required because `t.title` is already
  selected; the `-json` output emits one `title` key per column name.
- `t.plan_anchor` — the per-task step slug from the partial unique index
  `idx_tasks_plan_anchor`.

Update the doc comment at lines 308–324 to name all five plan fields:
`plan_id, plan_seq, plan_project, plan_title, plan_anchor`. Its closing
sentence (lines 320–321, wrapped) reads "with the three plan fields null";
change "three" to "five".

## Plan body retrieval

The lead agent calls, once, between `task get` and Scout dispatch:

```sh
$TASK_DB plan get --project "{plan_project}" --seq {plan_seq} --content-only
```

The handler at `lib/handlers.mjs:640–644` returns the stored body verbatim.
No status blockquotes, no `## History` footer, no stderr warnings. An empty
body comes back as an empty string. `--content-only` is mutually exclusive
with `--format` (`lib/registry.mjs:267`), so the call must not pass `--format`.

`plan status` and `plan status --limit N` are not suitable — `--limit` only
bounds the `## History` footer, and `plan status` adds annotations under each
matching heading plus a stderr warning on unmatched anchors. All of that would
land inside the sliced step.

## Cross-project rule

`{plan_project}` is mandatory on every plan lookup — never `$PROJECT`. A plan
P002 in another repository would otherwise resolve to a same-numbered plan in
the current project, either as an error or, worse, a silent substitution. The
task's `plan_seq` and `plan_project` travel as a pair; both come from the
`task get` record.

## Step-body slicing

The lead agent slices the body itself; no CLI helper does it. Heading detection
and slugging match `planStatus` (`HEADING_RE` at `lib/plan-read.mjs:46`,
`slugify` at `lib/normalize.mjs:59`). The end-of-step rule below has no
existing counterpart: `planStatus` uses headings only to attach annotations and
never cuts a section. The lead agent applies this rule as written:

- A heading line matches the regex `^#{1,6}\s+(.*)$`.
- A heading's slug is its text lowercased, with each run of characters
  outside `[a-z0-9]` replaced by `-` and leading/trailing `-` trimmed.
- Pick the first heading whose slug equals `plan_anchor`.
- The step runs from that heading until the next heading of equal or higher
  level (same or fewer `#`) or end of body.
- No awareness of fenced code blocks — same as the existing handler.

## Fallbacks

Keep the `Plan: P### — {title}` line in every case. Never invent content.

- **`plan_anchor` is null while `plan_seq` is set** — possible because
  `--plan-id` can be passed without `--anchor`. Omit `Step anchor:` and the
  step body.
- **Plan body is empty** — title-only inline plan. Omit the step body, keep
  `Plan:` and `Step anchor:`.
- **Anchor matches no heading** — post-rename, pre-reconcile. Print
  `Step anchor: {anchor} (no matching heading in current plan body)` and
  report likely drift to the user. Do not guess from similar headings.

## `task-execution.md` edits

Amend Preconditions step 1 (line 18) to say the lead agent reads the task via
`task get` and retains `plan_seq`, `plan_project`, `plan_title`,
`plan_anchor`.

Add a new paragraph in "Start the task" between line 70 (`If the task has a
plan_id…`) and line 72 (`### Planning Scout`). It runs once before the
Scout, fetches the body with the command above, slices it per the rule
above, and stores the result as `planStepContext` for both prompts. Do not
re-fetch before the Executor.

In the Scout prompt template (lines 79–96), insert after line 87
(`- {each requirement}`) and before line 89 (`Inspect the repository…`):

```text
Plan: {plan_seq} ({plan_project}) — {plan_title}
Step anchor: {plan_anchor}
Plan step:
{planStepContext}
```

In the Executor prompt template (lines 111–124), insert the same block
after line 117 (`- {each requirement}`) and before line 119
(`Implementation Map:`).

Omit the whole block when `plan_seq` is null. Drop lines individually under
the Fallbacks above. Include `plan_project` so a cross-repo plan isn't read
as local. Add a one-line note in both templates: "Plan step is context
only; do not carry out sibling-step work."

## `task-read.md` edit

The md renderer needs no change. `formatMd` in `lib/format.mjs` prints every
declared column of a records part as a table, the same way `formatJson` and
`formatPipe` emit every declared column. The `plan_title` and `plan_anchor`
columns added to `taskGet` therefore appear in md output automatically,
alongside `plan_seq` and `plan_project`. The md output carries the plan
information in the same form as the json and pipe output.

The command renders `task get --format md` (line 11) and line 14 says
`Print the output verbatim.` Keep both. No second call and no separate
`Plan:` line. The hint rule below reads `plan_seq` and `plan_project` from the
printed task row.

Hint line — only when `plan_project` equals the current project:

```text
For the plan and its tasks, run /project-tasks:plan-read {plan_seq}.
```

Cross-project — when `plan_project` differs, print one line noting the plan
belongs to `{plan_project}`, so `plan-read` must be run from that repository.
No hint line.

## Tests

All edits land in `task-db.integration.test.mts`, not `task-db.test.mts`
(the latter holds parser and doc-lint tests):

Assertions read the task row from `runJson(home, [...]).task`, as the existing
`task get` tests do: the non-linked test indexes `task[0]`, and the plan-linked
and cross-repo tests destructure `const [row] = ….task`.

- **Non-linked control** at line 933 — add
  `strictEqual(task[0].plan_title, null)` and
  `strictEqual(task[0].plan_anchor, null)`.
- **Plan-linked** at line 1015 — add
  `plan_title === 'Seeded plan'` and `plan_anchor === 'step-one'`.
- **Cross-repo** at line 1030 — extend `seedPlan` (lines 134–141) with an
  optional `title` argument, seed distinct titles per plan, and assert the
  correct plan's title plus `plan_anchor === 'backend-step'`. Distinct
  titles are required: `seedPlan` currently hard-codes `'Seeded plan'` and
  a wrong join would still pass.
- **`--plan-id` without `--anchor`** — new case: `plan_seq` set,
  `plan_anchor` null.

## Doc-lint (optional)

Add `references/task-execution.md` to `SKILL_FILES` in
`task-db.test.mts:712` so the new `$TASK_DB plan get …` line gets
parse-checked alongside `SKILL.md` and `references/plans.md`.

## Out of scope

- Denormalizing the step body onto the task row.
- Changing the `create-tasks` workflow.
- Schema migrations.
- A new `plan step --seq --anchor` subcommand.

## Commit flow

The root `CLAUDE.md` post-commit rules apply only after this branch is merged
into `main`, not on the feature branch: bump `package.json` and
`package-lock.json` patch, update `CHANGELOG.md`, audit `README.md`.