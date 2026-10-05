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

- a **record list** — a declared, ordered list of **columns** plus zero or more rows of
  those fields (a single-record part is a list of one). Columns are declared by the part,
  never derived from the rows, so an empty list still has a header.
- a **text block** — a string.

A handler with nothing to print returns an empty result.

Any result may carry a `warnings` part: a record list with column `message`. Every warning
that is written to stderr today moves into it, including the unmatched-anchor warning in
`plan status` (`lib/plan-read.mjs:349`), the candidate-already-staged warning in
`plan propose` (`lib/plan-sync.mjs:646`), and the missing-file warning in `plan detach`
(`lib/plan-sync.mjs:948`). A warning never changes the exit code.

### Formatter (`lib/format.mjs`)

One function, `format(result, kind)`, identical for every command. The output shape never
depends on how many parts a result has:

| Format | Whole result | Record list | Text block |
|---|---|---|---|
| `json` | always one object keyed by part name (an empty result is `{}`) | array of objects keyed by the declared columns, `tags`/dependencies as real arrays | string |
| `pipe` | every part, in order, preceded by a `## <part>` line | one row per record, fields joined by `\|` | one line |
| `md` | every part, in order, preceded by a `## <part>` heading | GFM table with the declared columns (header and delimiter only when empty) | emitted verbatim |

`pipe` escaping is lossless so every record and text block stays on one line: backslash
doubled, `|` as `\|`, newline as `\n`, and a leading `##` as `\##` so no escaped line can be
mistaken for a `## <part>` header. A single leading `#` is left alone, so display IDs such as
`#001` in a first column stay unescaped. This also fixes titles that contain `|`.

`emit()` stays the only stdout writer; it receives the formatted string.

### GFM writer (`lib/gfm.mjs`)

Basic capabilities only:

- `table(headers, rows)` — header row, `| --- |` delimiter row directly beneath (one
  `---` per column), a leading and trailing `|` on every row, one physical line per
  record. With zero rows it emits the header and delimiter only. It emits no surrounding
  blank lines; the caller joins blocks with one blank line.
- `cell(value)` — backslash to `\\` first, then `|` to `\|`, newlines collapsed to a space,
  `null`/`undefined` to empty (moved from `lib/plan-read.mjs`, with backslash escaping
  added). Escaping the backslash first is what keeps a value like `a\|b` from ending in a
  bare `|` that splits the cell.
- `heading(level, text)`, `paragraph(text)`, `blockquote(text)`

### `--format` flag

Declared once in `lib/registry.mjs` `GLOBALS` with enum `md|json|pipe` and default `pipe`.
The parser in `lib/cli.mjs` needs two changes, because today it cannot hold a second
value-bearing global:

- **Key dispatch.** `lib/cli.mjs:483-485` assigns every global other than `--project` to
  `outputFile`. It must instead store each global under its declared `key`
  (`action.global.format`, `action.global.outputFile`), so `--format md` is never taken
  as an output path.
- **Global defaults.** The default loop at `lib/cli.mjs:510-514` walks only `spec.opts`.
  Globals need their own pass so `format` is `pipe` when the flag is omitted.

The parser also extracts `--format` before any other validation, so a parse error can
itself be reported in the requested format; an invalid `--format` value is reported in
`pipe`.

`--output-file` stays a global accepted by every command. The formatted output is written
to the file, and stdout carries a `status` part (`success`, message `N bytes → path`)
formatted in the selected format, replacing the bare line `emit()` prints today
(`lib/db.mjs:598`).

`plan get --content-only` writes the raw plan body and is declared exclusive with
`--format` through the existing registry `exclusive` rule. This is the one remaining
exception: its output is a file's bytes, not data. It still combines with `--output-file`.

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
- `plan propose` → `status`, `plan`, and on exit `3` a `diff` text part holding the full
  unified diff (`lib/plan-sync.mjs:659`). The diff is never truncated; it is what the user
  reviews before `plan apply`.
- `db init`, `db migrate` → `status` only

Successful reads return only their data, with no `status` part.

### Errors

`bin/task-db` catches `CliError`/`DbError` and prints a `status` part
(`status: error`, `message`) on stdout in the selected format. Because the whole-result
shape is fixed, an error is the same shape on every command: `{"status":[...]}` in `json`,
a `## status` section in `pipe` and `md`. Nothing is written to stderr; warnings travel in
the `warnings` part. Exit codes are unchanged.

### Plan bodies

Wherever a plan object appears in formatted output (mutation results, `plan get`,
`plan list`):

- **linked plan** (imported from a source file) — the body field shows only the linked
  file path
- **inline plan** — the body is truncated to about 500 characters, followed by a marker
  stating how many characters were omitted

Not truncated: `plan get --content-only`, the annotated `body` part of `plan status`, and
the `diff` part of `plan propose`.

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
- Errors and warnings move from stderr to stdout.
- `--output-file` confirmations become a formatted `status` part.
- `plan progress` md output changes from `| --- |`-per-column tables built by hand to the
  shared writer's output, and gains `## <part>` headings.

