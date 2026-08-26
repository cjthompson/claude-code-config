# Plans

Read this file before running any `plan` command. It covers creating a plan, turning it into
tasks, keeping those tasks in step with a changing document, and closing the plan out.

All commands use `$TASK_DB` from the Host Compatibility setup block in `SKILL.md`, and every
`plan` command needs `--project "$PROJECT"`.

## The three rules

1. **Never auto-cancel or rewrite a `completed` task.** When reconciliation says a completed
   task's step was modified or removed, leave the row alone and report it as
   *"plan changed after this task completed"*.
2. **On refusal, do NOT `plan apply`.** Run `plan discard` so the stale candidate does not
   linger and fire the drift indicator forever.
3. **`--confirm-cancel`, `--force-complete`, and `--confirm-source-change` are never issued
   without an affirmative answer to an AskUserQuestion first.** Use the exact prompts below.
   Do not pre-emptively add a confirming flag "to save a round trip".

## ID spaces

`P###` is the project-local display sequence the user types, and `--seq` on every `plan`
command accepts it either way: `--seq P002` and `--seq 2` are the same call. A `P###` copied
out of any output can go straight back in. A `#NNN` cannot — `--seq` on a plan command
refuses a task id by name rather than resolving it as a plan number.

`--plan-id` on `task add` / `task update` takes the **global numeric id** instead, which has
no display form and rejects `P###`. Resolve it before inserting tasks:

```bash
$TASK_DB plan get --project "$PROJECT" --seq {plan_seq}
```

`plan get` prints a JSON **array** holding one object, so the value `--plan-id` wants is the
`id` field of the first element, not of the payload itself.

**Placeholders below name their space:** `{plan_seq}` is the `P###` number, `{task_seq}` is
a task's `#NNN`, `{plan_id}` is the global integer from `plan get`, `{note_id}` is a note id
from `plan note list`, `{count}` is a plain limit. A bare `N` is the seq of whatever command
it appears on — a plan seq on a `plan` command, a task seq on a `task` command.
Never copy a number from one slot into another — all of them are valid integers, so the
helper will find a real row and act on the wrong one without erroring. `--project` on a plan command identifies the
plan's owner and never filters its children — a plan may own tasks in several repositories,
so filter on the `project` column that `plan tasks` and `plan progress` print.

## Creating a plan

### From a description (`plan: <description>`)

Inline content skips the Import/Link question entirely.

```bash
$TASK_DB plan create --project "$PROJECT" --title "..."
```

The body arrives later via `plan propose --content-file`, or the plan stays title-only.
The command prints the new `P###`.

### From a file path (`plan: /abs/path/to/doc.md`)

**Always ask first.** Present exactly this fork with AskUserQuestion:

> **a) Import** — copy the plan into the database and delete the file from disk. The
> database becomes the single source of truth; there is nothing left to drift.
>
> **b) Link** — keep the file where it is and store a reference plus a content snapshot.
> Edits are picked up by `plan propose`, which reconciles the tasks.

**Link** stores the path and a snapshot:

```bash
$TASK_DB plan create --project "$PROJECT" --title "..." --path /abs/path/to/doc.md
```

**Import** copies the bytes in, records provenance, then removes the file — but only after
proving the copy is byte-identical:

1. Check whether the file is git-tracked (`git ls-files --error-unmatch <path>`). If it is,
   warn before doing anything: deleting it is a tracked deletion the user must commit.
2. Create the plan with the content and its origin:

```bash
$TASK_DB plan create --project "$PROJECT" --title "..." --content-file /abs/path/to/doc.md --origin /abs/path/to/doc.md
```

3. Read the stored body back out and compare its sha256 against the file on disk:

```bash
$TASK_DB plan get --project "$PROJECT" --seq N --content-only --output-file /tmp/plan-verify.md
```

4. **Unlink only on an exact hash match.** On any mismatch, keep the file, tell the user the
   import did not verify, and stop.

Restoring an imported plan to disk later is the same export:

