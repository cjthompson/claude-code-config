# task-db CLI argument parsing layer

## Context

`docs/plans/project-tasks-plan-type.md` adds plan/epic support. Two things in it are
independently risky and independently testable:

1. **The command surface changes shape** — 13 flat commands → 29 nested ones across three
   levels (`db init`, `task deps check`, `plan note add`), with **no aliases**. Every one of
   the 25 call sites in a `model: haiku` SKILL.md must land on the right command; a stale
   call site is a silent runtime failure.
2. **The flags stop being uniform** — `--seq` is a single int for `task get` but a repeatable
   list for `task changelog mark`. `--path` must be absolute, `--content-file` need not be.
   `--path` xor `--content-file` on `plan create`. `--anchor` is meaningless without
   `--plan-id`, which is a global id rather than the `P###` display sequence.

Today `bin/task-db` parses with three globals — `get(flag)`, `all(flag)`, `has(flag)`
(lines 39–54) — that `indexOf` the whole `argv`. They express none of the above, and detect
no unknown flag, missing value, repeated flag, or non-numeric `--seq`. `get('--title')`
returns `"--status"` when the value is omitted. Under a haiku caller and a hard cutover,
silence is the wrong failure mode.

**This plan delivers the parsing layer only** — a pure, exported `parseArgv(argv)` returning
a validated `Action`: the internal function call described but not yet invoked. Schema, SQL,
handlers, and the dispatch rewrite are out of scope; `bin/task-db` keeps its current
`switch`.

`parseArgv` is therefore uncalled when this lands, and the repo briefly carries two parsers.
That is deliberate and bounded: this is an increment on a feature branch, not a release —
nothing merges to `main` until the rest of the feature is implemented, so the dead-code
window never reaches a shipped state. What it buys is a surface that is unit-testable
without sqlite3, and a command specification made concrete before 25 haiku call sites are
rewritten against it.

## Approach

### File layout

`bin/task-db` is extensionless, so Node cannot `import` it — parsing must move to a sibling
`.mjs` to be unit-testable. Verified on Node v24.14.0 that an extensionless entry with
`import '../lib/x.mjs'` resolves under module-syntax detection, which `bin/task-db` already
relies on.

```
plugins/project-tasks/
  bin/task-db          # UNCHANGED (except one import, below)
  lib/registry.mjs     # NEW — command spec table + rename map
  lib/normalize.mjs    # NEW — normalizeProject (moved), slugify (new)
  lib/cli.mjs          # NEW — parseArgv(), CliError, suggest()
  task-db.test.mts     # NEW — imports parseArgv directly
```

`normalizeProject` (`bin/task-db:76–84`) moves verbatim into `lib/normalize.mjs`;
`bin/task-db` gains one import and drops its local copy. That is the only edit to it — no
dispatch change — and it stops the parser carrying a second, drifting normalizer.

> **Risk:** SKILL.md's last-resort fallback (`~/.claude/task-db.mjs`, lines 59–61) assumes a
> self-contained file. That copy is a frozen artifact of the retired TUI installer and keeps
> working; the fallback branch should be deleted when the dispatch rewrite lands.

### `lib/normalize.mjs`

- `normalizeProject(raw)` — moved as-is.
- `slugify(text)` — lowercase, non-alphanumerics → `-`, collapse and trim runs.
  `"Step 1: Do the thing"` → `step-1-do-the-thing`. Idempotent, per §3's requirement that
  every `--anchor` normalize on input. ASCII-only (`[^a-z0-9]+`), so `"Café déjà vu"` →
  `caf-d-j-vu` — mangled but stable, unique, and idempotent, which is all an anchor needs.

  **An empty slug is a parse error.** `slugify` returns `''` for input with no ASCII
  alphanumerics (`"日本語"`, `"🎉"`, `"!!!"`), and an empty anchor is the one value that
  breaks the join silently rather than loudly: `plan_anchor = ''` is non-NULL, so the
  partial unique index `ON tasks(plan_id, plan_anchor) WHERE plan_anchor IS NOT NULL`
  treats every empty anchor as the same key. Combined with `task add`'s `ON CONFLICT DO
  NOTHING` then select-by-anchor, the second such heading would return the *first*
  heading's `#NNN` and report success — two unrelated plan steps silently collapsing into
  one task. The `slug` coercion therefore rejects an empty result, naming the offending
  input and telling the user to rename the heading.

