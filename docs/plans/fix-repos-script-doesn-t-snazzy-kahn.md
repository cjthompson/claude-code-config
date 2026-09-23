# Fix: `repos` script doesn't exit on Ctrl-C (SIGINT) / SIGTERM

## Context

The `repos` script (`packages/git-utils/repos`) is a long-running bash tool that scans
git repos, backgrounds `git fetch`/`gh pr list` calls per repo, and later `wait`s on
them before rendering a report and (optionally) offering interactive pull/push actions.

A prior fix (commit `f8103b2`) added a single combined trap to clean up background
jobs on exit/interrupt:

```bash
trap 'rm -rf "$WORK_DIR"; kill -- -$$ 2>/dev/null' EXIT INT TERM
```

This trap fires correctly on `INT`/`TERM`, but it never calls `exit`. In bash, a trap
handler for `INT`/`TERM` that returns without exiting causes execution to **resume**
at the point it was interrupted. Concretely: if Ctrl-C is pressed while the script is
blocked in the Phase 3 `wait` for backgrounded network calls, `kill -- -$$` terminates
those backgrounded jobs, `wait` then returns (its children just died), and the script
carries on into Phase 2/3/4/5 instead of terminating — this is the reported "doesn't
exit when Ctrl-C is pressed" behavior. The user has to press Ctrl-C repeatedly (or send
SIGTERM again) to actually kill it, and even then it may just keep resuming.

Goal: pressing Ctrl-C (or receiving SIGTERM) during any phase should clean up
background jobs/temp dir and terminate the script immediately, with a conventional
exit code (130 for SIGINT, 143 for SIGTERM).

## Fix

In `packages/git-utils/repos`, replace the single combined trap (around line 170) with
a cleanup function plus explicit signal-specific traps that exit after cleanup:

```bash
cleanup() {
  rm -rf "$WORK_DIR"
  kill -- -$$ 2>/dev/null
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 130' INT
trap 'cleanup; trap - EXIT; exit 143' TERM
```

- `trap - EXIT` is set just before the explicit `exit` call so the `EXIT` trap doesn't
  redundantly re-run `cleanup` a second time (harmless either way since `rm -rf` and
  `kill` on an already-cleaned-up state are no-ops, but this keeps behavior explicit).
- 130 and 143 are the conventional POSIX exit codes for SIGINT (128+2) and SIGTERM
  (128+15), matching what shells normally report for signal-terminated processes.
- This preserves the existing `kill -- -$$` behavior (still needed to terminate any
  still-running backgrounded `git fetch`/`gh pr list` jobs across all phases), it just
  ensures the *script itself* also terminates instead of resuming.

No other files need changes — this is a self-contained, single-file bash fix with no
callers to update (`repos` is installed as a standalone executable per
`packages/git-utils/manifest.json`).

## Verification

1. Run `bash -n packages/git-utils/repos` to confirm the script still parses cleanly.
2. Manually run `repos` (or `bash packages/git-utils/repos ~/workspace`) against a
   directory with a few git repos, and press Ctrl-C while it's in:
   - Phase 1 (progress bar showing fetch progress)
   - Phase 3 (the `wait` for background jobs)
   - Phase 5 (interactive pull/push prompt, if reached)
   In each case, confirm the script exits immediately (prompt returns) rather than
   continuing to print further phase output.
3. Run `echo $?` after each Ctrl-C test and confirm exit code `130`.
4. Send `SIGTERM` via `kill -TERM <pid>` from another terminal while `repos` is running
   and confirm the same immediate-exit behavior with exit code `143`.
5. Confirm no orphaned `git`/`gh` processes remain after interrupting (`ps aux | grep
   -E 'git fetch|gh pr list'` should show nothing lingering).
