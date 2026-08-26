# task-db Tests

Tests for the `task-db` package used by the project-tasks skill. The package is
a nested CLI wrapper over SQLite; the helper is exposed through the plugin's
`bin/` directory while the plugin is enabled.

## CLI and module coverage

The CLI routes through these nested command families:

- `db init|migrate`
- `task add|update|get|list|recent|deps …|changelog …`
- `plan create|list|get|tasks|status|progress|propose|attach|detach|apply|discard|update|note …`

The flat commands intentionally fail and identify their nested replacements;
there are no compatibility aliases.

Module ownership is split as follows:

| Module | Ownership |
|--------|-----------|
| `bin/task-db` | Parse/dispatch and the error boundary |
| `lib/cli.mjs`, `registry.mjs`, `normalize.mjs` | Route definition, validation, and canonicalization |
| `lib/db.mjs`, `schema.mjs` | SQLite access, transactions, storage path, and additive schema |
| `lib/handlers.mjs` | Database, task, and basic-plan handlers |
| `lib/plan-read.mjs` | Plan reporting |
| `lib/plan-sync.mjs` | Reconciliation and lifecycle mutations |

## Test files

| File | Covers |
|------|--------|
| `plugins/project-tasks/task-db.test.mts` | Normalization, registry/parser behavior, and hard-cutover call-site lint |
| `plugins/project-tasks/task-db.integration.test.mts` | Dispatch, migrations, schema/FKs, task/plan/note handlers, transactions, and concurrency |
| `plugins/project-tasks/task-db.plan-read.test.mts` | Plan tasks, status, and progress |
| `plugins/project-tasks/task-db.plan-sync.test.mts` | Propose/apply/discard, attach/detach, lifecycle updates, and atomic rollback |

## Running

The canonical four-suite command is:

```bash
node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts plugins/project-tasks/task-db.integration.test.mts plugins/project-tasks/task-db.plan-read.test.mts plugins/project-tasks/task-db.plan-sync.test.mts
```

## Structure

The parser suite retains the four Group A-D explanations from the original
design. Groups A-C are external checks and Group D is self-referential.

| Block | Guards against | Self-referential? |
|-------|----------------|-------------------|
| `normalize` | A "cleanup" of a join key silently fragmenting existing rows | n/a |
| A. Doc-derived fixtures | The registry drifting from the parent plan | **No** |
| B. Skill call-site lint | The hard-cutover call sites in `SKILL.md` landing wrong | **No** |
| C. Coverage assertions | A command or flag specified but never exercised | **No** |
| D. Parser logic cases | Coercion and cross-flag logic bugs | Yes |

### A — doc-derived fixtures

Every `$T …` line in the Verification section of
`docs/plans/project-tasks-plan-type.md` is extracted **at run time** and fed
through `parseArgv`. Nothing is hand-transcribed, so editing that verification
block without updating the registry fails the suite.

The parent plan's `# must FAIL` / `→ ERROR` markers describe *end-to-end*
behavior, not parse behavior. Failures that depend on database state — FK
violations, `plan propose` source-type guards, the lifecycle-note guard on
`plan note delete` — are carved out in a `RUNTIME_GUARDS` table and asserted to
**parse clean**, which is what stops a later slice from mistaking them for
parser work. A companion assertion fails if a carve-out stops matching any
marked line, so the list cannot go stale.

### B — skill call-site lint

Every `$TASK_DB …` invocation in the skill's fenced Bash blocks is extracted,
has placeholders substituted, and must route through `parseArgv` without
throwing. Group B now enforces the nested skill call sites; it is no longer a
parser-only skip for legacy flat names. The transition assertions still ensure
that call-site extraction is non-empty and referenced files exist.

### C — coverage assertions

Derived from the `COMMANDS` table, so they cannot go stale: every command and
every option must appear in at least one hand-written or doc-derived fixture,
every member of every referenced enum must be accepted somewhere, and every
rename must throw naming its replacement.

These read a ledger that groups A and D populate as they run, which is why **C
is declared last** — do not reorder the blocks. The canonical round-trip at the
end of C builds argv from the registry itself and deliberately does *not* feed
that ledger; if it did, "specified but never exercised" would be unfalsifiable.

### D — parser logic cases

Coercion (`int`, `enum`, `abspath`, `ts`, `sha`, `slug`), cross-flag rules
(`required`, `exclusive`, `requires`, `requiresValue`, `atLeastOne`), routing,
the rename table, nearest-match hints, `--help` at every depth, purity, and
exit codes.

Two contrasting pairs carry more weight than the rest and should not be
simplified away:

- `--seq` repeated on `task get` **throws**, while the identical shape on
  `task changelog mark` yields `seqs: [1, 2]`. Differing arity is the one
  legitimate reason for a flag to map to a different key.
- `--kind manual|tasks-created|reconciled` is accepted while
  `--kind created|applied|status` is rejected. That is the write-side half of
  the audit-trail invariant; guarding only the other half would read as
  protection without being any.

**Record results in:** [test-results.md](test-results.md)