### `lib/registry.mjs`

Plain data. No logic, so the follow-up plan attaches handlers without touching the parser.

```js
export const ENUMS = {
  status:   ['pending', 'in_progress', 'completed', 'cancelled'],
  type:     ['fix', 'task', 'todo'],
  priority: ['high', 'medium', 'low'],
  noteKind: ['created', 'tasks-created', 'applied', 'reconciled', 'status', 'manual'],
  // Kinds a caller may WRITE. `created`, `applied`, and `status` are emitted only by
  // the helper's own lifecycle hooks; accepting them from argv would let a caller forge
  // audit history, which is exactly what the --force guard on delete/replace prevents at
  // the other end. Guarding one side of an invariant and not the other is worse than
  // guarding neither, because it reads as protected.
  noteKindWritable: ['manual', 'tasks-created', 'reconciled'],
};

// Types: str | int | bool | enum | path | abspath | ts | sha | slug | taskref
// Suffix [] on any non-bool type ⇒ repeatable, collected into an array.
//
// Repeatable flags pluralize their key: --tag→tags, --req→reqs, --dep→deps,
// --task→tasks, --seq*→seqs. Stated explicitly because it is otherwise only
// inferable from scattered fixture assertions, and a transcriber has to guess.
//
// A flag name maps to one key PER ARITY. Same flag at the same arity ⇒ same
// key everywhere: --limit is `limit` on both `plan status` and `plan note
// list`, and a default value on one of them does not justify a different key.
// Differing arity is the one legitimate reason to differ: --seq is `seq` on
// every command except `task changelog mark`, where it is repeatable and
// therefore `seqs`. That contrast is deliberate and is asserted in Group D.
export const COMMANDS = {
  'plan note add': {
    handler: 'planNoteAdd',          // resolved by the follow-up plan, not here
    project: true,                   // --project required
    opts: {
      '--seq':  { key: 'seq',   type: 'int', required: true },
      '--note': { key: 'note',  type: 'str', required: true },
      '--kind': { key: 'kind',  type: 'enum', values: ENUMS.noteKindWritable, default: 'manual' },
      '--task': { key: 'tasks', type: 'taskref[]' },
    },
  },
  // …28 more
};
```

Plus `GROUPS` (`db`, `task`, `task deps`, `task changelog`, `plan`, `plan note`) for
"unknown subcommand of a known group" errors, and `RENAMES` (13 entries).

### `lib/cli.mjs` — `parseArgv(argv)`

Pure. Takes `process.argv.slice(2)`. Returns an `Action` or throws `CliError`. Never calls
`process.exit`, never writes to a stream.

```js
/** @typedef {{ kind:'run', command:string, route:string[], handler:string,
 *              opts:Object, global:{ project:string|null, outputFile:string|null } }} Action */