Every caller in the skill is updated to pass an explicit `--format` in the same step that
changes the behavior it depends on.

## Steps

A step ships the helper change, the tests for it, and every skill doc that depends on the
changed behavior. **Each step documents only what it ships**: the skill never describes a
flag, part, or output shape that does not exist yet, and a later step extends the
`SKILL.md` Output formats section with its own behavior.

### Branching

This repo is under `~/dev`, so no PR is opened, but the branching rules apply unchanged.
Quoted from `~/.claude/CLAUDE.md`, **Branching**:

> Every branch **you** create in a repo under `~/workspace` MUST start with `ct/`
> (e.g. `ct/my-feature`, `ct/fix-some-bug`). This governs the branches you create;
> pre-existing and bot-generated ones (`chore/gem-bumps-*`, `dependabot/*`) are
> not violations — leave them alone.
>
> Cut every new branch from the repo's default branch after a `git fetch`. The
> fetch is not optional — a local copy of the default branch is stale the moment
> someone else merges. Look the branch up rather than assuming `main`; some repos
> use `origin/development`:
>
> ```
> git fetch
> git symbolic-ref --short refs/remotes/origin/HEAD   # → e.g. origin/main
> ```
>
> If that prints nothing, `origin/HEAD` is unset in this clone — run `git remote
> set-head origin -a` and retry. Name the resolved ref as the explicit starting
> point whatever the mechanism: `git switch -c <branch> <ref>`, `git branch
> <branch> <ref>`, `git worktree add -b <branch> <path> <ref>` (for `<path>`, see
> **Worktrees**). Never branch from whatever the working tree or worktree
> currently has checked out, and never from another `ct/` branch.

Quoted from `~/.claude/CLAUDE.md`, **PR Cadence**:

> **Proof required for a non-default base.** Run `git diff --name-only` on both
> branches; name the shared file and the specific breakage — fails to build,
> fails tests, or duplicates the other PR's work — that targeting the default
> branch would cause. Disjoint paths mean there is no dependency. Not
> dependencies: the order the commits happened in, avoiding conflicts, logical or
> narrative sequence, reviewer convenience, or the slices coming out of one work
> session.

In this clone the remote is named `local`, so the resolved ref is `local/main`
(`git symbolic-ref --short refs/remotes/local/HEAD`).

Because every branch starts from the default branch and never from another `ct/` branch,
**a dependent step is branched only after the step it depends on has merged into the
default branch**. Steps 2–6 depend on code from an earlier step (listed under each step),
so each waits for that merge: step 2 after step 1; steps 3, 4 and 5 after step 2; step 6
after step 4.

### 1. GFM writer

- Add `lib/gfm.mjs` with `table`, `cell`, `heading`, `paragraph`, `blockquote`.
- Move `cell()` out of `lib/plan-read.mjs`, adding backslash escaping; make
  `plan progress` build its table with `gfm.table`. Its output may change (a title with a
  backslash now renders correctly); update the existing `plan progress` tests to pin the
  new output rather than preserving the old bytes.
- Add `micromark` and `micromark-extension-gfm-table` to root `devDependencies`.
- Docs: none. The writer is internal and changes no command's flags.
- Tests: exact-output tests for each writer function; fixtures with a `|` in a cell, a
  backslash directly before a `|` (`a\|b`), a trailing backslash, a multi-line cell,
  empty cells, and a zero-row table; a validity check parsing `table()` output with
  `micromark` and asserting one table, the expected column count, and row count
  (including the zero-row and backslash-pipe fixtures).

### 2. Result model, formatter, and --format on reads

Depends on step 1 (`md` uses `lib/gfm.mjs`).

- Add `lib/format.mjs` and the result/part types, including declared columns and the
  `warnings` part.
- Declare the global `--format` flag in `lib/registry.mjs` `GLOBALS`, and make the two
  `lib/cli.mjs` parser changes: store each global under its declared key instead of
  always `outputFile` (lines 483-485), and apply global defaults (next to lines 510-514).
  Extract `--format` before other validation.
- Every command accepts `--format` from this step on, so Goal 1 holds immediately.
  Commands not yet converted (document reads, mutations) accept the value and keep their
  current output until their own step converts them.
- Convert every non-document read (`task get`, `task list`, `task recent`,
  `task deps check`, `task deps validate`, `task deps blocked`, `task deps unblocked`,
  `task changelog list`, `plan list`, `plan get`, `plan tasks`, `plan note list`) to
  return results. Row queries move from `sqlRows()` to `sqlJson()` so fields are named;
  display IDs (`#NNN`, `P###`) are still produced in SQL.
- `--output-file` on a converted read writes the formatted output and returns the
  formatted `status` confirmation.
