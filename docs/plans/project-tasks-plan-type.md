# Add "plan" (epic) support to project-tasks

## Context

`project-tasks` captures flat, independent units of work (`task:`/`fix:`/`todo:`) into
`~/.claude/tasks.db`. There is no way to express "these fifteen tasks all came from one
design document." When a plan document changes, nothing finds the tasks derived from it,
so the task list silently drifts from the document justifying it. Turning a written plan
into tasks is manual re-typing every time.

Plans become an epic-level record, either holding content inline or linked to a file on
disk. `plan propose` stages a content change and returns a diff; `plan apply` commits it;
task reconciliation follows by anchor. A `notes` history makes the plan's evolution
auditable, so `plan status` narrates how the work reached its current state rather than
only tabulating it.

The command surface moves into namespaces at the same time, since the plan family would
otherwise add 16 flat tokens to an already-flat 13.

## Decisions

| Area | Choice |
|---|---|
| Storage | Separate `plans` table — no rebuild of `tasks`, 347 existing rows untouched |
| Linkage | `tasks.plan_id INTEGER REFERENCES plans(id) ON DELETE RESTRICT`; `plans.id` is global so one plan may intentionally hold tasks from multiple repositories/projects |
| Statuses | Same four as tasks: `pending`, `in_progress`, `completed`, `cancelled`; completing a plan with non-terminal children requires a force-complete confirmation |
| Cancelling a plan | Cascades to child tasks, skipping `completed`; if any child is `in_progress` or `completed`, the skill explains the consequence and requires AskUserQuestion confirmation before mutation |
| Creation from a path | Always fork via AskUserQuestion: **Import** or **Link** |
| Import safety | Verify sha256 from DB against disk, then unlink; warn if git-tracked |
| Content updates | `plan propose` stages + diffs; `plan apply` commits exactly those bytes; a detach with source changes requires confirmation and retains those bytes as pending until reconciliation completes |
| Source changes | `plan attach --path` / `plan detach` — symmetric pair |
| Task↔plan match | Stable `plan_anchor` slug, unique per `(plan_id, plan_anchor)` |
| Drift handling | Propose, then apply on approval; completed tasks never auto-cancelled |
| Notes | JSON array, stable per-plan ids, helper auto-appends lifecycle entries |
| Note mutation | `--force` required to delete/replace lifecycle kinds |
| Command surface | Nested namespaces, 29 commands, **hard cutover — no aliases** |
| Output | Global `--output-file`; payload to file, one-line confirmation to stdout |
| Two artifacts | `plan status` = annotated body; `plan progress` = table + summary |
| Changelog | Group child tasks under a plan heading |

## Critical files

- `plugins/project-tasks/bin/task-db` — 353 lines; schema, SQL, and the dispatch rewrite.
- `plugins/project-tasks/skills/project-tasks/SKILL.md` — 836 lines, `model: haiku`,
  **25 call sites to rewrite**.
- `plugins/project-tasks/skills/project-tasks/references/plans.md` — new.
- `plugins/project-tasks/task-db.test.mts` — new.
- Both plugin `plugin.json` files, `.claude-plugin/marketplace.json`, `README.md`,
  `CHANGELOG.md`, `package.json`, `package-lock.json`.

---

## 1. Command surface

Three-level dispatch on `argv[0..2]`, replacing the flat `switch (cmd)`. Old names error
out naming their replacement.

```
db     init · migrate

task   add · update · get · list · recent
       deps      check · validate · blocked · unblocked
       changelog list · mark

plan   create · list · get · tasks · status · progress
       propose                    ← stage + diff
       attach · detach            ← set / clear the linked path
       apply · discard            ← resolve staged
       update                     ← title, status, tags
       note      add · list · replace · delete
```

Renames: `insert`→`task add`, `update`→`task update`, `get`→`task get`, `list`→`task list`,
`recent`→`task recent`, `check-deps`→`task deps check`, `validate-deps`→`task deps validate`,
`blocked`→`task deps blocked`, `unblocked`→`task deps unblocked`,
`changelog`→`task changelog list`, `mark-changelog`→`task changelog mark`,
`init`→`db init`, `migrate`→`db migrate`.

The parallel pairs — `task update` ↔ `plan update`, `task list` ↔ `plan list`,
`task get` ↔ `plan get` — are the point: they make the surface self-documenting for a
haiku agent selecting from a reference file.