/** @typedef {{ kind:'help', command:string|null, usage:string }} Action */
```

**Algorithm**

1. **Route** — take the leading run of tokens not starting with `-` (`words`). Match
   `words[0..2]`, then `[0..1]`, then `[0]` against `COMMANDS`, longest first. Leftover word
   after a match → `unexpected argument`.
2. **Cutover check** runs before the unknown-command path: `words[0] ∈ RENAMES` throws
   naming the replacement.
3. **Flags** — accept `--flag value` and `--flag=value`. A flag not in the command's `opts`
   (nor global) errors. A value-taking flag consumes the next token verbatim *unless* that
   token is itself a recognized flag for this command, **or there is no next token** →
   `missing value` in both cases. (End-of-argv is the more common typo of the two and is
   easy to leave undefined; `get('--title')` returning `undefined` at the end of `argv` is
   one of the current silent failures this layer exists to remove.) `--flag=value` is the
   escape hatch for values starting with `-`.
   A bare non-flag token encountered *after* flag parsing has begun — `task get --seq 1
   extra` — is `unexpected argument`. The route rule in step 1 only governs the leading run
   of non-dash tokens, so this case needs its own guard rather than falling through.
4. **Coerce and validate** — `int` = `/^\d+$/`; `taskref` = `<project>#<positive-seq>` with the
   project normalized through `normalizeProject`; `enum` = membership; `abspath` =
   `path.isAbsolute`; `ts` = `YYYY-MM-DD[ HH:MM[:SS]]`; `sha` = `/^[0-9a-f]{7,40}$/i`; `slug`
   through `slugify`; `--project` through `normalizeProject`. Repeating a non-repeatable flag
   errors.
5. **Cross-flag rules** — `required`, `exclusive`, `requires`, `requiresValue`, `atLeastOne`.
   `requiresValue` is `requires` with a value predicate (`--confirm-cancel` is only legal
   alongside `--status cancelled`); it is the one rule that inspects another flag's *value*
   rather than its presence. Defaults applied last, and never used to satisfy `atLeastOne`.

**Strictness.** Every failure errors, with a nearest-match hint (Levenshtein, distance ≤ 2).
Candidates for an unknown flag: that command's options plus globals. For an unknown command:
all 29 names plus the matched group's sibling leaves.

```
$ task-db task add --projekt foo --title x
ERROR: unknown option '--projekt' for 'task add'.
       Did you mean '--project'?

$ task-db plan aply --project p --seq 1
ERROR: unknown command 'plan aply'.
       Did you mean 'plan apply'?

$ task-db insert --project p --type fix --title x
ERROR: 'insert' was renamed. Use 'task add'.
```

**Exit codes.** `CliError` carries an `exitCode` property, set to `1`, matching the current
`default` branch (`bin/task-db:351`). The parser stays pure — it throws and never calls
`process.exit` — but the code travels *with the error* rather than being decided by the
caller, so it is assertable in unit tests today and the wiring has nothing to invent later.
Tests assert `err.exitCode` on every throwing case, not just the message.

The parser reserves nothing else. `2` (`db init` first run) and `3`/`4` (`plan propose`) are
runtime outcomes owned by handlers; a test asserts no `CliError` ever carries them, so the
parser cannot start squatting on a handler's signal.

**Explicitly not parse-level.** Everything below parses cleanly and fails in the handler.
Tests assert each one *parses*, so the follow-up plan cannot mistake it for parser work:

- Source-type guards (`plan propose` on an inline plan; `--content-file` against a linked
  plan) — depend on stored `source`.
- FK violations (`--plan-id 999`) — depend on the DB.
- `plan attach` refusing while a different candidate is pending — depends on `pending_*`.
- `plan propose` rejecting a candidate whose heading slugs collide with an existing task
  anchor — requires reading the body *and* the task rows.
- `plan detach` requiring `--confirm-source-change` — requires hashing the live file and
  comparing against `content_hash`.
- `plan update --status cancelled` reporting children before `--confirm-cancel` cascades,
  and `--status completed` refusing non-terminal children without `--force-complete` —
  depend on child task rows.

The pattern is consistent and worth stating once: **the parser validates flag shape; the
handler validates against state.** A confirmation flag's *legality* (does it match the
status it modifies) is shape and belongs here; its *necessity* (is there anything to
confirm) is state and does not.

### Global options

| Flag | Applies to | Notes |
|---|---|---|
| `--project <str>` | all `task *` and `plan *` | required; normalized; rejected on `db *` |