```bash
$TASK_DB plan get --project "$PROJECT" --seq N --content-only --output-file /abs/path/to/doc.md
```

## `create-tasks`

Turning a plan body into tasks:

1. Read the body (`plan get --seq {plan_seq} --with-content`) and decompose it into steps —
   one task per step heading. **If the body is empty, stop and say so.** A plan created from
   a description is title-only until a body arrives via
   `plan propose --seq {plan_seq} --content-file <path>`; never invent steps from the title.
2. Derive an anchor per step from its heading. Pass the **raw heading**; the helper slugifies
   it, so there is no agent-side variance.
3. **Present the derived list for approval before inserting anything.** Show step heading,
   derived title, type, and priority. Let the user edit or drop rows.
4. Insert each approved step, passing the resolved global `--plan-id` — the integer from
   `plan get`, never a `P###` and never a task seq:

```bash
$TASK_DB task add --project "$PROJECT" --type {type} --title "..." --plan-id {plan_id} --anchor "..." --priority {priority}
```

Pass the `{type}` and `{priority}` the user approved in step 3. Omitting them silently
files every step as a `medium` `task`, discarding the classification you just had approved.

`task add` is idempotent per `(plan_id, anchor)` — re-running prints the existing `#NNN`
rather than duplicating, so `create-tasks` is safe to re-run after an interrupted batch.
`--anchor` without `--plan-id` is an error.

A re-run keeps the existing row exactly as it is: `--title`, `--type`, `--priority` and
`--req` on a replayed `task add` are **discarded, not applied**. That is deliberate — a
replayed batch must not rewrite a task that has already started, finished, or been written
into `CHANGELOG.md` under its old title. To change an approved value on a task that already
exists, use `task update`.

5. Record one note for the whole batch:

```bash
$TASK_DB plan note add --project "$PROJECT" --seq N --kind tasks-created --note "..."
```

## The reconciliation loop (`update plan PNNN`)

Never apply a content change and a task change in one unreviewed step. The loop is:

**1. Stage and diff.** For a linked plan, the file is the source of truth — the user edits
the file, then:

```bash
$TASK_DB plan propose --project "$PROJECT" --seq N
```

For an inline plan, supply the new body instead:

```bash
$TASK_DB plan propose --project "$PROJECT" --seq N --content-file /abs/path/to/new.md
```

Exit codes: `0` = identical, nothing staged, stop here. `3` = changed, unified diff on
stdout. `4` = the linked path is unreadable — report the path and stop.

The two nonsense combinations error explicitly: a bare `propose` on an *inline* plan (there
is no file to re-read — pass `--content-file`, or `plan attach` one), and `--content-file` on
a *linked* plan (edit the file instead, or `plan attach` a different one). Do not work around
either by pushing content through the database behind the file's back.

If the candidate would give two headings the same slug as an existing task anchor, `propose`
errors without staging. Return that error verbatim, name the colliding headings and tasks,
and suggest renaming a heading. Do not guess an anchor and do not annotate both.

**2. Classify by anchor.** Read the current rows:

```bash
$TASK_DB plan tasks --project "$PROJECT" --seq {plan_seq}
```

Rows are `#NNN|project|anchor|type|title|priority|status` — the **anchor is the third
field**, and it is the join key for everything below. Cancelled children are included, so
filter on the status field rather than assuming the list is live work. The `project` column
is there because a plan is global: `--project` names the plan's owner and never filters its
children, so rows from other repositories appear here by design.

Match each diff hunk to a task by its heading slug:

| Case | Meaning | Proposed action |
|---|---|---|
| Heading in candidate, no task | added | create a task with that anchor |
| Heading and task, body changed | modified | update title/requirements |
| Heading reworded, same step | renamed | update the task's `--title` **and** `--anchor` — do **not** cancel and recreate |
| Task, heading gone from candidate | removed | cancel the task — **unless it is `completed`** |
| Task is `completed`, step changed or gone | — | leave it; flag *"plan changed after this task completed"* |