## 2. Schema

`db init` keeps the existing create-if-missing + additive-`ALTER` pattern (see
`feedback`/`completed_at`, lines 109–116). No table rebuild.

```sql
CREATE TABLE IF NOT EXISTS plans(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN('inline','linked')),
    path TEXT,                -- live path; linked plans only
    origin_path TEXT,         -- provenance for imported / detached plans
    content TEXT,             -- inline body, or last-applied snapshot
    content_hash TEXT,
    synced_at TEXT,
    pending_content TEXT,     -- staged candidate awaiting apply
    pending_hash TEXT,
    pending_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN('pending','in_progress','completed','cancelled')),
    notes TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    created TEXT NOT NULL,
    updated TEXT,
    UNIQUE(project,seq)
);
```

Additive on `tasks`: `plan_id INTEGER REFERENCES plans(id) ON DELETE RESTRICT`,
`plan_anchor TEXT`, `commit_sha TEXT`.

`plans.id` is the cross-repository identity used by `task --plan-id`; `plans.seq` remains
project-local and is only the human-facing `P###` display id. This is deliberate: a plan
may describe coordinated frontend and backend work. `plan tasks` and `plan progress` must
therefore include each child task's `project` column so duplicate `#NNN` ids are never
ambiguous.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_plan_anchor
  ON tasks(plan_id, plan_anchor) WHERE plan_anchor IS NOT NULL;
```

**`PRAGMA foreign_keys=ON;` must be prepended to every query in `sql()`.** The pragma is
per-connection and defaults to off, and `sql()` spawns a fresh `sqlite3` process per call —
verified: without it, an insert with a nonexistent `plan_id` succeeds silently. One line,
invisible if missed, and it is the difference between a constraint and a comment.

**Two prerequisites for the "when + sha" annotations.** `commit_sha` is populated from
`git rev-parse HEAD` right after the accept-step commit (SKILL.md line 573). And
`completed_at` — which exists as a column but which the skill never writes, since the
accept flow only passes `--status completed`, which is why the changelog falls back to
`updated` — must now actually be set.

### Note objects

```json
{ "id": 3, "ts": "2026-08-09 15:02", "kind": "manual",
  "tasks": [
    { "project": "github.com/acme/backend", "seq": 12 },
    { "project": "github.com/acme/frontend", "seq": 13 }
  ], "note": "rescoped after review", "edited": "2026-08-09 15:40" }
```

`kind` ∈ `created | tasks-created | applied | reconciled | status | manual`; `hash` present
on `applied`. (`applied` rather than `synced`, matching `plan apply` — command names and
note kinds should not use different words for the same event.)

New note task references are project-qualified as `{ "project": "...", "seq": N }` and
the CLI accepts `<project>#<positive-seq>` repeatedly. Existing stored integer references
remain unchanged; readers interpret a legacy integer as `{ "project": plan.project,
"seq": integer }` only while rendering. They never fall back to another child project with
the same sequence, and `plan note list` returns the original stored JSON.

Ids allocate as `MAX(id)+1` within the plan and are never reused — verified that deleting
id 2 leaves ids `1,3` with the next allocation still 4, so a `list` → `delete` sequence
cannot hit the wrong entry. `addNote` calculates that maximum inside the same `UPDATE` that
uses `json_insert(notes,'$[#]',json('…'))`; it never reads the maximum into JavaScript.

### Concurrent writers

`sql()` prepends both `PRAGMA foreign_keys=ON;` and `PRAGMA busy_timeout=5000;`. Any
operation that changes more than one row or combines a state change with an auto-note runs
as one `BEGIN IMMEDIATE` / `COMMIT` batch through a single `sqlite3` process: plan creation
plus `created` note, task-start plan promotion, apply plus `applied` note, status cascades
plus `status` note, and attach/detach transitions. On a timeout or other SQL failure, the
batch rolls back and the helper returns an actionable error; it never leaves a half-applied
plan transition. This is intentionally small infrastructure (one shared wrapper and a
handful of command batches), not a new database layer.

## 3. Helper internals

- `slugify(text)` — every `--anchor` normalized on input, so an agent passes a raw heading
  and gets `step-3-add-jwt-middleware`. One code path, no agent-side variance.
- Content I/O via `readfile()`/`writefile()` — never push plan bodies through `esc()` into
  SQL literals.