On `plan *` commands `--project` scopes the `P###` sequence lookup — it identifies *whose
plan*, and never filters a plan's child tasks, which may span repositories. `plan tasks`
therefore takes no per-repo filter flag; the parser has nothing extra to enforce here, but
the rule is recorded because "add `--in-project`" is the obvious wrong fix later.
| `--output-file <path>` | every command | lands in `action.global`, not `opts` |
| `--help` / `-h` | every command | short-circuits to `{ kind:'help' }` at any depth |

A bare `task-db`, or a group with no leaf (`task`, `plan note`), returns `kind:'help'` for
that level rather than erroring.

## Command specification

29 commands. `!` = required, `*` = repeatable, `=x` = default.

| Command | Options |
|---|---|
| `db init` | — |
| `db migrate` | — |
| `task add` | `--type!`⟨type⟩ `--title!` `--priority`⟨priority⟩`=medium` `--tag*` `--req*` `--dep*`⟨int⟩ `--created`⟨ts⟩ `--plan-id`⟨int⟩ `--anchor`⟨slug⟩ `--commit-sha`⟨sha⟩ |
| `task update` | `--seq!`⟨int⟩ `--status`⟨status⟩ `--priority` `--type` `--title` `--created`⟨ts⟩ `--updated`⟨ts⟩ `--completed-at`⟨ts⟩ `--commit-sha`⟨sha⟩ `--feedback` `--plan-id`⟨int⟩ `--anchor`⟨slug⟩ `--tag*` `--req*` `--dep*` |
| `task get` | `--seq!`⟨int⟩ |
| `task list` | `--status`⟨status⟩ |
| `task recent` | `--limit`⟨int⟩`=20` |
| `task deps check` | `--seq!`⟨int⟩ |
| `task deps validate` | `--dep!*`⟨int⟩ |
| `task deps blocked` | — |
| `task deps unblocked` | `--seq!`⟨int⟩ |
| `task changelog list` | `--new-only`⟨bool⟩ |
| `task changelog mark` | `--all`⟨bool⟩ **xor** `--seq*`⟨int⟩ |
| `plan create` | `--title!` `--path`⟨abspath⟩ **xor** `--content-file`⟨path⟩ `--origin`⟨abspath⟩ `--tag*` |
| `plan list` | `--status`⟨status⟩ |
| `plan get` | `--seq!`⟨int⟩ `--with-content`⟨bool⟩ **xor** `--content-only`⟨bool⟩ |
| `plan tasks` | `--seq!`⟨int⟩ `--status`⟨status⟩ |
| `plan status` | `--seq!`⟨int⟩ `--limit`⟨int⟩`=10` |
| `plan progress` | `--seq!`⟨int⟩ `--counts`⟨bool⟩ |
| `plan propose` | `--seq!`⟨int⟩ `--content-file`⟨path⟩ |
| `plan attach` | `--seq!`⟨int⟩ `--path!`⟨abspath⟩ |
| `plan detach` | `--seq!`⟨int⟩ `--delete-file`⟨bool⟩ `--confirm-source-change`⟨bool⟩ |
| `plan apply` | `--seq!`⟨int⟩ |
| `plan discard` | `--seq!`⟨int⟩ |
| `plan update` | `--seq!`⟨int⟩ `--title` `--status`⟨status⟩ `--tag*` `--confirm-cancel`⟨bool⟩ `--force-complete`⟨bool⟩ |
| `plan note add` | `--seq!`⟨int⟩ `--note!` `--kind`⟨noteKindWritable⟩`=manual` `--task*`⟨taskref⟩ |
| `plan note list` | `--seq!`⟨int⟩ `--limit`⟨int⟩ |
| `plan note replace` | `--seq!`⟨int⟩ `--id!`⟨int⟩ `--note!` `--task*`⟨taskref⟩ `--force`⟨bool⟩ |
| `plan note delete` | `--seq!`⟨int⟩ `--id!`⟨int⟩ `--force`⟨bool⟩ |

