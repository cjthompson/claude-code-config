# `task-db --format`: one result model, one formatter, valid GFM output

Source task: `#011` (project `claude-code-config`).

## Context

The `project-tasks` skill shows helper results to the user by having the agent retype
raw `task-db` rows as a Markdown table. That fails in practice: rows came out with no
leading pipe, no header or delimiter row, and long rows hard-wrapped, so the output was
not valid GitHub-flavored Markdown (GFM).

Today the helper has no output format concept:

- Most list commands print sqlite3 `-list` rows joined by `|`, produced directly by SQL
  (`printf('#%03d',seq)|type|title|...`) via `sqlRows()` in `lib/db.mjs`.
- `task get`, `plan get`, and `plan note list` print JSON arrays via `sqlJson()`.
- `plan status` and `plan progress` print Markdown documents built in `lib/plan-read.mjs`,
  which already carries a table-cell escaper, `cell()` (~line 396).
- Mutations print ad-hoc confirmations (`task add` prints `#011`).
- Errors are `CliError`/`DbError` messages written to stderr by `bin/task-db`.
- `emit()` in `lib/db.mjs` (~line 580) is already the single stdout choke point, including
  `--output-file` redirection.

Pipe rows are also lossy: a `|` or newline inside a title breaks the row.

## Goals

1. Every command accepts an optional `--format md|json|pipe`, with one default, `pipe`,
   for every command. No per-command default, no "unsupported command" error.
2. Handlers return data; one formatter serializes it. No handler contains format logic.
3. `md` output is always valid GFM, produced by a small custom writer with no runtime
   dependency (the plugin ships through the marketplace without `npm install`).
4. Mutations report a status and every object they changed.
5. Errors on any command are reported on stdout in the selected format.
6. Plan bodies in formatted output are shortened: linked plans show their file path,
   inline plans are truncated to about 500 characters.

## Non-goals

- No third-party runtime dependency. `micromark` is allowed as a root devDependency for
  tests only.
- No change to exit codes (`0`, `2` for first-time `db init`, `3`/`4` for `plan propose`).
- No change to the database schema.

## Design

### Result model

Every handler returns a **result**: an ordered list of named **parts**. A part is either:

- a **record list** — rows of named fields (a single-record part is a list of one), or
- a **text block** — a string.

A handler with nothing to print returns an empty result.

### Formatter (`lib/format.mjs`)

One function, `format(result, kind)`, identical for every command:

| Format | Record list | Text block | Multiple parts |
|---|---|---|---|
| `json` | array of objects, stable keys, `tags`/dependencies as real arrays | string | one object keyed by part name |
| `pipe` | one row per record, fields joined by `\|` | one line | each part preceded by a `## <part>` line |
| `md` | GFM table (single records too) | emitted verbatim | parts in order |

`pipe` escaping is lossless so every record stays on one line: backslash doubled, `|` as
`\|`, newline as `\n`. This also fixes titles that contain `|`.

`emit()` stays the only stdout writer; it receives the formatted string.

### GFM writer (`lib/gfm.mjs`)

Basic capabilities only:

- `table(headers, rows)` — header row, `|---|` delimiter row directly beneath, a leading
  and trailing `|` on every row, one physical line per record, blank line before and after
- `cell(value)` — `|` to `\|`, newlines collapsed to a space, `null`/`undefined` to empty
  (moved from `lib/plan-read.mjs`)
- `heading(level, text)`, `paragraph(text)`, `blockquote(text)`

### `--format` flag

Declared once in `lib/registry.mjs` as a global flag with enum `md|json|pipe` and default
`pipe`. The parser must extract `--format` before any other validation, so a parse error
can itself be reported in the requested format; an invalid `--format` value is reported
in `pipe`.

`plan get --content-only` and `--output-file` write the raw plan body and are declared
exclusive with `--format` through the existing registry `exclusive` rule. This is the one
remaining exception: its output is a file's bytes, not data.

### Mutation results

Every command that changes data (`task add`, `task update`, `task changelog mark`,
`plan create`, `plan propose`, `plan attach`, `plan detach`, `plan apply`,
`plan discard`, `plan update`, `plan note add`, `plan note replace`, `plan note delete`,
`db init`, `db migrate`) returns:

1. a `status` part — one record: `status` (`success` or `error`) and `message`
2. one part per changed object type, holding **every** object the command changed

Examples:

