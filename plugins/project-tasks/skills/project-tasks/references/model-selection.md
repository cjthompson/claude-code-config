# Model Selection Beyond the Baseline

Read this file before dispatching the initial Planning Scout and Execution
Agent for a task (`task-execution.md`), and before presenting the completion
menu. `SKILL.md` holds the baseline tier per role and the tier-to-model table;
this file decides when a task justifies a higher tier and how to recommend it.

It does not apply to repair, restart, or re-validation dispatches, or to the
`check` Verifier: use the tiers `validation-flow.md` and `task-commands.md` fix
for those, and never ask a tier question for them. The Verifier tier after the
completion menu is the option the user picks.

## Principles

- Start from the baseline tier. Deviate only on evidence from the signals below,
  never on a general feeling that the task is hard.
- Recommend upward only. Never recommend a tier below the baseline.
- A recommendation is advice. The user chooses, and a model the user names
  always wins (see `SKILL.md`).
- A chosen tier applies to that dispatch only. Resolve it to a model and
  reasoning level through the `SKILL.md` table.

## Signals

Use observable facts, strongest first:

1. **Area touched.** Higher risk: authentication, security, permissions,
   secrets; database schema or migrations; concurrency, locking, or ordering;
   money, deletion, or other irreversible operations; public APIs or file
   formats other code depends on. Lower risk: documentation, comments, copy,
   a contained single-file edit.
2. **Mechanical checkability.** Passing tests that cover the changed behavior
   lower the need for a stronger tier. Skipped, missing, or unrelated tests, a
   behavior-preserving refactor, or subtle implicit behavior raise it.
3. **Reach.** Number of files, modules, or layers involved, and whether the work
   adds new abstractions or only edits existing logic.
4. **Reported uncertainty.** Scout uncertainty, Executor assumptions,
   workarounds, deviations from the Implementation Map, or any reported
   problem.
5. **Task metadata.** A `fix:` for crashes, data loss, or security; a priority
   the user set explicitly (not the default a `fix:` prefix infers); many
   dependent tasks.
6. **Fit.** Files changed beyond the Implementation Map, or requirements with no
   matching change.

## Before dispatch: Scout and Executor

Baselines are Strong for the Scout and Fast for the Executor.

- Decide the Scout tier from the task alone. Decide the Executor tier after the
  Scout returns, using the Implementation Map's file list and flagged risks.
  Before dispatch, use only signals already known; passing tests exist only
  after execution, so they count at the completion menu, not here.
- If no signal points higher, use the baseline without asking.
- If signals show the task is materially harder, ask one question before that
  dispatch, marking the recommended option:

  ```text
  Scout tier for #NNN:
  a) Strong — default
  b) Top (Recommended) — {one-line reason from the signals}
  ```

  ```text
  Executor tier for #NNN:
  a) Fast — default
  b) Strong (Recommended) — {one-line reason from the signals}
  ```

  Mark whichever option you recommend. Wait for the user's answer before
  dispatching.
- Skip the question when the user named a model for that role (dispatch with the
  named model, per `SKILL.md`) or chose Auto-Run All (dispatch at the baseline).
  Auto-Run All skips only this pre-dispatch question; the completion menu is
  still shown for every task.

## Completion menu recommendation

Mark exactly one of the four options by appending ` (Recommended)` to its
label, before the description, as in the questions above
(`b) Validate with Strong tier (Recommended) — run a read-only verifier`):

| Choose | When |
|---|---|
| Accept | A tiny, low-risk change with passing tests, or a documentation or comment-only change where no tests apply. Never when tests failed or were skipped, or a problem was reported. |
| Validate with Strong tier | A multi-file or moderate change in an ordinary area with passing tests. This is also the tie-break when Accept and Strong both fit. |
| Validate with Top tier | Any high-risk area, skipped or missing tests for non-trivial behavior, reported uncertainty, or a broad refactor. Prefer Top when a high-risk signal and an ordinary signal both apply. |
| Reject / Cancel | The worker failed, timed out, or produced no usable change. |

The recommendation never replaces the user's explicit choice. Recompute it
each time the menu is shown again.
