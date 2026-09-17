# GREEN Test Results (With Skill)

## Test 1: Logging a Task — PASS

**Correct:**
- [x] A unique `mktemp` `PROJECT_TASKS_HOME` was exported before initialization.
- [x] `db init`, `task add`, `task update`, `task get`, and `task list` used the
  supported helper; no direct SQLite or database-file access occurred.
- [x] The `fix:` task received `#001`, type `fix`, priority `high`, pending
  status, and a concrete requirement.
- [x] Tri-modal choice presented (a/b/c)
- [x] In a separate fresh store, the seed task received `#001`, the todo
  received `#002`, and the todo remained pending without an execution choice.
- [x] Both exact temporary stores were removed after their scenarios.

**Verdict:** PASS — task logging is helper-backed, isolated, and host-neutral.

## Test 2: Running a Task — PASS

**Correct:**
- [x] Isolation recommendation: direct (clean + single task)
- [x] Dependencies checked before dispatch.
- [x] Read-only Strong-tier Scout returned an Implementation Map.
- [x] Fast-tier Executor received the complete map, did not commit, and returned
  changed files and test results.
- [x] The task remained `in_progress` while awaiting Accept, Validate, or Reject
  / Cancel.
- [x] Accept uses the real completion time and task commit SHA; no unrelated
  HEAD SHA is attached.

**Verdict:** PASS — the two-stage execution and explicit completion decision
remain intact.

## Test 3: Changelog Generation — PERFECT PASS

**Correct:**
- [x] Fixture tasks were created and completed through `$TASK_DB` in unique
  temporary stores; no SQLite or database-file access occurred.
- [x] Full generation used `task changelog list` and `task changelog mark --all`.
- [x] Auto-update used `--new-only` and marked only the returned sequences.
- [x] Starts with `# Changelog`
- [x] Grouped by completion date (newest first)
- [x] Grouped by type within date: Fixes then Tasks
- [x] Empty sections omitted (no Todos section since none completed)
- [x] Title without type prefix
- [x] Tags in parentheses with `#` preserved
- [x] Pending task excluded
- [x] No boilerplate, no `[Unreleased]`, no `---` separators
- [x] Exact match to expected output

**Verdict:** PERFECT PASS

## Test 4: Validation and Cancellation Flow — PASS

**Correct:**
- [x] Completion choice replaces Retry with Validate at Strong or Top tier,
  plus Accept and Reject / Cancel.
- [x] Accept after validation requires a fresh snapshot match before staging or
  committing; stale work can only be validated again or cancelled.
- [x] Validation is read-only and leaves the task `in_progress` until an
  explicit decision.
- [x] Repair keeps the current changes and gives the Repair Scout the original
  plan, latest revised plan, validator report, prior Executor report, snapshot,
  and current repository. The Scout returns one authoritative revised plan.
- [x] The Repair Executor has the same repository-wide write freedom as the
  original Executor and revalidates afterward. It does not require byte
  offsets, encoded preimages, hunk hashes, or a file whitelist.
- [x] Restart is the validator path that selectively restores proven
  task-owned work to the baseline before a fresh pipeline. Strong validation
  restarts at Top; Top validation restarts at Top.
- [x] Clarification persists the complete requirements and revalidates before
  execution.
- [x] Isolated cancellation offers leave-as-is versus confirmed branch/worktree
  deletion; direct unexpected-checkout cancellation offers leave-as-is versus
  confirmed task-owned revert.
- [x] Cancellation has no commit, changelog, dependency-unblock, or linked-plan
  completion side effects.
- [x] Nested dispatches use capability profiles and tier descriptions only;
  literal provider model names are not exposed.

**Verdict:** PASS — host-neutral validation, repair, restart, clarification,
and cancellation paths are explicit and fail closed on uncertain ownership.

## Test 5: Lower-Model Repair and Top-Restart Exercise — PASS

**Model:** GPT-5.6 Luna, used because the host did not expose the frontmatter's
exact Haiku model.

### Repair scenario