- `task add` → `status`, `task` (the new task)
- `task update --clear-plan` → `status`, `task`, `plan` (the plan it left)
- `task changelog mark` → `status`, `tasks` (each marked task)
- `plan apply` → `status`, `plan`, `note` (the `applied` note it wrote)
- `db init`, `db migrate` → `status` only

Successful reads return only their data, with no `status` part.

### Errors

`bin/task-db` catches `CliError`/`DbError` and prints a `status` part
(`status: error`, `message`) on stdout in the selected format. Nothing is written to
stderr. Exit codes are unchanged.

### Plan bodies

Wherever a plan object appears in formatted output (mutation results, `plan get`,
`plan list`):

- **linked plan** (imported from a source file) — the body field shows only the linked
  file path
- **inline plan** — the body is truncated to about 500 characters, followed by a marker
  stating how many characters were omitted

Not truncated: `plan get --content-only` / `--output-file`, and the annotated `body` part
of `plan status`.

### Document-style reads

- `plan progress` → parts `header` (plan, title, source, drift, done, total), `tasks`
  (ID, project, step, status, when, commit), `counts`, `summary` (text), `latest_note`.
  `--counts` selects only the `counts` part.
- `plan status` → parts `plan`, `body` (text: the full stored body with per-heading status
  blockquotes and notes inlined, built with `lib/gfm.mjs`), `history` (records).

Their `md` output must remain a readable document; byte-identity with today is not
required.

### Task list columns (`md`)

`number`, `type`, `title`, `priority`, `status`, `tags`, `dependencies`, `plan`. Tags and
dependencies render as comma-separated plain lists. Pending tasks reported by
`task deps blocked` show status `pending (blocked)`.

### Accepted behavior changes

- `task get`, `plan get`, `plan note list` default to `pipe` instead of JSON.
- `plan status`, `plan progress` default to `pipe` instead of Markdown.
- Mutations print a `status` part plus changed objects instead of a bare confirmation.
- Errors move from stderr to stdout.

Every caller in the skill is updated to pass an explicit `--format` in the same step that
changes the behavior it depends on.

## Steps

Each step is its own `ct/` branch cut from `main`. A step ships the helper change, the
tests for it, and every skill doc that depends on the changed behavior, so the skill never
documents a flag or output that does not exist yet.

### 1. GFM writer

- Add `lib/gfm.mjs` with `table`, `cell`, `heading`, `paragraph`, `blockquote`.
- Move `cell()` out of `lib/plan-read.mjs`; make `plan progress` build its table with
  `gfm.table` (output unchanged in this step).
- Add `micromark` and `micromark-extension-gfm-table` to root `devDependencies`.
- Tests: exact-output tests for each writer function; fixtures with a `|` in a cell, a
  multi-line cell, and empty cells; a validity check parsing `table()` output with
  `micromark` and asserting one table, the expected column count, and row count.

### 2. Result model, formatter, and --format on reads

Depends on step 1 (`md` uses `lib/gfm.mjs`).

- Add `lib/format.mjs` and the result/part types.
- Declare the global `--format` flag in `lib/registry.mjs`; parse it first.
- Convert every non-document read (`task get`, `task list`, `task recent`,
  `task deps check`, `task deps validate`, `task deps blocked`, `task deps unblocked`,
  `task changelog list`, `plan list`, `plan get`, `plan tasks`, `plan note list`) to
  return results. Row queries move from `sqlRows()` to `sqlJson()` so fields are named;
  display IDs (`#NNN`, `P###`) are still produced in SQL.
- `task list` md columns and `pending (blocked)` status as above.
- Update `skills/project-tasks/SKILL.md` with an **Output formats** section: `--format` is
  optional, accepted by every command, defaults to `pipe`; always pass it explicitly —
  `md` when showing results to the user (print verbatim, never hand-convert rows), `json`
  when reading fields. Add a Quick reference row. `SKILL.md` has `model: haiku`, so run
  the repo's Skill Editing Verification loop.
- Update callers: `references/plans.md` (`plan get` id lookup ~lines 31–35, `plan list`,
  `plan tasks`, `plan note list`), `references/task-commands.md` (list, recent, changelog
  list, deps validate), `commands/task-read.md`, `commands/plan-read.md`,
  `skills/project-tasks/tests/test-log-task.md`, `test-run-task.md`, and the `task get`
  comment in `lib/cli.mjs` (~line 254).