**Cross-flag rules**

- `task update`, `plan update` — `atLeastOne` mutation flag; a bare `--seq` errors rather
  than writing a no-op timestamp. **The confirmation flags do not count as mutations**:
  `plan update --seq 1 --confirm-cancel` with no `--status` still fails `atLeastOne`. They
  are modifiers on a mutation, not one themselves, and treating them as satisfying the rule
  would let a bare confirmation through as a no-op write.
- `task add`, `task update` — `--anchor` `requires` `--plan-id`.
- `plan update` — `--confirm-cancel` `requiresValue` `--status=cancelled`;
  `--force-complete` `requiresValue` `--status=completed`. A confirmation attached to the
  wrong status is a caller bug worth catching at the boundary, not a no-op to ignore.
- `plan detach` — `--confirm-source-change` has no parse-level precondition. Whether it is
  *required* depends on comparing the live file against the applied hash, which is runtime.

**`--plan-id` is a global id, not a `P###` sequence.** The `int` type already rejects
`P001`, but the error message says so explicitly — "`--plan-id` takes the global numeric id
from `plan get`, not the `P###` display id" — because the two id spaces coexisting is the
single most likely caller mistake in the whole surface, and a bare "expected integer" would
send the reader looking in the wrong place.
- `task changelog mark` — `atLeastOne` of `--all` / `--seq`.
- `plan create` — `--path` xor `--content-file`, both optional (an empty inline plan is
  valid; its body arrives via a later `plan propose --content-file`).
- `plan create` — `--origin` `requires` `--content-file`. `origin_path` records where an
  *imported* plan came from, so it is meaningless alongside `--path` (the file is still
  there, in `path`). It stays an explicit flag rather than being inferred from
  `--content-file`, because inline plans also arrive via `--content-file` — through a temp
  file the skill just wrote — and auto-recording that would store `/tmp/xyz123` as
  provenance. `plan detach` sets `origin_path` itself from the outgoing `plans.path`; no
  flag needed there.

**Rename map** (all 13 error naming their replacement): `insert`→`task add`,
`update`→`task update`, `get`→`task get`, `list`→`task list`, `recent`→`task recent`,
`check-deps`→`task deps check`, `validate-deps`→`task deps validate`,
`blocked`→`task deps blocked`, `unblocked`→`task deps unblocked`,
`changelog`→`task changelog list`, `mark-changelog`→`task changelog mark`,
`init`→`db init`, `migrate`→`db migrate`.

## Tests

`plugins/project-tasks/task-db.test.mts`, `node:test` + `node:assert`, following
`packages/statusline/statusline-render.test.mts`. Imports `parseArgv` directly — no
subprocess, no sqlite3, no temp DB, since the parser is pure.

Cases stored as **pre-split arrays**, not shell strings. `process.argv` arrives already
tokenized; a quote-splitter in the test would be testing the shell, not the parser.

### What these tests must actually catch

A suite that only asserts "`parseArgv` returns what `registry.mjs` declares" is
self-referential: rename `--content-file` to `--contentfile` in the registry and every case
still passes while SKILL.md breaks at runtime. Three of the groups below are therefore
**external** — they check the registry against sources that live outside it — and they are
the ones that fail when the surface drifts. The per-flag unit cases are the cheap layer on
top; they catch coercion and cross-flag logic bugs, not naming drift.

| Group | Guards against | Self-referential? |
|---|---|---|
| A. Doc-derived fixtures | Registry drifting from the parent plan | **No** |
| B. Skill call-site lint | The 25 hard-cutover call sites landing wrong | **No** |
| C. Coverage assertions | A command or flag specified but never exercised | **No** |
| D. Coercion / cross-flag / error cases | Logic bugs in the parser itself | Yes |

### Group A — doc-derived fixtures

