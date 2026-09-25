# Watchdog Target Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wait-loop target tracking agree with `pgrep` selection and count real work without mistaking checker processes for targets.

**Architecture:** Retain parsed `pgrep` arguments and ask `/usr/bin/pgrep` for matching PIDs, then exclude other wait-loop checkers by their nearest shell ancestor. Interpret `while` and `until` conditions before declaring a target gone; a failed query supplies no activity signal. Count CPU already accrued by newly observed child processes. A process-tree probe showed Bash already removes redundant shell layers for simple `bash -c` commands, so no command rewrite is needed.

**Tech Stack:** macOS `/usr/bin/python3` (Python 3.9), standard library, `unittest`.

---

### Task 1: Faithful `pgrep` selection

**Files:** `plugins/command-watchdog/hooks/command-watchdog.py`, `plugins/command-watchdog/tests/test_command_watchdog.py`

- [x] Add a regression where a matching process outside `pgrep -P 1` is excluded from the selected PID list.
- [x] Run the focused test and confirm the existing regex-only matching fails it.
- [x] Preserve parsed `pgrep` arguments and use `/usr/bin/pgrep` to select PIDs. Skip unsupported output flags and shell-expanded arguments; treat query failures and PIDs missing from the snapshot as unknown.
- [x] Run focused parsing and process tests.

### Task 2: Distinguish real work from checker processes

**Files:** `plugins/command-watchdog/hooks/command-watchdog.py`, `plugins/command-watchdog/tests/test_command_watchdog.py`

- [x] Add a regression with a live `tail -f` target. Assert it remains in the selected PID list.
- [x] Run the focused test and confirm the global helper-name exclusion fails it.
- [x] Exclude watchdogs, wait-loop shells, and checker descendants of wait-loop shells by process ancestry; do not exclude an unrelated process solely because its executable is named `tail`, `find`, or `rg`.
- [x] Run the focused tests.

### Task 3: Account for rotating child work

**Files:** `plugins/command-watchdog/hooks/command-watchdog.py`, `plugins/command-watchdog/tests/test_command_watchdog.py`

- [x] Add a regression for an existing CPU-flat parent and a newly observed child with accrued CPU.
- [x] Run the focused test and confirm consecutive-PID-only accounting misses it.
- [x] Count CPU on newly observed workers as progress while retaining delta checks for existing PIDs.
- [x] Run focused tests.

### Task 4: Documentation and verification

**Files:** `README.md`, `plugins/command-watchdog/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `CHANGELOG.md`, `package.json`, `package-lock.json`

- [x] Update README with the wait-loop tracking rules. Bump plugin and package patch versions together, and add a dated changelog entry.
- [x] Run `/usr/bin/python3 -B -m unittest discover -s plugins/command-watchdog/tests -v` with process-list access and `npm test` after the final code edit.
- [x] Run `git diff --check`, inspect the complete diff, and commit the cohesive change on the worktree branch.