- `sha256` via `node:crypto`; `emit(payload)` as the single stdout choke point.
- `addNote(planId, kind, {tasks, note, hash})` — shared by auto-notes and `plan note add`.
- `--output-file <path>` on every command: payload to the file (parent dirs created,
  overwrite), `<n> bytes → <path>` to stdout, exit codes untouched so `propose`'s 0/3/4
  survive redirection.

### Plan commands

| Command | Behavior |
|---|---|
| `plan create --title T [--path ABS \| --content-file F] [--origin ABS]` | Linked or inline. Auto-note `created`. Prints `P%03d` |
| `plan get --seq N [--with-content] [--content-only]` | `-json` (including the global numeric `id` used for `--plan-id`), or raw body with `--content-only` — pairs with `--output-file` as the export/restore path |
| `plan list [--status S]` | `P001\|title\|source\|status\|done\|total\|drift` |
| `plan tasks --seq N [--status S]` | `#012\|project\|anchor\|type\|title\|priority\|status` — `project` is required because a global plan may span repositories. **`--project` identifies the plan's owner and never filters the children**: every child task is returned regardless of repository, and callers filter on the `project` column. There is deliberately no per-repo filter flag — a second project-ish flag on the same command is exactly the near-collision the namespacing was meant to remove |
| `plan status --seq N [--limit N]` | Stored body verbatim, blockquote status line under each heading whose slug matches an anchor, notes bearing that task's ref rendered beneath it, unattributed notes in a `## History` footer (last 10 + `(N earlier notes)`). No heading matches ⇒ body verbatim + stderr warning naming unmatched anchors; never silently falls back to the table |
| `plan progress --seq N [--counts]` | Header (title, source, drift, `3/7 complete`), task table (ID, project, step, status, when, commit), deterministic one-paragraph summary, latest note. `--counts` ⇒ `total\|pending\|in_progress\|completed\|cancelled\|blocked` |
| `plan propose --seq N [--content-file F]` | Stage a content change. Bare ⇒ re-read `path` (linked only). `--content-file` ⇒ supplied body (inline only). Exit `3` + unified diff when changed, `0` + clear staging when identical, `4` on unreadable path. If a candidate creates a duplicate slug for an existing task anchor, return an error without staging. |
| `plan attach --seq N --path ABS` | Set `path`, flip to linked, stage that file's content. Refuses while a different candidate is pending until it is applied or discarded. |
| `plan detach --seq N [--delete-file] [--confirm-source-change]` | If the live file matches the applied hash, copy current content in, clear `path`, flip to inline, record `origin_path`; `--delete-file` then unlinks. If it differs, the helper requires `--confirm-source-change`; the skill must ask first, then detach while preserving the live bytes as `pending_content` for reconciliation. It leaves a changed source file in place and refuses `--delete-file` until the pending content is applied or discarded. |
| `plan apply --seq N` | Promote `pending_*` → `content`/`content_hash`/`synced_at`, clear staging, auto-note `applied` with the hash. Refuses when nothing staged |
| `plan discard --seq N` | Clear staging |
| `plan update --seq N [--title T] [--status S] [--tag …]` | Mirrors `task update`. On `--status cancelled`, first reports `in_progress` and `completed` children; only `--confirm-cancel` performs the cascade to non-completed children and writes the `status` note. On `--status completed`, non-terminal children require `--force-complete`, which marks those children completed with the current timestamp and records them in the lifecycle note. |
| `plan note add\|list\|replace\|delete --seq N [--id N] …` | `--task <project>#<positive-seq>` is repeatable and stores qualified objects; `add --kind` accepts only `manual`, `tasks-created`, `reconciled` — `created`/`applied`/`status` are helper-emitted and cannot be forged from argv. `--force` required to replace or delete a lifecycle kind; `replace` preserves `ts` and stamps `edited` |

### Source-type guards

The two nonsense combinations error explicitly rather than being left undefined:

```
$ task-db plan propose --seq 2          # inline plan
ERROR: P002 is inline — no source file to re-read.
       Pass --content-file, or use 'plan attach' to link one.

$ task-db plan propose --seq 1 --content-file /tmp/new.md   # linked plan
ERROR: P001 is linked to /Users/…/auth.md.
       Edit that file and run 'plan propose', or use
       'plan attach' to point at a different file.
```

