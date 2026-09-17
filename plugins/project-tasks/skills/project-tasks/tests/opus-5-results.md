# Opus 5 Verification Results — project-tasks Validation Decision Flow

**Model:** Claude Opus 5 (`claude-opus-5`)
**Date:** 2026-09-16
**Mode:** Read-only verification pass. No skill, reference, command, test, or
existing result file was modified. No staging or commit was performed.

---

## 1. Checkout and Git state

| Item | Value |
|---|---|
| Worktree root | `/Users/chris/dev/personal/claude-code-config/.worktrees/project-tasks-validation-flow` |
| Branch | `feat/project-tasks-validation-flow` |
| `git rev-parse HEAD` | `7d6369bdb6d38b88c67b1eefee47e00f3ef90392` |
| HEAD subject | `feat(project-tasks): add validation decision flow` |

`git status` at start of verification:

```text
 M plugins/project-tasks/commands/init.md
 M plugins/project-tasks/skills/project-tasks/SKILL.md
 M plugins/project-tasks/skills/project-tasks/references/plans.md
 M plugins/project-tasks/skills/project-tasks/tests/baseline-results.md
 M plugins/project-tasks/skills/project-tasks/tests/green-results.md
 M plugins/project-tasks/skills/project-tasks/tests/test-2stage-pipeline.md
 M plugins/project-tasks/skills/project-tasks/tests/test-project-discovery.md
 M plugins/project-tasks/skills/project-tasks/tests/test-validation-and-cancellation.md
?? plugins/project-tasks/skills/project-tasks/references/task-commands.md
?? plugins/project-tasks/skills/project-tasks/references/task-execution.md
?? plugins/project-tasks/skills/project-tasks/references/validation-flow.md
```

---

## 2. Files read (complete contents)

Paths relative to the worktree root:

1. `plugins/project-tasks/skills/project-tasks/SKILL.md` (189 lines)
2. `plugins/project-tasks/commands/init.md` (134 lines)
3. `plugins/project-tasks/skills/project-tasks/references/task-commands.md` (204 lines)
4. `plugins/project-tasks/skills/project-tasks/references/task-execution.md` (194 lines)
5. `plugins/project-tasks/skills/project-tasks/references/validation-flow.md` (269 lines)
6. `plugins/project-tasks/skills/project-tasks/references/plans.md` (388 lines)
7. `plugins/project-tasks/skills/project-tasks/tests/test-validation-and-cancellation.md` (178 lines)
8. `plugins/project-tasks/skills/project-tasks/tests/test-2stage-pipeline.md` (142 lines)
9. `plugins/project-tasks/skills/project-tasks/tests/test-run-task.md` (77 lines)
10. `plugins/project-tasks/skills/project-tasks/tests/test-project-discovery.md` (127 lines)
11. `plugins/project-tasks/skills/project-tasks/tests/test-log-task.md` (105 lines)
12. `plugins/project-tasks/skills/project-tasks/tests/test-changelog.md` (128 lines)
13. `plugins/project-tasks/skills/project-tasks/tests/baseline-results.md` (143 lines, context only)
14. `plugins/project-tasks/skills/project-tasks/tests/green-results.md` (172 lines, context only)
15. `AGENTS.md` (repo root, read first per dispatch instruction)

Supporting read for cross-reference checks: all 12 files under
`plugins/project-tasks/commands/`.

---

## 3. Automated checks

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `git diff --check` | `0` | No whitespace/conflict errors. No output. |
| 2 | `node --test tests/plugins/project-tasks/structure.test.mjs` | `0` | tests 1, **pass 1, fail 0**, skipped 0, todo 0 |
| 3 | `node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts plugins/project-tasks/task-db.integration.test.mts plugins/project-tasks/task-db.plan-read.test.mts plugins/project-tasks/task-db.plan-sync.test.mts` | `0` | tests 502, suites 58, **pass 502, fail 0**, cancelled 0, skipped 0, todo 0, duration 13643ms |

**Automated total: 503 tests, 503 pass, 0 fail, across 3 checks, all exit 0.**

Supplementary read-only searches performed (`rg`):

- `rg -i 'retry'` over SKILL.md + references + commands → only two hits, both
  negative assertions, neither a menu option (see Requirement 1).