A **renamed** heading is the case most easily misread, because it looks like a
removal and an addition when compared by anchor alone: the old slug vanishes and
a new one appears. Classifying it that way cancels a task that is still live —
losing its status, dependencies and history — and creates an empty duplicate in
its place. Judge by the diff, not by the anchor set: if a hunk reworded a
heading in place and the step beneath it is recognizably the same work, it is a
rename. When you genuinely cannot tell a rename from a delete-plus-add, say so
in the approval table and let the user decide; do not guess.

**3. Present a table** of every proposed change (anchor, task id, classification, what would
change) and ask for approval. Nothing is written yet.

**4a. On approval** — apply the task changes first, then commit the content:

```bash
$TASK_DB task update --project "$PROJECT" --seq {task_seq} --title "..." --anchor "..." --plan-id {plan_id}
$TASK_DB plan apply --project "$PROJECT" --seq {plan_seq}
```

The first line carries three different numbers and no two of them are interchangeable:
`--seq` is the task's `#NNN`, `--plan-id` is the plan's **global** integer, and the `--seq`
on the second line is the plan's `P###`. Putting a task seq in `--plan-id` does not error —
it moves the task to whichever plan holds that global id, so the plan you are reconciling
silently loses the task whose change was just approved.

`--title`, `--req` and `--tag` **replace**, they do not merge. Re-passing one requirement
drops the others, so send the full intended set or leave the flag off entirely.

`plan apply` promotes exactly the bytes that were staged, even if the source file changed
again during review, and auto-writes an `applied` note carrying the hash. Then record what
was reconciled:

```bash
$TASK_DB plan note add --project "$PROJECT" --seq N --kind reconciled --note "..." --task "github.com/acme/backend#001"
```

**4b. On refusal** — discard the candidate. Do not call `plan apply`.

```bash
$TASK_DB plan discard --project "$PROJECT" --seq N
```

## Attaching and detaching a source

```bash
$TASK_DB plan attach --project "$PROJECT" --seq N --path /abs/path/to/doc.md
$TASK_DB plan detach --project "$PROJECT" --seq N
```

`attach` sets the path, flips the plan to linked, and stages that file's content — it refuses
while a different candidate is pending, so apply or discard first.

`detach` copies the live content in, clears the path, flips to inline, and records
`origin_path`. Add `--delete-file` to unlink the file afterwards.

If the live file differs from the applied hash, the helper requires
`--confirm-source-change`. **Ask first**, with exactly this wording:

> This file has plan changes that have not been reconciled into tasks. Detaching will retain
> those bytes as a pending change, leave the changed file on disk, and require reconciliation
> before it can be deleted. Proceed?

Only on an affirmative answer:

```bash
$TASK_DB plan detach --project "$PROJECT" --seq N --confirm-source-change
```

The changed file stays on disk and `--delete-file` is refused until the pending content is
applied or discarded. Run the reconciliation loop, then delete.

## Listing and inspecting

```bash
$TASK_DB plan list --project "$PROJECT"
$TASK_DB plan list --project "$PROJECT" --status pending
```

Rows are `P001|title|source|status|done|total|drift`. A non-empty drift indicator means a
candidate is staged or the linked file no longer matches the applied hash.

The two artifacts are different views and are not interchangeable:

```bash
$TASK_DB plan status --project "$PROJECT" --seq N
$TASK_DB plan progress --project "$PROJECT" --seq N
$TASK_DB plan progress --project "$PROJECT" --seq N --counts
```

- **`plan status`** — the stored body **verbatim**, with a blockquote status line under each
  heading whose slug matches a task anchor, notes referencing that task rendered beneath it,
  and unattributed notes in a `## History` footer. `--limit {count}` bounds that footer. If no
  heading matches, it prints the body plus a stderr warning naming the unmatched anchors —
  pass that warning on; it never silently falls back to a table.
- **`plan progress`** — a header (title, source, drift, `3/7 complete`), a task table
  (ID, project, step, status, when, commit), a one-paragraph summary, and the latest note.
  `--counts` replaces all of that with `total|pending|in_progress|completed|cancelled|blocked`,
  which is the form the accept-flow in `SKILL.md` uses.