- Tests: formatter unit tests (record list, single record, text, multi-part, empty) in all
  three formats; no-flag output equals `--format pipe` for every converted command; pipe
  escaping round-trips a value containing `|`, a backslash, and a newline; unknown
  `--format` value errors; `--content-only` with `--format` is rejected; md validity check
  with `micromark` on `task list`.

### 3. Document reads on the result model

Depends on step 2.

- Move `plan progress` and `plan status` onto the part layouts above; `--counts` becomes a
  part selection.
- Update callers: `references/plans.md` (`show plan`, status/progress renders) and the
  accept-flow `--counts` read in `references/task-execution.md`.
- Tests: all three formats for both commands; `--counts` in all three formats; md
  validity check on the `plan progress` tasks table.

### 4. Mutation results

Depends on step 2.

- Every mutation returns a `status` part plus every changed object, as specified above.
- Update callers that read mutation output: `references/task-commands.md` (the `#NNN`
  from `task add`, changelog mark), `references/plans.md` (`plan create` `P###`,
  create-tasks, apply, note add), `references/task-execution.md`,
  `references/validation-flow.md`.
- Extend the `SKILL.md` Output formats section with the mutation result shape; rerun the
  Skill Editing Verification loop.
- Tests: each mutation returns a success status plus all changed objects, in all three
  formats; idempotent `task add` replay returns the existing task.

### 5. Errors on stdout

Depends on step 2 (uses the `status` part and `--format`).

- `bin/task-db` formats `CliError`/`DbError` as a `status` part on stdout; stderr stays
  empty; exit codes unchanged.
- Update callers that read stderr: `commands/init.md` (`db init` exit handling),
  `references/plans.md` (propose/attach/detach/apply error handling).
- Extend `SKILL.md`; rerun the Skill Editing Verification loop.
- Tests: representative parse, validation, and database errors in all three formats;
  empty stderr; exit codes unchanged, including `2` for first-time `db init` and `3`/`4`
  for `plan propose`.

### 6. Plan body truncation

Depends on step 4 (plan objects in mutation results).

- Linked plans show only the file path; inline plans truncate to about 500 characters with
  an omitted-character marker, in mutation results, `plan get`, and `plan list`.
- Update `references/plans.md` create-tasks: it reads the full body, so it must use
  `plan get --content-only` rather than `--with-content`.
- Extend `SKILL.md`; rerun the Skill Editing Verification loop.
- Tests: linked plan shows only its path; inline plan under the limit is untouched; inline
  plan over the limit is truncated with the correct omitted count; `--content-only` and
  `plan status` are never truncated.

## Verification

- Plugin suites: `task-db.test.mts`, `task-db.integration.test.mts`,
  `task-db.plan-read.test.mts`, `task-db.plan-sync.test.mts`.
- Repo suite: `npm test`.
- Manual: `task-db task list --project claude-code-config --format md` renders as a table
  in a GFM viewer.

## Open questions

- **`plan status` keeps its full body.** Assumed, because the annotated document is the
  command's purpose. Confirm.
- **Failed reads print a `status` part.** Assumed, because errors are always reported
  through it, even though successful reads have none. Confirm.

## Task list

The six steps above, as `/project-tasks:task-add` inputs. They already exist as `#013`–`#018`
under `P003`; use these lines only to recreate them elsewhere. Dependency numbers are the
current sequences — when recreating, substitute the sequence each earlier line was assigned.

| Step | Task | Depends on |
|---|---|---|
| 1 | `#013` | — |
| 2 | `#014` | `#013` |
| 3 | `#015` | `#014` |
| 4 | `#016` | `#014` |
| 5 | `#017` | `#014` |
| 6 | `#018` | `#016` |

```text
/project-tasks:task-add task: GFM writer (lib/gfm.mjs) — implement step 1 of docs/plans/task-db-output-format.md
/project-tasks:task-add task: Result model, formatter, --format on reads — implement step 2 of docs/plans/task-db-output-format.md (depends on #013)
/project-tasks:task-add task: Document reads on the result model — implement step 3 of docs/plans/task-db-output-format.md (depends on #014)
/project-tasks:task-add task: Mutation results (status part + changed objects) — implement step 4 of docs/plans/task-db-output-format.md (depends on #014)
/project-tasks:task-add task: Errors on stdout — implement step 5 of docs/plans/task-db-output-format.md (depends on #014)
/project-tasks:task-add task: Plan body truncation — implement step 6 of docs/plans/task-db-output-format.md (depends on #016)
```