The second is the important one: for a linked plan the file is the source of truth, so the
workflow is *edit the file, then propose* — never push content through the DB behind the
file's back, which would leave stored content contradicting the file it claims to track
and the drift indicator firing forever.

### Task commands

`task add`/`task update` accept global `--plan-id N` (not a project-local `P###` sequence),
`--anchor T`, and `--commit-sha SHA`. A task may intentionally use a plan owned by another
project. `create-tasks` resolves the numeric id from `plan get --seq` before inserting.
`task add` uses `ON CONFLICT DO NOTHING` then selects by anchor, printing the existing
`#NNN` — this is what makes `create-tasks` re-runnable. `--anchor` without
`--plan-id` errors. `task list` and `task changelog list` append a trailing display `P###`
(LEFT JOIN on `plans.seq`), empty for plan-less rows; cross-project labels also include the
plan's project. `task get` resolves the same LEFT JOIN into `plan_seq` (`P###`) and
`plan_project` alongside the raw `plan_id`, so a caller holding a task never needs a second
query to reach its plan's `--seq` commands — the global `plan_id` alone would force one. When
`task update` moves a task with a `plan_id` to `in_progress`, the same invocation promotes
its plan `pending → in_progress` via a guarded update — lifecycle bookkeeping the skill
cannot forget.

Heading detection in `plan status` is the only place the helper touches markdown: one
regex (`^#{1,6}\s+(.*)$`) plus a slug lookup, not a parser. Before staging a proposed body,
the helper rejects any duplicate heading slug that matches an existing task anchor. The skill
returns that error to the user, names the colliding headings/tasks, and suggests renaming a
heading or selecting distinct step headings; it does not guess an anchor or annotate both.

## 4. Skill changes

SKILL.md is 836 lines on `model: haiku`. Plan workflows go in `references/plans.md`, loaded
only when a plan trigger fires; SKILL.md gains ~30 lines (triggers, the P### vs #### ID
distinction, a pointer to the reference, Quick Reference rows) and has its **25 existing
call sites rewritten** to the namespaced form.

**Completion hook** in Step 4: pass `--completed-at` and `--commit-sha` after the commit;
if the task has a `plan_id`, run `plan progress --counts` and offer to close the plan when
no incomplete siblings remain.

**`references/plans.md`.** Creating from a file path never assumes — it presents:

> **a) Import** — copy the plan into the database and delete the file from disk. The
> database becomes the single source of truth; there is nothing left to drift.
>
> **b) Link** — keep the file where it is and store a reference plus a content snapshot.
> Edits are picked up by `plan propose`, which reconciles the tasks.

Import runs `plan create --content-file <path> --origin <path>`, reads the content back,
compares sha256 to disk, unlinks only on exact match, and warns first if the file is
git-tracked. Restore is `plan get --seq N --content-only --output-file <path>`. Inline
content skips the question.

**Destructive transitions.** Before calling `plan detach --confirm-source-change`, the skill
uses AskUserQuestion when the linked source differs from its applied hash:

> This file has plan changes that have not been reconciled into tasks. Detaching will retain
> those bytes as a pending change, leave the changed file on disk, and require reconciliation
> before it can be deleted. Proceed?

Before `plan update --status cancelled --confirm-cancel`, it names the in-progress and
completed child tasks and explains that non-completed children will be cancelled. Before
`plan update --status completed --force-complete`, it lists the pending/in-progress children
and asks: “There are incomplete tasks. Do you want to mark them all completed?” No confirming
flag is issued without an affirmative answer.

**`create-tasks`** decomposes the plan into steps, derives an anchor per step heading,
presents the derived list for approval before inserting, then records one
`plan note add --kind tasks-created` for the batch.

**The reconciliation loop**: `plan propose` → read the diff and `plan tasks` → classify
each change by anchor as added / modified / removed → present a table → on approval apply
the task changes then `plan apply`; on refusal `plan discard`. Never auto-cancel or rewrite
a `completed` task — flag it as *"plan changed after this task completed"*.

**Changelog** — plan groups first, then the existing flat sections:

```markdown
## 2026-08-09

### Auth rewrite (P001)
- Add JWT middleware (#jwt)
- Migrate sessions to the new store

### Fixes
- Login returns 500 on expired token (#auth)
```

## 5. Tests

`tests/packages/task-db/index.md` documents a `node:test` approach and ships nothing. Add
`plugins/project-tasks/task-db.test.mts` with `PROJECT_TASKS_HOME` on a temp dir. Cover:

