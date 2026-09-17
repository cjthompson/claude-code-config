# Validation, Repair, Restart, and Cancellation

Read this file after task execution when the user selects validation, repair,
restart, clarification, rejection, or cancellation.

## Contents

- Validation contract
- Accept, repair, restart, and clarify
- Reject / Cancel
- Recovered and failed validation

## Decision gate

Before any action, require `activeDispatch` to be empty and recheck the recorded
path, branch, base commit, and ownership boundary. Validation itself is
read-only and keeps the database task `in_progress`.

For every Scout, Executor, or Verifier callback, first require its generation,
stage, and host dispatch ID to match `activeDispatch`. Ignore stale callbacks.
For a matching callback, record its result and clear `activeDispatch` before
snapshot checks or dispatching the next stage. A callback received after
`cancellationRequested` may only record termination and clear the dispatch.

## Validate

Store the user's tier as `validationTier: strong | top`. Capture the current
tracked/index/untracked/relevant-ignored status and diffs as an immutable
`validationSnapshot`. Sync `validating`, then dispatch the read-only Verifier at
that tier in the recorded execution location. Record
`{generation, stage: validator, id}`.

Verifier prompt:

```text
You are a read-only task Verifier. Do not modify files, the Git index, task
requirements, task status, or completion metadata.

Task: #{SEQ} {type}: {title}
Requirements:
- {each requirement}

Execution context:
- path/branch/base commit/isolation: {recorded values}
- baseline snapshot: {baselineSnapshot}
- current validation snapshot: {validationSnapshot}
- task-owned paths: {ownedPaths}

Inspect the current diff, task-created untracked files, repository, and relevant
history. Return per-requirement Found, Partial, Not Found, or Cannot Verify
verdicts with file:line or commit evidence.

Return exactly one recommendation:
- accept: every requirement has sufficient evidence;
- repair: the architecture and overall approach are sound, but implementation
  changes are still required;
- restart: the approach is fundamentally wrong or needs redesign;
- clarify: material requirements are unanswered or ambiguous.

For repair, include findings with exactly:
- id
- location (path, symbol, behavior, or precise line description when known)
- issue
- requested behavior change

For clarify, include a nonempty questions list. Do not include findings for
accept, restart, or clarify.
```

When the Verifier returns:

1. Clear only the matching dispatch.
2. Capture a fresh snapshot and require equality with `validationSnapshot`.
   A changed snapshot makes the report stale.
3. Require one known recommendation and its required fields. Do not infer
   omitted recommendations or repair details.
4. Sync `awaiting_decision` and show the complete report. Ask for confirmation
   before Accept, Repair, Restart, or cleanup. If the recommendation is
   `repair` and `repairPassCount` is already `2`, use the repair-loop escape
   below instead of offering Repair Pass 3.

Malformed/stale reports preserve work and offer only validation again at the
same selected tier or Reject / Cancel.

## Accept recommendation

Ask whether to accept. On confirmation, use the Accept flow in
`task-execution.md`; its fresh snapshot comparison closes the interval between
validation and commit.

## Repair recommendation

Repair is appropriate when the architecture and overall approach are sound. It
keeps the current implementation as the starting point, but the revised plan
and Executor may add, delete, move, refactor, or update any repository code
needed to correct the implementation.

1. Show the findings and ask:

   ```text
   a) Repair in place — keep current changes and address these findings
   b) Leave work as-is
   ```

2. On confirmation, require the current snapshot to equal
   `validationSnapshot`; otherwise discard the stale report.
3. Increment `repairPassCount`, generate a fresh `executionGeneration`, preserve
   the current worktree, and record a pre-repair Git status/diff snapshot.
4. Sync `scouting` and dispatch a read-only repair Scout at the selected
   validation tier. Give it:

   - the original task requirements;
   - `originalImplementationMap`;
   - `currentImplementationMap` (the latest revised plan, or the original plan
     on Repair Pass 1);
   - the complete validator report and findings;
   - `lastExecutorReport`;
   - the pre-repair snapshot and current repository.

   It reviews the previous plan and returns one authoritative Revised
   Implementation Map containing what remains valid, what must change, the
   complete file/code operations, and tests/verification commands. It does not
   return loose suggestions for the Executor to reconcile. If it concludes the
   architecture is fundamentally unsound, it returns `restart required`
   instead of planning a rewrite. On its matching callback, clear
   `activeDispatch` before evaluating the result. Store a valid revised map as
   `currentImplementationMap`; a `restart required` result offers the confirmed
   Top-tier Restart choice without dispatching a Repair Executor.
5. Recheck the snapshot, then sync `executing` and dispatch a Fast-tier repair
   Executor with the complete validator report and authoritative Revised
   Implementation Map. Give it the same repository-wide write freedom as the
   original Executor. It may add, delete, move, refactor, or update code as the
   revised map requires. It works from the current implementation, must not
   reset the worktree, and must not commit.