Every `$T …` line in the Verification section of `docs/plans/project-tasks-plan-type.md` is
**extracted by the test at run time**, not hand-transcribed: read the file, take fenced
`bash` blocks, keep lines starting with `$T `, drop trailing `#` comments, tokenize on
whitespace respecting quotes, substitute `$T` → `[]` and `--project testproj`. Each must
parse without throwing, except the lines the doc marks `must FAIL`, which must throw.

Hand-copying the table would let the doc and the test drift apart silently — which is the
same failure the whole layer exists to prevent, one level up. Deriving it means editing the
parent plan's verification block without updating the registry fails the suite.

**`# must FAIL` in the doc does not mean "fails to parse."** Of the marked lines, only the
legacy `insert …` one is a parse failure. The rest fail in a handler and must **parse
clean** — asserting that here is what stops the follow-up plan from mistaking them for
parser work. There are THREE such runtime carve-outs, not two:

1. `plan propose` source-type errors — depend on stored `source`.
2. `task add … --plan-id 999` — FK, depends on the DB.
3. `plan note delete … --id 1` without `--force` — the lifecycle-kind guard, which needs
   the stored note. The Group A spot-assert table below independently requires this same
   line to yield `force:false`, so treating it as a parse failure would contradict it.

Only genuine parse failures assert a throw *and* `exitCode === 1`. Carve-outs are listed
explicitly in the test, with an assertion that every carve-out still matches a line the doc
actually marks — otherwise the list silently rots as the doc changes.

Spot-assertions on the trickier extractions, beyond "does not throw":

| Verification line | Asserts |
|---|---|
| `db init` | `command:'db init'`, `opts:{}`, no `--project` required |
| `plan create … --title "Exit plan mode" --path /tmp/p.md` | `path` set, `contentFile` absent |
| `plan create … --content-file /tmp/q.md --origin /tmp/q.md` | both set, no xor violation |
| `plan get … --seq 2 --content-only --output-file /tmp/restored.md` | `seq === 2` (number), `contentOnly:true`, `global.outputFile` set and **absent from `opts`** |
| `plan propose … --seq 2` | parses clean — inline guard is runtime |
| `plan propose … --seq 1 --content-file /tmp/q.md` | parses clean — linked guard is runtime |
| `task add … --plan-id 999` | parses clean — FK is runtime |
| `task add … --anchor "Step 1: Do the thing"` | `anchor === 'step-1-do-the-thing'` |
| …and `--anchor "step-1-do-the-thing"` | `deepStrictEqual` against the previous parse — slugify idempotency proven at the parse boundary |
| `plan tasks` / `list` / `apply` / `discard` / `attach` / `detach` | route + opts |
| `task update … --status in_progress` | enum accepted |
| `plan propose … --output-file /tmp/d.patch` | `outputFile` does not disturb `opts` |
| `plan note add … --note "rescoped after review" --task github.com/acme/backend#001` | `tasks:[{project:'github.com/acme/backend',seq:1}]`, `kind:'manual'` default applied |
| `plan note list … --seq 1` | route |
| `plan note delete … --id 1` / `--force` | `force:false` / `true` |
| `plan status … --seq 1 --output-file /tmp/status.md` | `limit:10` default |
| `plan progress … --seq 1` / `--counts` | `counts:false` / `true` |
| `task update … --status completed --completed-at "2026-08-09 12:00" --commit-sha deadbeef` | timestamp with embedded space survives as one token; sha accepted |
| `plan update … --status cancelled` | passes `atLeastOne` |
| `insert --project testproj --type fix --title "x"` | **throws**, message contains `task add` |
| `task list --project testproj` | route |
| `task changelog list … --new-only` | `newOnly:true` |

### Group B — skill call-site lint

**The highest-value test in the suite, and the one currently missing.** The parent plan's
central risk is the `$TASK_DB` call sites in a `model: haiku` SKILL.md that must all land on
renamed commands with no aliases. That risk is presently handled only by a manual
haiku/Opus review loop. It can be an automated gate instead:

