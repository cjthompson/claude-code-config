# Codex Command Watchdog Implementation Plan

> Execute inline using the executing-plans skill. The user approved sharing the existing plugin and watchdog engine across Claude Code and Codex.

**Goal:** Package the existing watchdog for Codex, preserve mandatory lowest CPU priority, and verify command lifecycle behavior.

**Architecture:** Add a Codex compatibility manifest referencing the existing Bash hook and register the same plugin directory in both marketplaces. Codex supplies the Claude-compatible plugin environment and canonical Bash input, so no separate execution engine is needed.

**Tech stack:** Python 3.9 standard library, JSON plugin manifests, Node test runner, Codex CLI 0.159.3.

## Tasks

- [x] Add a manifest/catalog regression test in `tests/plugins/command-watchdog/structure.test.mjs`; run `node --test tests/plugins/command-watchdog/structure.test.mjs` and observe missing Codex metadata.
- [x] Add `.codex-plugin/plugin.json` with `hooks: "./hooks/hooks.json"` and register `command-watchdog` in `.agents/plugins/marketplace.json`. Keep all host metadata at the user-requested unreleased version 2.0.0.
- [x] Add `plugins/command-watchdog/tests/test_hook.py` covering Claude and Codex payloads, quoting and plugin paths with spaces, inherited environment/stdin, output streaming, exit status, lowest priority, and cancellation of the task tree. Run it with `/usr/bin/python3 -B -m unittest discover -s plugins/command-watchdog/tests -p test_hook.py -v` before fixing discovered lifecycle gaps.
- [x] Keep one shared hook and runner; fix cancellation cleanup if the runtime tests expose orphaned children.
- [x] Use the installed Codex app-server's `plugin/read` API to validate the marketplace package without installing into the user's configuration. Test a rewritten command with `codex sandbox -c 'sandbox_mode="workspace-write"'` and record the macOS priority restriction.
- [x] Document Codex installation, `/hooks` trust, supported tool coverage, and the requirement for an approved execution context when the sandbox denies priority changes. Do not disable sandboxing or change installed user configuration.
- [x] Run focused tests, full watchdog tests, npm tests, and `git diff --check`; distinguish broader suite failures from acceptance checks.

Delivery: commit, run independent Fresh Eyes review, and update the existing priority branch and PR as the user requested. A first review identified interactive-session documentation and coverage gaps; those were addressed before the next review.

## Verification decisions

The macOS workspace sandbox allows reading niceness but denies setting it. A wrapped command must return 125 without running its task in that context; automatic fallback to normal priority is forbidden. Codex packaging support does not grant additional process permissions.

Task #008 (`WATCHDOG_TIMEOUT`) stays pending and is outside this change.

## Results before review

- Codex `plugin/read` recognized version 2.0.0 and the shared PreToolUse hook without installation.
- The original seven acceptance checks passed. Review added PTY coverage and a launch-time cancellation regression; final results are recorded below.
- A real Codex workspace-sandbox invocation returned 125 without executing its task when priority setup was denied.
- Type checking passed. The full watchdog run passed 49/50; its legacy log-writing wait-loop case passed when isolated on both branches.
- The npm run passed 95/97; the unchanged TypeScript LSP exit test also failed on the parent branch, while its recovery test passed there in isolation. Neither full suite is claimed green.
- No installed plugin or user configuration was changed.

## Final verification after review fixes

- All 53 watchdog tests passed, including the three new PTY and launch-cancellation cases. Both packaging tests and type checking passed.
- Cancellation during `Popen` previously left the task alive in the new regression test; queueing signals until launch completes made it pass. Cancellation now forwards the original signal, protects cleanup from repeated interrupts, and restores the inherited child signal mask.
- The final runner still returned 125 without task execution in Codex's macOS workspace sandbox. The plugin metadata and README describe sandbox and interactive-session restrictions before installation.
- The prior npm run remains 95/97 with two unchanged TypeScript LSP failures; no TypeScript runtime files changed.

## Controlling-terminal review follow-up

A second review found that the original PTY harness had no controlling terminal. The corrected harness acquires one with TIOCSCTTY and establishes its foreground group. Tests now verify that the task runs in a background group, terminal reads receive SIGTTIN, and stopped reads remain subject to the idle timeout. README and Codex metadata explicitly mark interactive sessions unsupported. The launch diagnostic now points sandbox-denied setup to the normal approval flow.

All 14 focused Python checks and both packaging checks passed after this follow-up.