6. On the Executor's matching callback, clear `activeDispatch`, store the full
   result as `lastExecutorReport`, and recompute `ownedPaths` from the original
   execution baseline. New or newly modified paths are part of the task's
   evolving implementation; they are not automatically scope failures.
7. Capture a new validation snapshot and automatically re-run the read-only
   Verifier at `validationTier`, recording it as the active validator dispatch.
   Its matching callback follows the Validate rules above, including clearing
   the dispatch. Accept is available only if that fresh validation recommends
   it.

The parent and workers do not calculate byte offsets, encoded preimages, hunk
hashes, or region-level authorization. The Repair Executor is guided by the
complete revised plan and validator evidence rather than a file whitelist.
Preserving the current worktree, prohibiting commits, fresh validation, and
explicit acceptance distinguish Repair from an uncontrolled retry.

### Repair-loop escape

If validation after Repair Pass 2 recommends `repair` again, do not start a
third repair pass. Explain that two repair attempts have not resolved the
findings and recommend restarting with Top tier:

```text
a) Accept — accept the current implementation despite the remaining findings
b) Restart with Top tier — discard the current task implementation and run a fresh pipeline
c) Leave work as-is
d) Reject / Cancel
```

Accept follows the normal Accept flow in `task-execution.md`, including its
fresh snapshot check, scoped staging, commit, and task completion. Leave work
as-is performs none of those actions and keeps the task `in_progress`.

The restart is a recommendation, not automatic cleanup. Option (b) requires the
same explicit confirmation and selective cleanup as any Restart, then runs the
Restart Scout, Executor, and validation at Top tier. Reset `repairPassCount` to
`0` only after the confirmed restart establishes its clean execution baseline.

## Restart recommendation

Restart discards only the current task-owned implementation and requires an
explicit confirmation.

Execution tier:

- Strong validation restarts at Top.
- Top validation restarts at Top; Top is already the highest tier, so validation
  must not dead-end merely because no stronger tier exists.

1. Show path, branch, base commit, and `ownedPaths`. Ask:

   ```text
   a) Restart — selectively restore task-owned work and run a fresh pipeline
   b) Leave work as-is
   ```

2. On confirmation, recheck identity and ownership. Restore tracked owned paths
   in both index and worktree to the recorded baseline and remove only
   task-created untracked owned paths. Keep the branch and worktree.
3. Verify those paths match the baseline. If not, stop and preserve what
   remains.
4. Generate a fresh `executionGeneration` and clean execution baseline.
   Reset `repairPassCount` to `0` and clear prior revised-plan/executor-report
   state; the Restart Scout's map becomes the new original and current map.
5. Sync `scouting`; dispatch a read-only Restart Scout at the restart tier with
   original requirements and complete validator evidence. It produces a fresh
   Implementation Map from the clean baseline. On its matching callback, clear
   `activeDispatch` before evaluating the map or continuing.
6. Recheck the baseline; sync `executing`; dispatch a write-capable Executor at
   the same restart tier with the map. It does not commit. On its matching
   callback, clear `activeDispatch` before inspecting the result.
7. Recompute `ownedPaths` from the restart baseline and run a fresh read-only
   validation at the restart tier, recording it as the active validator
   dispatch. Its matching callback clears the dispatch under the Validate rules
   before Accept can be offered.

If baseline or ownership cannot be proven, do not restore or delete anything.

## Clarify recommendation

Keep current work and ask the validator's questions verbatim. Persist the full
resulting requirement set, including unchanged requirements, with repeated
`--req` flags. Re-run read-only validation at the same tier before dispatching
any write-capable worker.

## Reject / Cancel

First quiesce the active worker if one exists:

1. Set `cancellationRequested` before requesting host cancellation.
2. Wait for matching termination and clear the dispatch.
3. Recompute task-owned paths from the baseline, including partial output.

If cancellation cannot be confirmed, keep the task `in_progress` and perform no
cleanup.

For an isolated worktree:

```text
a) Leave work as-is — preserve the recorded branch and worktree
b) Delete work — confirm, then remove the recorded branch and worktree
```

For an unexpected direct checkout:

```text
a) Leave work as-is
b) Revert changes — confirm, then selectively restore task-owned paths
```

Delete/Revert requires a second confirmation naming the exact target. Recheck
live path, branch, HEAD/base identity, ownership flags, other worktree checkouts,
and protected/default branch status immediately before cleanup. Never use broad
restore/reset/clean commands.

After a disposition is chosen, mark the task cancelled and sync both task-list
entries terminal:

```bash
$TASK_DB task update --project "$PROJECT" --seq "#{SEQ}" --status cancelled
```

Cancellation never commits, changes the changelog, reports dependencies as
unblocked, or offers plan completion. If confirmed cleanup starts and then
fails, stop, mark the task cancelled with a residual-state report, and name
exactly what remains.

## Validator failure

On validator failure, timeout, interruption, stale output, or malformed output:

- preserve work and keep the database task `in_progress`;
- sync `awaiting_decision` only after the worker has terminated;
- offer validation again at the same tier or Reject / Cancel;
- do not infer Accept, Repair, Restart, or Clarify.