(Count: 24 invocations live inside fenced bash blocks, which is what the extractor sees;
the "25" quoted elsewhere in these plans includes a prose mention. The lint asserts it found
`> 0` call sites rather than a hardcoded number, so the exact figure is not load-bearing —
but a hardcoded count would have made this discrepancy a spurious failure.)

Read `skills/project-tasks/SKILL.md` and `skills/project-tasks/references/plans.md`, extract
every `$TASK_DB …` invocation from the fenced bash blocks, substitute placeholder values for
`"..."`/`$PROJECT`/`N`, and assert each one routes through `parseArgv` without throwing.

This catches, mechanically and at test time, exactly the failure the hard cutover invites: a
call site left on `check-deps` or typo'd to `plan aply`. Prefer it over discovering the same
thing through a subagent transcript.

Because those files are rewritten in the follow-up plan, the test **skips with an explicit
reason** while they still contain legacy names, and becomes enforcing the moment they do
not — so it lands here rather than being deferred and forgotten. A companion assertion
guards the transition itself: once zero legacy names remain, the skip must not re-engage.

### Group C — coverage assertions

Derived from `COMMANDS`, so they cannot go stale:

- Every key in `COMMANDS` appears in at least one passing fixture. A command specified but
  never exercised fails the suite.
- Every option key in every command appears in at least one fixture. Catches a flag that
  exists only in the registry — spec'd, never used, never validated.
- Every member of every enum **that a command actually references** is accepted somewhere,
  and one non-member is rejected per referenced enum. Scoped deliberately: `ENUMS.noteKind`
  is referenced by no command — `plan note add` uses `noteKindWritable`, and the three
  lifecycle kinds exist only as helper output — so an unscoped version of this rule is
  unsatisfiable. A companion test pins *why* `noteKind` is exempt, so the scoping cannot be
  quietly widened into a loophole later.
- Every entry in `RENAMES` throws, and its message contains its replacement string.
- Round-trip: for each command, a canonical argv built from its own spec parses back to the
  declared keys, types, and defaults. Weakly self-referential, but it catches a `type:`
  typo (`'int'` vs `'ini'`) that no hand-written case would reach.

  **The generated argv must NOT feed the coverage ledger.** Coverage is satisfied only by
  hand-written or doc-derived fixtures. If the round-trip counted, it would mark every
  command and every flag as exercised by construction, and the "spec'd but never used"
  signal — the entire reason the ledger exists — would always read green.

**Boundary decisions the spec left silent**, resolved here so the parser is deterministic:
`--flag=value` on a `bool` is rejected (booleans take no value); a `--project` that
normalizes to the empty string is rejected; and `--help` is scanned across the whole argv
*before* flag parsing, so `task add --title --help` returns help rather than "missing
value" — consistent with "short-circuits at any depth".

### Group D — parser logic cases

- All 13 legacy names throw, each naming its own replacement (table-driven).
- `plan aply` → hint contains `plan apply`. `--projekt` → hint contains `--project`.
  `task deps chek` → hint lists the group's leaves.
- Group with no leaf (`task deps`) and bare `task-db` → `kind:'help'`, no throw.
- Missing required (`task get --project p`) → throws naming `--seq`.
- Missing value (`task get --project p --seq`, `task add --title --status x`) → throw.
- Non-numeric `--seq abc`, bad enum `--status done`, relative `--path ./x.md`, malformed
  `--completed-at 2026/08/09`, bad `--commit-sha zzz` → throw.
- Repeated non-repeatable (`task get --seq 1 --seq 2`) throws; the same shape on
  `task changelog mark --seq 1 --seq 2` yields `seqs:[1,2]`. **The contrasting pair is the
  point.**
- Mutual exclusion: `plan create --path /a --content-file /b`,
  `plan get --with-content --content-only` → throw.