- **`db init` additive migration against an old-schema DB** — highest-risk regression.
- **FK enforcement actually on** — bad `plan_id` must fail, `ON DELETE RESTRICT` must block.
- `plan create` both sources and `origin_path`.
- One global plan linked to tasks from two projects: `plan tasks`/`plan progress` identify
  each child project's task id unambiguously; `--anchor` without `--plan-id` errors.
- Anchor idempotency: same anchor twice ⇒ one row, same `#NNN`.
- `propose` staging with exit codes 0/3/4 and both source-type guard errors.
- `apply` promoting staged bytes even after the source file changes post-diff.
- `discard`.
- `attach`/`detach` round-trip including `--delete-file` hash verification, changed-source
  confirmation, preserved pending bytes, and refusal to delete before reconciliation.
- Cancel confirmation reports `in_progress`/`completed` children; only
  `--confirm-cancel` cascades and it still skips `completed`.
- Complete confirmation refuses non-terminal children without `--force-complete`; the force
  path marks the listed children completed and writes one lifecycle note.
- Notes add/list/replace/delete with stable ids, `--force` guard, and prose containing
  quotes and newlines staying valid JSON.
- Qualified note parsing normalizes project segments, rejects bare or malformed references,
  matches cross-project children by `(project, seq)`, and preserves legacy integer refs only
  at read time without rewriting their stored JSON.
- `plan status` heading-match, no-match warning, inline note attribution, and a duplicate
  matched heading slug producing a specific error and no staged mutation.
- `plan progress` both rendered and `--counts`.
- Plan auto-advance `pending → in_progress` on first child dispatch.
- `--output-file` preserving exit codes.
- Parallel child-process writers: two note appends retain unique, monotonic note ids; two
  same-project plan creates receive distinct sequences; a forced lock timeout rolls back
  without a partial plan/status/note update.
- Trailing `P###` in `task list` / `task changelog list`, and plan-less rows still parsing.
- **Every old flat command name erroring with a message naming its replacement.**

Update `tests/packages/task-db/index.md` and `tests/plugins/project-tasks/index.md`.

## 6. Skill verification loop (required by `CLAUDE.md`)

`SKILL.md` carries `model: haiku`, and with a hard cutover there is no alias safety net — a
single stale call site is a silent runtime failure.

The *mechanical* half of that risk is covered automatically by the call-site lint in
`docs/plans/task-db-cli-parsing.md` (Group B), which extracts every `$TASK_DB` invocation
from `SKILL.md` and `references/plans.md` and asserts each routes through `parseArgv`. A
call site left on `check-deps`, or typo'd to `plan aply`, fails the test suite rather than
surfacing in a subagent transcript. **That lint must be green before this loop starts** —
otherwise the loop spends its iterations rediscovering typos.

What the loop is still for is the half a parser cannot check: whether the instructions are
unambiguous, whether the Import/Link fork is presented correctly, and whether reconciliation
is proposed rather than applied. So:

1. Dispatch a haiku subagent with the edited `SKILL.md` + `references/plans.md` and a
   realistic sequence (`plan: /abs/path.md` → answer Import → `create-tasks` → edit →
   propose → approve → `plan status`), plus at least one pure-task flow (`fix:` → run →
   accept) to exercise the renamed task commands.
2. Pass its report to an Opus verifier for APPROVED / NEEDS REVISION.
3. Loop until APPROVED.

## 7. Docs and versioning

- README `### project-tasks` section — plans, the `plan:` prefix, Import vs Link, the P###
  ID space, the propose/apply loop.
- `plugins/project-tasks/.claude-plugin/plugin.json`,
  `plugins/project-tasks/.codex-plugin/plugin.json`, and the `project-tasks` entry in
  `.claude-plugin/marketplace.json`: `1.0.1` → **`2.0.0`** (the command rename is breaking),
  with plans in `description`/`keywords` and a plan entry in the Codex
  `interface.defaultPrompt`. Assert the three values match in the release check.
- Post-commit per `CLAUDE.md`: bump `package.json` patch, bump **both** version fields in
  `package-lock.json` (top-level and `packages[""]`), add a `CHANGELOG.md` entry.
- `plugins/` change → marketplace install, **no** `install-packages` prompt.

## Verification