- `rg -i 'byte offset|preimage|base64|hunk|sha-256|sha256'` → no repair-path
  hits (see Requirement 8).
- `rg -i 'haiku|sonnet|opus|gpt-|claude-[0-9]'` → only the frontmatter
  `model: haiku`, which is explicitly scoped as non-dispatch metadata.

---

## 4. Behavioral requirement verdicts

### Requirement 1 — Completion menu uses Validate with Strong/Top, no Retry — **PASS**

- `SKILL.md:163-168` presents exactly four options: `a) Accept`,
  `b) Validate with Strong tier`, `c) Validate with Top tier`,
  `d) Reject / Cancel`.
- `SKILL.md:170` — "There is no Retry choice."
- `SKILL.md:183` quick reference — "runner completion | Accept, Validate
  Strong/Top, or Reject / Cancel".
- Menu reproduced identically in `test-2stage-pipeline.md:40-45`,
  `test-validation-and-cancellation.md:33-38`, `test-run-task.md:38-43`.
- Exhaustive search confirms the only `retry` occurrences are `SKILL.md:170`
  (the prohibition) and `validation-flow.md:149` ("distinguish Repair from an
  uncontrolled retry"). Neither is a selectable option.

### Requirement 2 — Validation is read-only — **PASS**

- `SKILL.md:46-47` invariant 4 — "Validation and checking are read-only. They
  do not change files, the index, task status, requirements, or completion
  metadata."
- `validation-flow.md:17-18` — "Validation itself is read-only and keeps the
  database task `in_progress`."
- `validation-flow.md:34-35` Verifier prompt — "Do not modify files, the Git
  index, task requirements, task status, or completion metadata."
- Verifier is dispatched from the read-only capability profile
  (`SKILL.md:64`, `SKILL.md:72-73`).
- `task-commands.md:139` — "Checking is informational and never changes task
  status."

### Requirement 3 — Repair preserves the current implementation as its starting point — **PASS**

- `validation-flow.md:93-96` — "It keeps the current implementation as the
  starting point".
- `validation-flow.md:107-108` step 3 — "preserve the current worktree, and
  record a pre-repair Git status/diff snapshot".
- `validation-flow.md:133-134` — "It works from the current implementation,
  must not reset the worktree, and must not commit."
- `SKILL.md:48-50` invariant 5 — "Repair keeps the current implementation …
  Neither action uses broad `git checkout .`, `git reset --hard`, `git clean`,
  or `git add -A`."
- Repair menu option (a) at `validation-flow.md:101` is explicitly
  "Repair in place — keep current changes and address these findings".

### Requirement 4 — Repair Scout receives all seven inputs — **PASS**

`validation-flow.md:111-118` enumerates exactly the required set:

| Required input | Evidence |
|---|---|
| Original task requirements | `validation-flow.md:112` |
| Original Implementation Map | `validation-flow.md:113` (`originalImplementationMap`) |
| Latest Revised Implementation Map when present | `validation-flow.md:114-115` (`currentImplementationMap`, "the latest revised plan, or the original plan on Repair Pass 1") |
| Complete validator report and findings | `validation-flow.md:116` |
| Previous Executor report | `validation-flow.md:117` (`lastExecutorReport`) |
| Pre-repair snapshot | `validation-flow.md:118` |
| Current repository state | `validation-flow.md:118` |

State fields backing these are declared at `SKILL.md:100-103`.

### Requirement 5 — Repair Scout returns one complete authoritative Revised Implementation Map — **PASS**

- `validation-flow.md:119-123` — "returns one authoritative Revised
  Implementation Map containing what remains valid, what must change, the
  complete file/code operations, and tests/verification commands."
- `validation-flow.md:122-123` — "It does not return loose suggestions for the
  Executor to reconcile."
- Escape hatch is bounded: `validation-flow.md:123-125` — if the architecture
  is fundamentally unsound it returns `restart required` rather than planning a
  rewrite, and `validation-flow.md:127-128` routes that to a confirmed Top-tier
  Restart without dispatching a Repair Executor.
- Mirrored in `test-2stage-pipeline.md:62-63` and
  `test-validation-and-cancellation.md:71-74`.

### Requirement 6 — Repair Executor has the same repository-wide write freedom — **PASS**

- `validation-flow.md:130-133` — "Give it the same repository-wide write
  freedom as the original Executor. It may add, delete, move, refactor, or
  update code as the revised map requires."
- `validation-flow.md:94-96` — "the revised plan and Executor may add, delete,
  move, refactor, or update any repository code needed to correct the
  implementation."
- `SKILL.md:125-126` — "Executors may make any repository changes required by
  their Implementation Map."
- No conflict with `task-execution.md:123` ("Do not add unrelated refactors or
  features"), which constrains *unrelated* work only, not mapped work.

### Requirement 7 — `ownedPaths` is recomputed evidence, not an authorization whitelist — **PASS**

- `SKILL.md:121-126` — "The parent recomputes it from the recorded baseline
  after every Executor and revalidates it before staging, selective restore, or
  removal. It is evidence for acceptance and cleanup, not a write-authorization
  list … Workers report changes but never decide ownership."
- `validation-flow.md:136-138` — "recompute `ownedPaths` from the original
  execution baseline. New or newly modified paths are part of the task's
  evolving implementation; they are not automatically scope failures."
- `validation-flow.md:146-147` — "The Repair Executor is guided by the complete
  revised plan and validator evidence rather than a file whitelist."
- `test-validation-and-cancellation.md:57-58` — "A referenced path is
  diagnostic context, not a write-authorization boundary."

### Requirement 8 — No byte offsets, base64 preimages, SHA-256 authorization, hunk hashes, or region permissions — **PASS**

- `validation-flow.md:145-147` — "The parent and workers do not calculate byte
  offsets, encoded preimages, hunk hashes, or region-level authorization."
- Repository-wide search for `byte offset|preimage|base64|hunk|sha-256|sha256`
  across SKILL.md, all references, and all commands returns no repair-path
  hits. The only matches are unrelated:
  - `plans.md:86` — sha256 comparison for verifying a **plan file import**
    before unlinking the source file (content-integrity check, not repair
    authorization).
  - `plans.md:180`, `plans.md:194` — "diff hunk" used in the sense of
    classifying plan-document headings, not a hunk hash.
- Confirms the regression recorded at `baseline-results.md:91-97` is resolved.

### Requirement 9 — Every Scout/Executor/Verifier callback validates and clears `activeDispatch` — **PASS**

General rule plus per-stage restatement at every one of the nine dispatch
points:

| Stage | Evidence |
|---|---|
| Global contract | `validation-flow.md:19-23` — match generation, stage, and host dispatch ID; "clear `activeDispatch` before snapshot checks or dispatching the next stage" |
| Global invariant | `SKILL.md:51-53` invariant 6; `SKILL.md:116-119` |
| Initial Scout | `task-execution.md:98-100` — "clear it before starting the Executor" |
| Initial Executor | `task-execution.md:126-127` |
| Verifier | `validation-flow.md:71` — "Clear only the matching dispatch" |
| Repair Scout | `validation-flow.md:125-126` |
| Repair Executor | `validation-flow.md:135-136` |
| Post-repair Verifier | `validation-flow.md:140-142` |
| Restart Scout | `validation-flow.md:201-202` |
| Restart Executor | `validation-flow.md:204-205` |
| Restart Verifier | `validation-flow.md:206-209` |

Cancellation-path handling is also covered: `validation-flow.md:22-23` and
`task-execution.md:184-186`.

### Requirement 10 — Every repair creates a fresh execution generation — **PASS**

- `validation-flow.md:107` step 3 — "Increment `repairPassCount`, generate a
  fresh `executionGeneration`".
- `SKILL.md:116-118` — "Generate a fresh opaque `executionGeneration` before
  the initial Scout and before every confirmed repair or restart pipeline."
- Restart parallel at `validation-flow.md:194-195`.
- This closes the lifecycle ambiguity recorded at `baseline-results.md:98-100`.

### Requirement 11 — Fresh read-only validation mandatory after every repair, before Accept — **PASS**

- `validation-flow.md:139-143` step 7 — "Capture a new validation snapshot and
  automatically re-run the read-only Verifier at `validationTier` … **Accept is
  available only if that fresh validation recommends it.**"
- Accept itself re-gates on snapshot equality: `validation-flow.md:87-89` and
  `task-execution.md:136-138`.
- `test-2stage-pipeline.md:68-69`, `test-validation-and-cancellation.md:80-81`.

### Requirement 12 — Repair-loop escape after Pass 2 with exact four choices — **PASS**

Gate: `validation-flow.md:78-80` — "If the recommendation is `repair` and
`repairPassCount` is already `2`, use the repair-loop escape below instead of
offering Repair Pass 3." Type is bounded to `0 | 1 | 2` at `SKILL.md:99`.

Prohibition: `validation-flow.md:153-154` — "do not start a third repair pass."

Menu at `validation-flow.md:157-162` matches the required set exactly:

| Required choice | Line | Required semantics | Evidence |
|---|---|---|---|
| Accept (normal acceptance flow despite remaining findings) | `:158` | yes | `:164-165` — "Accept follows the normal Accept flow in `task-execution.md`, including its fresh snapshot check, scoped staging, commit, and task completion." |
| Restart with Top tier (requires confirmation) | `:159` | yes | `:168-170` — "requires the same explicit confirmation and selective cleanup as any Restart, then runs the Restart Scout, Executor, and validation at Top tier." |
| Leave work as-is (task stays in progress, not accepted) | `:160` | yes | `:165-166` — "Leave work as-is performs none of those actions and keeps the task `in_progress`." |
| Reject / Cancel | `:161` | yes | routes to `validation-flow.md:220` |

`repairPassCount` reset is correctly deferred: `validation-flow.md:170-171` —
"Reset `repairPassCount` to `0` only after the confirmed restart establishes its
clean execution baseline."

### Requirement 13 — Strong restarts at Top; Top restarts at Top — **PASS**

- `validation-flow.md:178-181`:
  - "Strong validation restarts at Top."
  - "Top validation restarts at Top; Top is already the highest tier, so
    validation must not dead-end merely because no stronger tier exists."
- `test-2stage-pipeline.md:83-84`, `test-validation-and-cancellation.md:103-105`.
- Directly resolves the dead-end recorded at `baseline-results.md:105-111`.

### Requirement 14 — Restart selectively discards implementation only after confirmation — **PASS**

- `validation-flow.md:175-176` — "Restart discards only the current task-owned
  implementation and requires an explicit confirmation."
- Confirmation menu `validation-flow.md:185-189`.
- `validation-flow.md:190-193` step 2 — restore tracked owned paths to the
  recorded baseline, "remove only task-created untracked owned paths. Keep the
  branch and worktree."
- `validation-flow.md:193-194` step 3 — verify against baseline; "If not, stop
  and preserve what remains."
- `validation-flow.md:211` — "If baseline or ownership cannot be proven, do not
  restore or delete anything."
- `SKILL.md:48-50` invariant 5 and `SKILL.md:54-55` invariant 7 reinforce.

### Requirement 15 — `commands/init.md` is canonical and creates no skill-loading loop — **PASS** (with a cross-reference defect noted in §5.2)

- Canonical status declared: `init.md:7-10` — "This is the canonical
  initialization procedure for the project-tasks commands and skill."
- Routed on every invocation: `SKILL.md:26` — "| Every invocation |
  [commands/init.md](../../commands/init.md) |".
- Referenced as the `$TASK_DB` source by `plans.md:6`.
- Loop guard is explicit: `init.md:128-134` — "When invoked as
  `/project-tasks:init`, load the `project-tasks` skill after successful
  database initialization … **When the skill routed here during another
  request, return to that request instead of loading the skill again.**"
- Depth guard: `SKILL.md:35-36` — "References are one level deep; do not look
  for another workflow file through a reference."

Both stated properties hold. See §5.2 for two sibling commands that still point
at a non-existent SKILL.md section instead of `commands/init.md`; this does not
break canonicality or create a loop, but it leaves the wiring non-uniform.

### Requirement 16 — Workflow works on both Claude and Codex — **PASS**

- Host detection: `init.md:56-59` — `IS_CODEX_HOST` from `CODEX_HOME`,
  `CODEX_SANDBOX`, `CODEX_THREAD_ID`, or `CODEX_CI`.
- Storage root branches per host: `init.md:61-68` —
  `${CODEX_HOME:-$HOME/.codex}/project-tasks` vs `$HOME/.claude`.
- Config dir branches per host: `init.md:70-77` — `.codex` vs `.claude`.
- Helper discovery searches both roots: `init.md:40-45`.
- Project-identifier lookup checks `$PROJECT_TASKS_CONFIG_DIR/project-tasks.json`,
  `.codex/project-tasks.json`, and `.claude/project-tasks.json`:
  `init.md:100-103`.
- Project instruction file is host-neutral: `task-execution.md:83` —
  "{AGENTS.md or CLAUDE.md}". A root `AGENTS.md` exists in this repo.
- Capability degradation rather than hard failure: `init.md:81-84`,
  `SKILL.md:147-149` (missing task-list UI is not an execution blocker),
  `SKILL.md:76-86` (no structurally read-only profile).
- No provider model names: `SKILL.md:56` invariant 8, `SKILL.md:66-69`. Search
  confirms `model: haiku` is the only model literal and is explicitly scoped to
  skill exercise/verification, not nested dispatch.
- `green-results.md:120-122` records the Codex fallback exercise.

### Requirement 17 — Fully qualified `lean-agents` profiles when available; capability-equivalent otherwise, no dependency — **PASS**

- `SKILL.md:71-74` — "When the host's agent roster includes the optional
  `lean-agents` plugin, use the fully qualified `lean-agents:read-only` profile
  for Planning Scouts and Verifiers, and `lean-agents:lean-executor` for
  Execution Agents. **Never try those names on a host where they are absent.**"
- Both names are fully qualified with the `lean-agents:` prefix; neither appears
  bare anywhere in SKILL.md or the references.
- The word "optional" at `SKILL.md:71` plus the absence branch at
  `SKILL.md:76-77` ("Otherwise, use a capability-equivalent host profile")
  establish non-dependency.
- Prompt-level enforcement fallback with verbatim reinforcement text:
  `SKILL.md:77-82`.
- Required user disclosure when enforcement is only prompt-level:
  `SKILL.md:83-86`.
- Capability requirements are stated independently of profile names at
  `SKILL.md:60-64`.

### Requirement 18 — `run all tasks` and `run plan` route directly into shared task-execution — **PASS**

- Routing table `SKILL.md:28` — "Run all tasks | `task-commands.md` **and**
  `task-execution.md`".
- Routing table `SKILL.md:31` — "Run a plan | `plans.md` **and**
  `task-execution.md`".
- `task-commands.md:141-147` — "Each task follows `task-execution.md` and gets
  its own completion decision."
- `plans.md:296-302` — "dispatch each through the normal **Running a Task**
  pipeline in `task-execution.md`."
- `SKILL.md:186` quick reference — "`run all tasks` | Run all unblocked pending
  tasks".
- `commands/plan-run.md:7-9` — "the same way 'run all tasks' does but scoped to
  this plan", confirming a single shared path.
- `green-results.md:123-124` records both routes exercised.

Both routes converge on one pipeline; no parallel/forked execution logic exists.
See §5.4 for a cosmetic heading-name drift in the `plans.md:300` pointer.

### Requirement 19 — Existing CRUD, plan, cancellation, changelog, acceptance behavior remains coherent — **PASS** (skill behavior), with a material test-corpus contradiction documented in §5.1

Skill-side behavior is internally coherent and helper-only throughout:

- CRUD — `task-commands.md:29-63` (add), `:65-76` (list), `:84-93` (complete),
  `:110-113` (priority), `:115-125` (clear plan). All routed through
  `$TASK_DB`, consistent with `SKILL.md:40-41` invariant 1.
- Cancellation split is unambiguous — `task-commands.md:96-108` sends any task
  with an active/recovered execution context or task-owned work to
  `validation-flow.md:220`, and permits the one-line helper form only for a
  task with neither.
- Cancellation side effects suppressed consistently — `validation-flow.md:249-251`
  ("never commits, changes the changelog, reports dependencies as unblocked, or
  offers plan completion") matches `test-2stage-pipeline.md:113-115` and
  `test-validation-and-cancellation.md:116-118`.
- Acceptance — `task-execution.md:132-177`: empty `activeDispatch`, explicit
  confirmation, snapshot equality, scoped `git add --` of owned paths only,
  commit, real completion time + SHA, then deps/plan/changelog post-processing.
  Honors `SKILL.md:44-45` invariant 3 and the `git add -A` prohibition at
  `SKILL.md:49-50`.
- Plan/acceptance interface is consistent — `task-execution.md:172-174` calls
  `plan progress --counts`, and `plans.md:285-287` documents `--counts` as
  "the form the accept flow in `task-execution.md` uses".
- `--clear-plan` completion-count side effect is cross-referenced in both
  directions: `task-commands.md:122-125` and `plans.md:289-292`.
- Changelog — `task-commands.md:149-193`: helper-driven list, exact output
  format, ordering rules, then `task changelog mark`.

The contradiction in §5.1 lies between the skill and two **unmodified** test
fixtures, not within the skill's own behavior; the requirement as stated
("behavior remains coherent") is therefore met, but the acceptance corpus that
is supposed to certify it is not self-consistent.

**Tally: 19 PASS / 0 FAIL.**

---

## 5. Ambiguities, contradictions, regressions, and comprehension risks

### 5.1 — HIGH: two scenario files mandate a mechanism a core invariant forbids

`SKILL.md:40-41` invariant 1 is absolute: "Use `$TASK_DB <command>` for every
database operation. **Never invoke `sqlite3`, construct SQL, delete `tasks.db`,
or read the database file.**"

Two scenario files still specify — and grade on — exactly that forbidden
mechanism:

`tests/test-log-task.md`
- `:35` — "checks `sqlite3` availability, runs `CREATE TABLE IF NOT EXISTS`"
- `:47` — "The INSERT and SELECT are combined in a single `sqlite3` invocation
  to retrieve the assigned ID via `last_insert_rowid()`"
- `:62` — "**FAIL** if `sqlite3` prerequisite check is skipped."
- `:63` — "**FAIL** if `CREATE TABLE IF NOT EXISTS` is not run."
- `:65` — "**FAIL** if single quotes in user input are not escaped (doubled) in
  the SQL."
- `:66` — "**FAIL** if the INSERT and ID retrieval use separate `sqlite3`
  invocations"

`tests/test-changelog.md`
- `:46` — "queries all completed tasks (`status='completed'`) from the database"
- `:73`, `:88` — "updates `in_changelog=1`" / "**FAIL** if `in_changelog` is not
  set to `1` after writing."
- `:118`, `:125` — "queries only `WHERE in_changelog=0 AND status='completed'`"
- `:127` — "**FAIL** if `in_changelog` is not updated for the newly written
  tasks."

**Impact:** an agent that correctly obeys `SKILL.md:40-41` is scored FAIL by at
least six failure criteria in `test-log-task.md` and four in
`test-changelog.md`. These criteria are unsatisfiable by any compliant
implementation. `test-run-task.md:25` already states the correct expectation
("It does not call `sqlite3` directly"), so the corpus contradicts itself.

**Provenance:** `git log -1` shows both files were last modified in `a669d31`
("feat: add Claude Code plugin marketplace and restructure skills") and were
**not** touched by this branch. This is pre-existing drift surfaced by the
review, not a regression introduced by `7d6369b`. It nonetheless leaves the
acceptance suite unable to certify Requirement 19's subject matter.

Secondary instance of the same drift: `test-log-task.md:25` and
`test-changelog.md:25` both hardcode `~/.claude/tasks.db`, which contradicts the
Codex storage root at `init.md:61-67`
(`${CODEX_HOME:-$HOME/.codex}/project-tasks`) and so under-covers
Requirement 16.

### 5.2 — MEDIUM: two commands point at a section that does not exist

`commands/task-read.md:7` and `commands/plan-read.md:7` both instruct:

> "Run the project-tasks skill's host-compatibility setup block to resolve
> `$TASK_DB`"

No section named "host-compatibility setup block" exists in `SKILL.md`. The
canonical block is `commands/init.md:12` ("## Resolve the helper and storage
directory"). A search for that phrase across the plugin returns only these two
command files.

**Impact:** this partially undercuts Requirement 15. `SKILL.md:26` correctly
routes every invocation to `commands/init.md`, but these two sibling commands
route to a dangling anchor in the wrong file. A lower-capability model following
`task-read.md` literally has no resolvable target and must improvise `$TASK_DB`
resolution — precisely the failure mode `commands/init.md` was made canonical to
prevent.

### 5.3 — LOW: `test-project-discovery.md` is stale against `commands/init.md`

This file **was** modified on this branch, yet still describes the pre-refactor
layout:

- `:3` — "The discovery algorithm in the **Prerequisites section (step 3)** has
  three tiers". `SKILL.md` no longer contains a "Prerequisites" section; the
  algorithm now lives at `init.md:96-113`.
- `:5-8` — lists three tiers; `init.md:100-109` defines **four** ordered steps
  and checks **three** config paths
  (`$PROJECT_TASKS_CONFIG_DIR/project-tasks.json`, `.codex/project-tasks.json`,
  `.claude/project-tasks.json`), not just `.claude/`.
- `:7` — "use `basename` of the git toplevel" omits the "**only inside a Git
  repository**" guard at `init.md:108`. (Variant 4 at `:118`/`:122` does capture
  the no-silent-basename rule, so the file is self-inconsistent rather than
  wrong throughout.)
- `:46` and `:126` — grade on `node -e` invocation and stderr redirection
  mechanics that `init.md` no longer specifies.
- The file does not exercise the boundary-stop rule at `init.md:111-113` ("must
  stop after checking the boundary itself so it cannot adopt an unrelated parent
  repository's config") — an untested safety property.

### 5.4 — LOW: soft heading drift in cross-references

Three pointers name headings that do not exist under those names. All are
resolvable by a capable reader but cost a lower-capability model a failed lookup:

- `plans.md:300` — "the normal **Running a Task** pipeline in
  `task-execution.md`". `task-execution.md` has no such heading; its sections
  are Preconditions (`:16`), Isolation (`:32`), Execution context (`:44`), Start
  the task (`:62`).
- `commands/task-run.md:9` — "Follow the project-tasks skill's **Running a
  Task** pipeline (Check Dependencies → dispatch subagent)". Same missing
  heading, and it points at the skill rather than `task-execution.md`.
- `plans.md:289-290` — references "**Removing a Task's Plan Link**" in
  `task-commands.md`; the actual heading at `task-commands.md:115` is
  "Remove a task's plan link".

### 5.5 — LOW: result files assert a format the skill no longer uses

`baseline-results.md` and `green-results.md` were both modified on this branch,
but their Test 1/Test 2 sections still describe a Markdown `TASKS.md` file
format that the DB-backed skill replaced:

- `baseline-results.md:51` — "**Exact TASKS.md format** — heading, metadata
  line, status line, requirements section"
- `green-results.md:5-12` — grades heading format, pipe-separated metadata line,
  `---` separator
- `green-results.md:159` — "Exact TASKS.md format (vs baseline which invented
  its own format)"
- `green-results.md:158` — "All 6 tests PASS" asserts current-state passing for
  scenarios (§5.1, §5.3) that cannot currently pass as written.

These are historical records, so severity is low, but `green-results.md:158`
overstates the corpus's actual health.

### 5.6 — Lower-model comprehension risk: net assessment

The refactor materially **reduces** lower-model risk versus the baseline. Both
regressions recorded in `baseline-results.md` are closed with explicit prose:

- The byte-offset/preimage/SHA-256 protocol (`baseline-results.md:91-97`) is
  removed and explicitly disclaimed at `validation-flow.md:145-147`.
- The Top-tier restart dead-end (`baseline-results.md:105-111`) is closed at
  `validation-flow.md:179-181` with a stated rationale.
- The execution-generation ambiguity (`baseline-results.md:98-100`) is closed at
  `validation-flow.md:107` and `SKILL.md:116-118`.

Remaining structural strengths for a small model: menus are given as literal
fenced blocks rather than described; the `activeDispatch` rule is stated once
globally (`validation-flow.md:19-23`) **and** restated at all nine dispatch
sites; `repairPassCount` is type-bounded to `0 | 1 | 2` at `SKILL.md:99`, making
the Pass-3 prohibition mechanically checkable rather than a prose-only rule.

The residual risks are the dangling pointers in §5.2 and §5.4, both of which
land on a small model as an unresolvable instruction.

---

## 6. Verdict

**NEEDS REVISION**

All **19 of 19** behavioral requirements PASS with direct file:line evidence,
and all three automated checks pass clean (503/503 tests, exit 0 each). The
validation/repair/restart decision flow that this branch introduces is correct,
internally consistent, and demonstrably free of the two regressions it set out
to fix.

The verdict is NEEDS REVISION solely on **completeness of the surrounding
corpus and cross-references**, not on the validation-flow logic:

1. §5.1 — the acceptance suite contains scenario files whose failure criteria a
   compliant agent **cannot** satisfy, because they mandate the raw `sqlite3`
   access that `SKILL.md:40-41` forbids. The suite cannot currently certify
   Requirement 19.
2. §5.2 — two commands dereference a SKILL.md section that does not exist,
   leaving Requirement 15's canonical-init wiring non-uniform.
3. §5.3 — `test-project-discovery.md` was modified on this branch yet still
   points at a removed "Prerequisites section" and documents three tiers where
   `init.md` now defines four steps.

### Recommendations (not implemented — this pass is read-only)

1. **Rewrite `tests/test-log-task.md`** against the helper: replace the
   `sqlite3`/`CREATE TABLE`/`last_insert_rowid()` expectations (`:35`, `:47`)
   and failure criteria (`:62`, `:63`, `:65`, `:66`) with `$TASK_DB task add
   --project … --type … --title … --priority … --req …` per
   `task-commands.md:31-35`, and with "reports the assigned `#NNN` returned by
   the helper" per `task-commands.md:37-38`. Add an inverse criterion:
   "**FAIL** if the skill invokes `sqlite3` or constructs SQL."
2. **Rewrite `tests/test-changelog.md`** the same way: replace
   `status='completed'` / `in_changelog` SQL (`:46`, `:73`, `:88`, `:118`,
   `:125`, `:127`) with `$TASK_DB task changelog list --new-only`,
   `task changelog list`, and `task changelog mark --seq N` /
   `--all` per `task-commands.md:151-193`. Keep the expected `CHANGELOG.md`
   output block at `:51-69` — the format assertions are still correct.
3. **Replace the hardcoded `~/.claude/tasks.db`** at `test-log-task.md:25` and
   `test-changelog.md:25` with a host-neutral reference to
   `$PROJECT_TASKS_HOME`, per `init.md:61-68`.
4. **Fix the dangling command pointers** at `commands/task-read.md:7` and
   `commands/plan-read.md:7`: change "the project-tasks skill's
   host-compatibility setup block" to "the helper resolution block in
   `commands/init.md`", matching how `plans.md:6` already cites it.
5. **Update `tests/test-project-discovery.md:3-8`** to cite
   `commands/init.md` "Resolve the project identifier" instead of the removed
   "Prerequisites section (step 3)"; enumerate all four steps from
   `init.md:100-109`; include the `.codex/` and `$PROJECT_TASKS_CONFIG_DIR`
   paths; add the "only inside a Git repository" guard to the basename tier; and
   drop the `node -e` mechanics at `:46`/`:126`. Consider adding a variant for
   the boundary-stop rule at `init.md:111-113`.
6. **Align the three soft heading references** in §5.4: `plans.md:300` and
   `commands/task-run.md:9` should name a heading that exists in
   `task-execution.md` (e.g. "Start the task"), and `plans.md:289-290` should
   match the actual casing of `task-commands.md:115`.
7. **Correct `green-results.md:158`** ("All 6 tests PASS") once items 1–2 land,
   and either refresh or explicitly date-stamp the `TASKS.md`-era language at
   `green-results.md:5-12`, `:159` and `baseline-results.md:51` as historical.

None of these require changes to `SKILL.md`, `references/validation-flow.md`,
`references/task-execution.md`, or `references/task-commands.md` — the
validation decision flow itself is approved as written.