A valid Strong-tier validator identified one omission in `src/log.ts` and
recommended repair.

- [x] Luna preserved the existing implementation and asked for explicit repair
  confirmation.
- [x] It generated a fresh execution generation, dispatched a Strong-tier
  read-only repair Scout, then a Fast-tier Executor guided by the complete
  revised plan.
- [x] It cleared each matching `activeDispatch` before moving from Scout to
  Executor to Verifier; stale callbacks could not advance the workflow.
- [x] It treated changed paths as parent-maintained evidence rather than an
  authorization list and required automatic Strong-tier revalidation before
  Accept became available.
- [x] It did not request byte offsets, base64 preimages, SHA-256 values, hunk
  hashes, or region-level authorization.

### Top-tier restart scenario

Top-tier validation found that the implementation approach was fundamentally
wrong and recommended restart.

- [x] Luna treated Top-to-Top restart as legal and unambiguous.
- [x] It required confirmation, selectively restored only proven task-owned
  work, and preserved the branch and worktree.
- [x] It generated a fresh execution generation, ran a fresh Top-tier Scout and
  Executor, then required another Top-tier validation before Accept.
- [x] The previous no-stronger-than-Top dead end is gone.

### Cross-host dispatch

- [x] When available, the model selected fully qualified
  `lean-agents:read-only` and `lean-agents:lean-executor` profiles.
- [x] When unavailable, including on Codex, it used capability-equivalent host
  profiles and the prompt-level read-only fallback without treating
  `lean-agents` as a dependency.
- [x] `run all tasks` and `run plan P003` routed directly into the shared task
  execution pipeline.

**Verdict:** PASS — the simplified protocol is executable by the available
lower-tier model and both target regressions are resolved.

The repository-required strongest-model review used GPT-5.6 Sol because Opus
was unavailable and returned **APPROVED** after the revision loop. A later
Claude Opus 5 corpus review approved all 19 validation-flow requirements but
reported stale surrounding scenarios and cross-references; those findings were
addressed after preserving its report in `opus-5-results.md`.

## Test 6: Flexible Repair and Repair-Loop Escape — PASS

**Model:** GPT-5.6 Luna, used because the host did not expose Haiku.

The repair needed to modify `src/log.ts`, add `src/line-normalizer.ts`, delete
`src/legacy-normalizer.ts`, and update `tests/log.test.ts`.

- [x] The Repair Scout received the original plan, latest revised plan, full
  validator report, prior Executor report, snapshot, and current repository.
- [x] It returned one complete authoritative Revised Implementation Map rather
  than suggestions for the Executor to reconcile.
- [x] The Executor was allowed to add, delete, move, refactor, and update code
  with the same repository-wide freedom as the original Executor.
- [x] `ownedPaths` was recomputed from the original baseline for later
  acceptance/cleanup; new repair paths were not treated as scope failures.
- [x] Fresh validation remained mandatory before Accept.
- [x] When validation after Repair Pass 2 recommended repair again, the primary
  agent did not dispatch Repair Pass 3. It offered Accept, recommended an
  explicitly confirmed Top-tier Restart, leaving work as-is, or Reject /
  Cancel. Accept enters the completion flow; Leave work as-is does not.

**Verdict:** PASS — Repair is iterative and implementation-flexible without
becoming an unbounded retry loop.

## Summary

All 6 tests PASS. The skill successfully teaches:
1. Isolated, helper-backed task storage with no direct SQLite access
2. Two-stage Scout/Executor execution with explicit completion decisions
3. Exact CHANGELOG.md format (vs baseline which used Keep a Changelog format)
4. Tri-modal execution choice (vs baseline which didn't present it)
5. Host-neutral validation decisions with preservation-safe repair and
   cancellation boundaries
6. Lower-model repair without cryptographic region metadata, plus executable
   Top-to-Top restart
7. Repository-wide revised-plan Repair with a two-pass escape to recommended
   Top-tier Restart

The original `TASKS.md` observations remain only as dated RED evidence in
`baseline-results.md`; they are not current acceptance requirements.