```bash
export PROJECT_TASKS_HOME=$(mktemp -d)
T="node plugins/project-tasks/bin/task-db"
$T db init

# Link + import branches
cp docs/plans/lean-agents-exitplanmode.md /tmp/p.md
$T plan create --project testproj --title "Exit plan mode" --path /tmp/p.md    # → P001
cp docs/plans/lean-agents-exitplanmode.md /tmp/q.md
$T plan create --project testproj --title "Imported" --content-file /tmp/q.md --origin /tmp/q.md
$T plan get --project testproj --seq 2 --content-only --output-file /tmp/restored.md
diff /tmp/q.md /tmp/restored.md && echo "round-trip clean"

# Source-type guards
$T plan propose --project testproj --seq 2                          # inline, bare → ERROR
$T plan propose --project testproj --seq 1 --content-file /tmp/q.md # linked + body → ERROR

# FK enforcement + cross-project anchor idempotency
$T task add --project testproj --type task --title "Orphan" --plan-id 999   # must FAIL
$T task add --project testproj --type task --title "Step one" --plan-id 1 --anchor "Step 1: Do the thing"
$T task add --project frontend --type task --title "Frontend step" --plan-id 1 --anchor "Frontend step"
$T task add --project testproj --type task --title "Step one" --plan-id 1 --anchor "step-1-do-the-thing"  # same #NNN
$T plan tasks --project testproj --seq 1

# Auto-advance
$T task update --project testproj --seq 1 --status in_progress
$T plan list --project testproj    # P001 should read in_progress

# Staging beats a mid-review edit
$T plan propose --project testproj --seq 1; echo "exit=$? (expect 0)"
printf '\n## New step\n' >> /tmp/p.md
$T plan propose --project testproj --seq 1 --output-file /tmp/d.patch; echo "exit=$? (expect 3)"
printf '\n## Sneaky late edit\n' >> /tmp/p.md      # after review
$T plan apply --project testproj --seq 1
$T plan get --project testproj --seq 1 --content-only | grep -c "Sneaky"   # expect 0

# discard drops the candidate without touching applied content
printf '\n## Rejected step\n' >> /tmp/p.md
$T plan propose --project testproj --seq 1; echo "exit=$? (expect 3)"
$T plan discard --project testproj --seq 1
$T plan get --project testproj --seq 1 --content-only | grep -c "Rejected"  # expect 0
$T plan apply --project testproj --seq 1; echo "exit=$? (expect nonzero, nothing staged)"

# attach / detach
$T plan attach --project testproj --seq 2 --path /tmp/p.md && $T plan apply --project testproj --seq 2
$T plan detach --project testproj --seq 2
$T plan list --project testproj    # P002 back to inline, origin_path recorded

# Notes
$T plan note add --project testproj --seq 1 --note "rescoped after review" --task "github.com/acme/backend#001" --task "github.com/acme/frontend#001"
$T plan note list --project testproj --seq 1
$T plan note delete --project testproj --seq 1 --id 1            # lifecycle → must FAIL
$T plan note delete --project testproj --seq 1 --id 1 --force    # → succeeds

# The two artifacts
$T plan status   --project testproj --seq 1 --output-file /tmp/status.md
$T plan progress --project testproj --seq 1
$T plan progress --project testproj --seq 1 --counts

# Cancel confirmation cascades only after acknowledgement and skips completed
$T task update --project testproj --seq 1 --status completed --completed-at "2026-08-09 12:00" --commit-sha deadbeef
$T plan update --project testproj --seq 1 --status cancelled                  # must report confirmation needed
$T plan update --project testproj --seq 1 --status cancelled --confirm-cancel
$T plan tasks --project testproj --seq 1    # completed untouched, rest cancelled

# Hard cutover + changelog
$T insert --project testproj --type fix --title "x"   # must FAIL naming 'task add'
$T task list --project testproj
$T task changelog list --project testproj --new-only

node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts
```

**Old-schema migration check** — the highest-risk step. Copy the real DB to
`/tmp/tasks.db`, run the new `db init` with `PROJECT_TASKS_HOME=/tmp`, then verify
`.schema plans`, `PRAGMA table_info(tasks)`, and `SELECT count(*) FROM tasks` matching the
original 347.

**Live end-to-end:** `plan: <abs path>` → confirm the Import/Link question fires →
`create-tasks` → edit the plan file → `update plan P001` → confirm reconciliation is
proposed rather than applied → `plan status P001` shows the applied note inline under the
changed step.
