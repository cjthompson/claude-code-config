# Baseline Test Results (Without Skill)

> Historical RED evidence: Tests 1-3 were captured before project-tasks moved
> to the `task-db` helper. Their invented `TASKS.md` behavior demonstrates the
> baseline agent's failure, but it is not the current expected storage format.
> Current acceptance behavior is defined by `test-log-task.md`,
> `test-run-task.md`, and `test-changelog.md`.

## Test 1: Logging a Task

**Input:** `fix: Log lines should never exceed one line`

**Failures observed:**
1. **Wrong format entirely** — Used `## Fix:` (capitalized) instead of `## fix:`
2. **No metadata line** — Missing `**Date:** ... | **Priority:** ... | **Tags:** ...` format
3. **No `---` separator** before entry
4. **Wrong status format** — Used `**Status:** Open` instead of `**Status:** pending`
5. **No `### Requirements` section** — Wrote a freeform "Description" and "Next Steps" instead
6. **No tri-modal choice** — Instead asked clarifying questions about the fix
7. **Added extra sections** — "Context", "Related Files", "Next Steps" not part of spec
8. **Did not create `# Tasks` header** — Used `# Tasks` but overall structure is wrong

**Key insight:** Without the skill, the agent invents its own format that's closer to a GitHub issue than our compact task format. It also doesn't know about the tri-modal execution choice at all.

## Test 2: Running a Task via Subagent

**Input:** `run task #1`

**Failures observed:**
1. **No tri-modal choice presented** — Jumped straight to analysis
2. **No worktree recommendation** — No consideration of git status or isolation
3. **Subagent context too broad** — Would send "Key Files to Investigate", "Definition of Done", and extra context beyond CLAUDE.md + README.md + requirements
4. **Wrong TASKS.md update format** — Used `**Status:** completed` (no timestamp) and added a non-spec "Completion Notes" section with "Changes" list
5. **No auto-update of CHANGELOG.md** — Not mentioned at all
6. **Extra metadata added** — Added "Completion Notes", "Changes" sections not in spec
7. **Did not use Agent tool** — Described what it would do rather than dispatching

**Key insight:** The agent provides far too much context to the subagent (defeating the minimal-context goal) and doesn't know the correct status format `completed (YYYY-MM-DD HH:MM)`.

## Test 3: Changelog Generation

**Input:** `Generate the changelog`

**Failures observed:**
1. **Wrong type headings** — Used `### Fixed` and `### Added` (Keep a Changelog convention) instead of `### Fixes`, `### Tasks`, `### Todos`
2. **Added boilerplate** — "All notable changes..." preamble not in spec
3. **Added `[Unreleased]` section** — Not in spec
4. **Added `---` separators between dates** — Not in spec
5. **Included task descriptions in bullets** — Added requirement details after title instead of just title + tags
6. **Wrong tag format** — Tags not shown in parentheses at all
7. **`task:` mapped to "Added"** — Should stay as "Tasks"

**Key insight:** The agent defaults to "Keep a Changelog" conventions rather than our custom format. Tags are completely lost and type mapping is wrong.

## Historical lessons from Tests 1-3

1. **Use the supported task helper** rather than inventing a file-backed task format.
2. **Tri-modal execution choice** — Run Now / Log Only / Auto-Run All
3. **Minimal subagent context** — ONLY CLAUDE.md + README.md + task requirements
4. **Worktree recommendation** logic based on git status
5. **Exact status format** — `pending` / `completed (YYYY-MM-DD HH:MM)`
6. **Exact CHANGELOG.md format** — our custom format, not "Keep a Changelog"
7. **Prepend behavior** — newest tasks first
8. **Auto-update CHANGELOG.md** after task completion
9. **No extra sections** — no Description, Context, Related Files, Completion Notes

## Test 4: Validation and Cancellation Flow

**Input:** A task runner finished with a partial report and uncommitted changes
in an isolated worktree. The user requested Strong/Top-tier validation,
repair-in-place, clean restart, clarification, and Reject / Cancel behavior.

**Baseline agent output (without the skill):**

- It produced a roughly correct four-option menu, but used generic numbered
  labels (`Validate — Strong`, `Validate — Top`) rather than the exact tier
  contract and did not define the TaskList state.
- It said Accept should leave the worktree uncommitted, contradicting the
  existing task acceptance flow.
- It identified repair, restart, and cancellation but left confirmation,
  ownership tracking, malformed validator output, direct-checkout cleanup, and
  linked-plan behavior as unresolved ambiguities.
- It did not specify the database status transition, changelog suppression, or
  dependency/plan post-processing for cancellation.

**Key insight:** The desired distinction is not self-enforcing: without an
explicit contract, an agent can conflate validation with mutation, treat repair
as a clean restart, or perform destructive cleanup without proving ownership.

## Test 5: Lower-Model Repair and Top-Restart Exercise

**Model:** GPT-5.6 Luna, used as the available fast/lower-tier host model.

**Repair scenario:** A valid Strong-tier validator recommends repairing one
bounded omission in `src/log.ts`, and the user confirms repair in place.

**Observed failure with the pre-refactor skill:**

- The model reproduced the byte-offset, base64-preimage, canonical SHA-256, and
  half-open-region protocol rather than performing a concise repair workflow.
- It reported that it could not safely construct the prompts or validate the
  repair without the validator's literal byte ranges, hashes, and encoded
  preimages.
- It generated a fresh execution-generation token even though the repair flow
  did not explicitly say where that transition occurs, exposing ambiguity in
  the lifecycle instructions.

**Top-tier restart scenario:** Top-tier validation finds that the implementation
uses a fundamentally wrong approach and must restart.

**Observed failure with the pre-refactor skill:**

- The model correctly concluded that `restart` was semantically required but
  structurally invalid because no tier is stronger than Top.
- The only executable choices were to validate again at Top or cancel, so the
  workflow could repeat indefinitely without offering the required restart.
- The model explicitly rejected repair and clarification as invalid workarounds.

**Key insight:** The lower-tier model understood the prose but the protocol made
the valid action impossible or dependent on mechanical data the skill does not
provide. The refactor must remove those mechanical fields and permit Top-tier
validation to restart at Top when a clean restart is required.

## Test 6: Flexible Repair and Repair-Loop Escape

**Model:** GPT-5.6 Luna, used as the available lower-tier host model.

**Scenario:** An architecturally sound implementation needs a repair that
modifies its original file, adds a helper, deletes obsolete code, and updates a
test. Validation continues to recommend repair after two repair passes.

**Observed failure before the flexible-repair revision:**

- The Repair Scout did not receive the original Scout plan, latest revised
  plan, or prior Executor report, and was told to plan only within the original
  `ownedPaths`.
- The Repair Executor was forbidden to add, delete, or update the additional
  required files; any new path was classified as a scope failure.
- `ownedPaths` was treated as an immutable authorization list rather than a
  parent-maintained record of the task's current repository delta.
- After validation following Repair Pass 2 recommended repair again, the skill
  simply allowed Repair Pass 3. It had no rule to recommend a confirmed
  Top-tier Restart and escape the loop.

**Key insight:** Repair needs the same repository-wide implementation freedom as
the original Executor. The prior plan lineage and validator evidence should
produce one authoritative revised plan, while snapshots and task-path tracking
support review and cleanup rather than pre-authorizing which code may change.
