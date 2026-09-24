# Test: Host-Aware Two-Stage Task Pipeline

This scenario tests the default task pipeline and its post-execution decision
flow. Model selection is expressed only with capability profiles and tiers.

## Setup

The project has `AGENTS.md`, `README.md`, and a pending task `#1`:

```text
fix: Log lines should never exceed one line
Requirements:
- Replace line breaks with a visible symbol
- Trim leading and trailing whitespace
```

The working tree is clean. The task runner creates an isolated worktree and
records its path, branch, base commit, separate worktree/branch creation flags,
baseline snapshot, and ownership boundary before dispatch.

## Default Pipeline

1. Check dependencies with `$TASK_DB task deps check`.
2. Create the two TaskList entries with `syncTaskToList(seq, "pending", ...)`.
3. Dispatch a background Planning Scout using the read-only profile and the
   host-resolved **Strong tier**.
4. Call `syncTaskToList(seq, "scouting", ...)`. The Scout receives only the
   project instructions, README, task data, and requirements, and returns an
   Implementation Map without editing files.
5. Chain a background Execution Agent using the write-capable profile and the
   host-resolved **Fast tier**.
   When the host's agent roster includes the optional `lean-agents` plugin, the
   dispatch resolves `lean-agents:read-only` for Planning Scout and
   `lean-agents:lean-executor` for Execution Agent. Otherwise, a
   capability-equivalent host profile is used. When no structurally read-only
   profile is available, the host's general subagent is reinforced at the prompt
   level with the exact text: *"You have write tools available only because the
   read-only profile is not installed. Do not use them. Do not modify files, the
   index, or task data."*, and the user is told: *"Note: this host does not
   expose a structurally read-only subagent, so read-only enforcement is
   prompt-level for this dispatch."*
6. Call `syncTaskToList(seq, "executing", ...)`. The Executor follows the map,
   edits only the mapped files, runs the mapped test command, and returns a
   structured report without committing.
7. Record the task as awaiting a user decision:
   `syncTaskToList(seq, "awaiting_decision", ...)`.

## Completion Menu

```text
a) Accept — mark complete and update changelog
b) Validate with Strong tier — run a read-only verifier
c) Validate with Top tier — run a read-only verifier
d) Reject / Cancel — cancel the task and choose what happens to the work
```

The skill never exposes literal provider model names. The frontmatter
`model: haiku` is skill-exercise metadata and does not select nested agents.

## Validation Variants

Validation sets the TaskList phase to `validating`, but leaves the database task
`in_progress` and changes no files, index, or completion metadata. The validator
inspects the baseline, current diff, and untracked files, then returns exactly
one of `accept`, `repair`, `restart`, or `clarify` with evidence.

### Repair

After explicit user confirmation, keep the current changes. Run a read-only
Scout at the selected validation tier. Give it the original Scout plan, latest
revised plan when present, full validator report, previous Executor report,
pre-repair snapshot, requirements, and current repository. It returns one
complete Revised Implementation Map, not a list of suggestions.

Run a Fast-tier Executor with that revised map and the same repository-wide
write freedom as the original Executor. It may add, delete, move, refactor, or
update code. Do not reset first and do not commit.
Revalidate again at the selected tier before presenting another completion
decision.

After validation following Repair Pass 2, another `repair` recommendation does
not start Repair Pass 3. Offer Accept, recommend a confirmed Top-tier Restart,
leave work as-is, or Reject / Cancel. Accept enters the normal acceptance flow;
Leave work as-is does not commit or complete the task.

### Restart

After explicit user confirmation, show the exact path, branch, base commit, and
owned paths. Selectively restore task-owned tracked paths to the base commit and
remove task-created untracked paths. Keep the branch/worktree, then dispatch a
read-only Scout followed by a write-capable Executor at the recommended
execution tier. Strong validation may escalate to Top; Top validation restarts
at Top. The fresh Scout produces a new Implementation Map from the clean
baseline. If ownership or identity is uncertain, preserve the work and report
the mismatch.

### Clarify

Keep the current changes. Ask the validator's questions verbatim, persist the
complete clarified requirement set using repeated `--req` flags, and re-run
read-only validation before dispatching an Executor.

## Reject / Cancel Variants

For an isolated worktree:

```text
a) Leave work as-is — preserve the recorded branch and worktree
b) Delete work — confirm, then remove the recorded branch and worktree
```

Deletion re-checks the exact recorded path and branch, task-created ownership,
worktree availability, and protected/default branch status. A failed guard
leaves work intact.

For an unexpected direct checkout:

```text
a) Leave work as-is
b) Revert changes — confirm, then selectively revert task-owned changes
```

Direct cleanup never uses broad `git checkout .`. All cancellation paths mark
the task `cancelled`, clear/terminally mark both TaskList entries, and skip
commit, changelog, dependency-unblock, and linked-plan completion work.

Validator-recommended Restart is the only validator path that selectively
reverts and then dispatches a new pipeline. Direct-checkout `Revert changes` is
only a user-selected cancellation cleanup and never restarts the task.

## Failure Criteria

- **FAIL** if the default pipeline omits either the read-only Scout or the
  write-capable Executor.
- **FAIL** if a nested dispatch uses a literal provider model name.
- **FAIL** if profile fallback silently drops the read-only reinforcement /
  user note when no structurally read-only subagent is available.
- **FAIL** if validation mutates files or database task status; stale/malformed
  lifecycle bookkeeping may move the in-memory/TaskList phase to
  `awaiting_decision`.
- **FAIL** if repair discards current changes.
- **FAIL** if repair is restricted to the original path set, lacks the prior
  plan lineage, returns only suggestions instead of a complete revised map, or
  skips post-repair validation.
- **FAIL** if a third repair pass is dispatched instead of recommending a
  confirmed Top-tier Restart.
- **FAIL** if the repair-loop escape omits Accept or conflates it with Leave
  work as-is.
- **FAIL** if Top-tier validation cannot perform a confirmed Top-tier restart.
- **FAIL** if restart or deletion cleans up without explicit confirmation.
- **FAIL** if cleanup proceeds without a proven baseline and ownership boundary.
- **FAIL** if cancellation creates a commit or changelog entry.
- **FAIL** if repair or restart requires byte offsets, encoded preimages, or
  hunk hashes.
