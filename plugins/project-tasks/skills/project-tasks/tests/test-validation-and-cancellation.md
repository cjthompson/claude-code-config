# Test: Validation, Repair, Restart, and Cancellation

This scenario is the acceptance test for the post-execution decision flow. It
must remain host-neutral: use capability profiles and model tiers, never literal
provider model names.

## Setup

Task `#1` is `in_progress`. The executor has finished with changes in an
isolated worktree recorded by the task runner:

- worktree: `/tmp/example-task-worktree`
- branch: `task/example-task`
- worktree created by task: `true`
- branch created by task: `true`
- base commit: `abc1234`
- baseline path/content snapshot: clean before dispatch
- currently task-attributed paths: `src/log.ts`, `tests/log.test.ts`,
  `fixtures/new-case.json`

Before a confirmed repair, capture a fresh Git status/diff snapshot for the
worktree so concurrent changes can be detected without asking an agent
to calculate byte ranges, hashes, or encoded preimages.

The worktree contains modified tracked files and one new untracked file. The
task's executor report is available, but the task has not been accepted or
committed.

## Completion Decision

The skill presents exactly:

```text
a) Accept — mark complete and update changelog
b) Validate with Strong tier — run a read-only verifier
c) Validate with Top tier — run a read-only verifier
d) Reject / Cancel — cancel the task and choose what happens to the work
```

The frontmatter `model: haiku` remains skill-exercise metadata. It is not a
dispatch instruction; all nested agents are selected by capability and tier.

## Validation Contract

Validation is read-only, inspects the task requirements, the recorded baseline,
the current diff, and untracked files, and leaves the database task
`in_progress`. It reports exactly one recommendation enum:

```text
recommendation: accept | repair | restart | clarify
```

The report includes per-requirement evidence plus only the details needed by the
recommendation: questions for `clarify`, or findings for `repair`. Each repair
finding identifies the relevant code or behavior, the issue, and the behavior
to change. A referenced path is diagnostic context, not a write-authorization
boundary.

### Recommendation: accept

Use the existing safe Accept flow: stage only task-owned paths, commit, mark
the task completed, update the changelog, check unblocked tasks and linked-plan
progress, then complete/remove the TaskList entries.

### Recommendation: repair

Keep the current changes. Pass the validator's concrete findings to a fresh
read-only Scout at the same selected tier, then chain a Fast-tier Executor to
repair the implementation. The Repair Scout receives the original task
requirements, original Scout plan, latest revised plan when one exists,
validator report, previous Executor report, pre-repair snapshot, and current
repository state. It reviews the prior plan and returns one complete Revised
Implementation Map describing what remains valid, what changes, all code/file
operations, and verification commands.

The Repair Executor receives that complete revised plan and has the same
repository-wide write freedom as the original Executor. It may add, delete,
move, refactor, or update code as the revised plan requires. It must work from
the current implementation without resetting and must not commit. Recompute the
task's changed paths from the original execution baseline and re-run read-only
validation before Accept can be offered.

Track completed repair passes. If validation after Repair Pass 2 recommends
`repair` again, do not dispatch a third Repair Scout. The primary agent explains
that two repair attempts remain insufficient and recommends a Top-tier Restart:

```text
a) Accept — accept the current implementation despite the remaining findings
b) Restart with Top tier — discard the current task implementation and run a fresh pipeline
c) Leave work as-is
d) Reject / Cancel
```

Accept enters the normal Accept flow, including its snapshot check, scoped
staging, commit, and task completion. Leave work as-is performs none of those
actions. Restart still requires explicit confirmation.

### Recommendation: restart

Ask for explicit confirmation before cleanup. If confirmed, selectively revert
the task-owned changes to the recorded baseline, then run a fresh read-only
Scout followed by a write-capable Executor at the recommended execution tier.
Strong validation may escalate the restart to Top; Top validation restarts at
Top because no stronger tier exists. The fresh Scout produces a new
Implementation Map from the clean baseline. If the baseline or ownership cannot
be proven, do not clean up automatically.

### Recommendation: clarify

Keep the current changes. Ask the validator's questions, persist the complete
clarified requirement set with the task helper, and re-run the same read-only
validation before dispatching any executor.

## Reject / Cancel

Selecting `d` marks the task `cancelled` only after the work disposition is
chosen. It never commits, updates the changelog, checks dependencies, offers
plan completion, or marks the task completed.

For an isolated worktree, ask:

```text
a) Leave work as-is — preserve the recorded branch and worktree
b) Delete work — confirm, then remove the recorded branch and worktree
```

Deletion requires confirmation of the exact recorded path and branch, verifies
that the worktree was task-created, is not checked out elsewhere, and is not a
protected/default branch. Any failed guard leaves the work intact.

For an unexpected direct checkout, ask:

```text
a) Leave work as-is
b) Revert changes — confirm, then selectively revert task-owned changes
```

The direct-checkout option must not use a broad `git checkout .`.

Validator-recommended Restart is the only validator path that selectively
reverts and then dispatches a new pipeline. Direct-checkout `Revert changes` is
only a user-selected cancellation cleanup and never restarts the task.

## Failure Criteria

- **FAIL** if validation modifies files, requirements, database status, or
  completion metadata; an awaiting-decision TaskList/in-memory transition for
  a stale or malformed report is lifecycle bookkeeping and is allowed.
- **FAIL** if Accept skips the fresh snapshot equality check after a Validator
  report and before staging or committing.
- **FAIL** if the validator returns more than one recommendation or omits
  evidence/findings/questions required by its recommendation.
- **FAIL** if a repair finding omits concrete evidence, the issue, or requested
  behavior change.
- **FAIL** if repair resets or discards the current changes.
- **FAIL** if Repair is restricted to the original changed-path set, cannot add,
  delete, move, refactor, or update code required by the Revised Implementation
  Map, or offers Accept without another read-only validation pass.
- **FAIL** if the Repair Scout lacks the original plan and latest revised plan,
  or returns suggestions that the Executor must reconcile instead of one
  complete authoritative Revised Implementation Map.
- **FAIL** if a third Repair pass is dispatched after validation following
  Repair Pass 2 recommends repair again, rather than recommending a confirmed
  Top-tier Restart.
- **FAIL** if the post-Repair-Pass-2 menu omits Accept or treats Leave work
  as-is as task acceptance.
- **FAIL** if Top-tier validation recommends restart but the workflow cannot
  perform a confirmed Top-tier restart.
- **FAIL** if restart or deletion performs cleanup without explicit confirmation.
- **FAIL** if cleanup cannot prove baseline, branch, worktree, or path ownership
  and still deletes/reverts work.
- **FAIL** if cancellation creates a commit, changelog entry, dependency
  notification, or plan-completion offer.
- **FAIL** if any dispatch instruction uses a literal provider model name instead
  of a capability profile and tier description.
- **FAIL** if the workflow requires byte offsets, base64 preimages, hunk hashes,
  or region-level cryptographic authorization.