- `atLeastOne`: `task update --project p --seq 1` with no mutation → throws.
- `requires`: `task add … --anchor x` without `--plan-id` → throws.
- `--project` on `db init` → throws; missing `--project` on any `task`/`plan` → throws.
- `--flag=value` form, including a value starting with `-`.
- Missing value at **end of argv** (`task get --project p --seq`) → throw, distinct from the
  next-token-is-a-flag case.
- Stray positional after flags (`task get --project p --seq 1 extra`) → `unexpected argument`.
- `plan note add --kind applied` → throws (lifecycle kind not writable); `--kind manual`,
  `--kind tasks-created`, `--kind reconciled` all accepted. **The contrasting set is the
  point** — it pins the write-side half of the audit-trail invariant.
- `plan create --content-file /tmp/x --origin /tmp/x` accepted; `--path /a --origin /b`
  → throws on `requires`.
- `--plan-id`: `task add … --plan-id 7 --anchor x` accepted; `--anchor x` without
  `--plan-id` throws; `--plan-id P001` throws with a message naming the `P###` confusion,
  not a bare "expected integer". **The last one is the point** — it is the most likely
  caller mistake on the whole surface.
- `requiresValue`: `plan update --seq 1 --status cancelled --confirm-cancel` and
  `--status completed --force-complete` both accepted; each confirmation against the *other*
  status throws; either confirmation with no `--status` throws.
- `atLeastOne` vs. modifiers: `plan update --seq 1 --confirm-cancel` throws, proving the
  confirmation flags do not satisfy the mutation requirement.
- `plan detach --seq 1 --delete-file --confirm-source-change` parses clean — whether the
  confirmation is *needed* is a runtime hash comparison.
- `--help` at every depth → `kind:'help'`.
- `--project` normalization: `git@github.com:o/r.git` and `https://github.com/o/r/` both land
  on `github.com/o/r` (guards the `lib/normalize.mjs` move).
- `slugify` idempotency as a property: for a table of raw headings, `slugify(slugify(x))
  === slugify(x)`. Anchors are the join key between plan steps and tasks, so a
  non-idempotent slug silently duplicates tasks on a second `create-tasks`.
- **Exit codes**: every throwing case asserts `err.exitCode === 1`, and no `CliError`
  anywhere in the suite carries `2`, `3`, or `4` — those belong to handlers.
- `parseArgv` purity: never mutates the input array; called twice on the same argv it
  returns `deepStrictEqual` results.

Update `tests/packages/task-db/index.md` (currently "no automated tests exist") and the
task-db row in `tests/README.md`.

## Verification

```bash
# Unit tests — the primary gate
node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts

# No behavioral regression in the untouched dispatch
export PROJECT_TASKS_HOME=$(mktemp -d)
T="node plugins/project-tasks/bin/task-db"
$T init; echo "exit=$? (expect 2, first run)"
$T insert --project testproj --type task --title "smoke"   # → #001
$T list --project testproj
$T badcmd; echo "exit=$? (expect 1)"

# The normalizeProject move did not break the legacy caller
$T insert --project "git@github.com:o/r.git" --type fix --title "n"
$T list --project "https://github.com/o/r/"   # must show the same row
```

## Out of scope (follow-up plan)

Schema and `PRAGMA foreign_keys=ON`; the `plans` table; handler implementations; wiring
`parseArgv` into `bin/task-db` and deleting the old `switch`/`get`/`all`/`has`; SKILL.md's
25 call sites; `references/plans.md`; version bumps; the haiku/Opus skill verification loop.

Also out of scope, added to the parent plan after this one was drafted: the concurrency
infrastructure — `PRAGMA busy_timeout=5000`, `BEGIN IMMEDIATE`/`COMMIT` batching for
multi-row operations and state-change-plus-auto-note pairs, and the rollback behavior on
lock timeout. None of it is reachable from a pure parser, and the parallel-writer tests in
the parent plan's §5 exercise it through real `sqlite3` processes rather than `parseArgv`.