- `task list` md columns and `pending (blocked)` status as above.
- Update `skills/project-tasks/SKILL.md` with an **Output formats** section covering
  **only the converted reads**: list them, state that `--format` is optional and defaults
  to `pipe`, and instruct the agent to pass it explicitly on those reads — `md` when
  showing results to the user (print verbatim, never hand-convert rows), `json` when
  reading fields. State the fixed `json` object shape. Do not yet describe mutation
  results, stdout errors, or the plan documents. Add a Quick reference row. `SKILL.md`
  has `model: haiku`, so run the repo's Skill Editing Verification loop.
- Update callers: `references/plans.md` (`plan get` id lookup ~lines 31–35, `plan list`,
  `plan tasks`, `plan note list`), `references/task-commands.md` (list, recent, changelog
  list, deps validate), `commands/task-read.md`, `commands/plan-read.md`,
  `skills/project-tasks/tests/test-log-task.md`, `test-run-task.md`, and the `task get`
  comment in `lib/cli.mjs` (~line 254).
- Tests: formatter unit tests (record list, single record, zero-row record list, text,
  multi-part, single-part, empty result, `warnings`) in all three formats; `json` is an
  object for single-part and multi-part results alike; no-flag output equals
  `--format pipe` for every converted command; `--format md` never creates a file named
  `md`; pipe escaping round-trips a value containing `|`, a backslash, a newline, and a
  leading `## `; `--output-file` with `--format json` writes JSON and returns a JSON
  `status`; unknown `--format` value errors; `--content-only` with `--format` is
  rejected; md validity check with `micromark` on `task list`, including an empty
  project.

### 3. Document reads on the result model

Depends on step 2.

- Move `plan progress` and `plan status` onto the part layouts above; `--counts` becomes a
  part selection.
- Move the `plan status` unmatched-anchor warning (`lib/plan-read.mjs:349`) from stderr
  into the `warnings` part.
- Update callers: `references/plans.md` (`show plan`, status/progress renders, and the
  instruction at ~line 282 to pass the unmatched-anchor warning on, which now reads it
  from `warnings`) and the accept-flow `--counts` read in `references/task-execution.md`.
- Extend the `SKILL.md` Output formats section with the two plan documents; rerun the
  Skill Editing Verification loop.
- Tests: all three formats for both commands; `--counts` in all three formats; the
  unmatched-anchor warning appears in `warnings` and not on stderr; md validity check on
  the `plan progress` tasks table.

### 4. Mutation results

Depends on step 2.

- Every mutation returns a `status` part plus every changed object, as specified above;
  `plan propose` also returns its `diff` part.
- Move the `plan propose` candidate-already-staged warning (`lib/plan-sync.mjs:646`) and
  the `plan detach` missing-file warning (`lib/plan-sync.mjs:948`) into the `warnings`
  part.
- Update callers that read mutation output, including `references/plans.md` ~line 155,
  which says the `plan propose` diff is on stdout (it is now the `diff` part): `references/task-commands.md` (the `#NNN`
  from `task add`, changelog mark), `references/plans.md` (`plan create` `P###`,
  create-tasks, apply, note add), `references/task-execution.md`,
  `references/validation-flow.md`.
- Extend the `SKILL.md` Output formats section with the mutation result shape; rerun the
  Skill Editing Verification loop.
- Tests: each mutation returns a success status plus all changed objects, in all three
  formats; `plan propose` on exit `3` returns the full, untruncated `diff`; both moved
  warnings appear in `warnings` and not on stderr; idempotent `task add` replay returns
  the existing task.

### 5. Errors on stdout

Depends on step 2 (uses the `status` part and `--format`).

- `bin/task-db` formats `CliError`/`DbError` as a `status` part on stdout; stderr stays
  empty; exit codes unchanged.
- Update callers that read stderr: `commands/init.md` (`db init` exit handling),
  `references/plans.md` (propose/attach/detach/apply error handling).
- Extend `SKILL.md`; rerun the Skill Editing Verification loop.
- Tests: representative parse, validation, and database errors in all three formats;
  an error has the same shape as a success on the same command (a `json` object with a
  `status` key); empty stderr on every command, including any warning path; exit codes
  unchanged, including `2` for first-time `db init` and `3`/`4` for `plan propose`.

### 6. Plan body truncation

Depends on step 4 (plan objects in mutation results).

- Linked plans show only the file path; inline plans truncate to about 500 characters with
  an omitted-character marker, in mutation results, `plan get`, and `plan list`.
- Update `references/plans.md` create-tasks: it reads the full body, so it must use
  `plan get --content-only` rather than `--with-content`.
- Extend `SKILL.md`; rerun the Skill Editing Verification loop.
- Tests: linked plan shows only its path; inline plan under the limit is untouched; inline
  plan over the limit is truncated with the correct omitted count; `--content-only`,
  `plan status`, and the `plan propose` diff are never truncated.

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