For `show plan PNNN`, render `plan status` and follow it with `plan progress`.

## Running a plan (`run plan PNNN`)

List the plan's tasks, filter to `pending` in the current project, drop anything `task deps
blocked` reports, then dispatch each through the normal **Running a Task** pipeline in
`SKILL.md`. The first child moved to `in_progress` promotes the plan automatically — never
set the plan's status by hand for that.

```bash
$TASK_DB plan tasks --project "$PROJECT" --seq N --status pending
```

## Closing and cancelling

### Close (`close plan PNNN`)

If every child is terminal, close it directly:

```bash
$TASK_DB plan update --project "$PROJECT" --seq N --status completed
```

If any child is `pending` or `in_progress`, the helper refuses without `--force-complete`.
List those children and ask, using exactly this wording:

> There are incomplete tasks. Do you want to mark them all completed?

Only on an affirmative answer:

```bash
$TASK_DB plan update --project "$PROJECT" --seq N --status completed --force-complete
```

That marks the listed children completed with the current timestamp and records them in the
lifecycle note. If the answer is no, leave the plan open and say which tasks are outstanding.

### Cancel (`cancel plan PNNN`)

Run it once without the flag first — the helper reports which children are `in_progress` and
which are `completed`:

```bash
$TASK_DB plan update --project "$PROJECT" --seq N --status cancelled
```

Name those tasks to the user and explain that every non-completed child will be cancelled and
that completed children are left untouched. Ask for confirmation. Only on an affirmative
answer:

```bash
$TASK_DB plan update --project "$PROJECT" --seq N --status cancelled --confirm-cancel
```

### Other edits

```bash
$TASK_DB plan update --project "$PROJECT" --seq N --title "..." --tag "release"
```

## Notes

Notes are the plan's audit trail; `plan status` renders them inline.

```bash
$TASK_DB plan note add --project "$PROJECT" --seq {plan_seq} --note "..." --task "github.com/acme/backend#001" --task "github.com/acme/frontend#001"
$TASK_DB plan note list --project "$PROJECT" --seq {plan_seq} --limit {count}
$TASK_DB plan note replace --project "$PROJECT" --seq {plan_seq} --id {note_id} --note "..."
$TASK_DB plan note delete --project "$PROJECT" --seq {plan_seq} --id {note_id}
```

- `--task` takes a project-qualified task reference (`<project>#<positive-seq>`, displayed as
  `github.com/acme/backend#001`), not the global id `--plan-id` uses. The project segment is
  normalized through the same project canonicalization as `--project`. A note ref is how
  `plan status` files the note under the right step, so a wrong qualified reference remains
  in History rather than attaching to another project's child with the same sequence.
- Existing stored integer task references are legacy data. They are interpreted as belonging
  to the plan owner only while rendering; they are never rewritten, and `plan note list`
  returns the original stored JSON.
- `--id` is a note id from `plan note list`, unrelated to both task and plan numbering.
- `--kind` on `add` accepts only `manual` (the default), `tasks-created`, and `reconciled`.
  `created`, `applied`, and `status` are written by the helper's own lifecycle hooks and
  cannot be forged from the command line.
- `replace` and `delete` refuse to touch a lifecycle note without `--force`. Ask before
  passing it — those entries are the record of what the helper actually did.
- `replace` preserves the original `ts` and stamps `edited`. Note ids are stable and never
  reused, so a `plan note list` → `plan note delete` sequence cannot hit the wrong entry.
- Note prose may contain quotes and newlines; pass it as a plain string, no escaping.

## Output files

Every command accepts the global `--output-file <path>`: the payload goes to the file
(parent directories created, existing file overwritten) and a one-line `<n> bytes → <path>`
confirmation goes to stdout. Exit codes are untouched, so `plan propose`'s `0`/`3`/`4` still
mean the same thing when the diff is redirected.
