# Codex Command Watchdog Implementation Plan

> Execute inline using the executing-plans skill. The user approved sharing the existing plugin and watchdog engine across Claude Code and Codex.

**Goal:** Package the existing watchdog for Codex, preserve mandatory lowest CPU priority, and verify command lifecycle behavior.

**Architecture:** Add a Codex compatibility manifest referencing the existing Bash hook and register the same plugin directory in both marketplaces. Codex supplies the Claude-compatible plugin environment and canonical Bash input, so no separate execution engine is needed.

**Tech stack:** Python 3.9 standard library, JSON plugin manifests, Node test runner, Codex CLI 0.159.3.

## Tasks

- [ ] Add a manifest/catalog regression test in `tests/plugins/command-watchdog/structure.test.mjs`; run `node --test tests/plugins/command-watchdog/structure.test.mjs` and observe missing Codex metadata.
- [ ] Add `.codex-plugin/plugin.json` with `hooks: "./hooks/hooks.json"` and register `command-watchdog` in `.agents/plugins/marketplace.json`. Keep all host metadata at the user-requested unreleased version 2.0.0.
- [ ] Add `plugins/command-watchdog/tests/test_hook.py` covering Claude and Codex payloads, quoting and plugin paths with spaces, inherited environment/stdin, output streaming, exit status, lowest priority, and cancellation of the task tree. Run it with `/usr/bin/python3 -B -m unittest discover -s plugins/command-watchdog/tests -p test_hook.py -v` before fixing discovered lifecycle gaps.
- [ ] Keep one shared hook and runner; fix cancellation cleanup if the runtime tests expose orphaned children.
- [ ] Use the installed Codex app-server's `plugin/read` API to validate the marketplace package without installing into the user's configuration. Test a rewritten command with `codex sandbox -c 'sandbox_mode="workspace-write"'` and record the macOS priority restriction.
- [ ] Document Codex installation, `/hooks` trust, supported tool coverage, and the requirement for an approved execution context when the sandbox denies priority changes. Do not disable sandboxing or change installed user configuration.
- [ ] Run focused tests, full watchdog tests, npm tests, and `git diff --check`; distinguish inherited timing failures from acceptance checks. Commit, run independent Fresh Eyes review, and update the existing priority branch and PR as the user requested.

## Verification decisions

The macOS workspace sandbox allows reading niceness but denies setting it. A wrapped command must return 125 without running its task in that context; automatic fallback to normal priority is forbidden. Codex packaging support does not grant additional process permissions.

Task #008 (`WATCHDOG_TIMEOUT`) stays pending and is outside this change.

## Results before review

- Codex `plugin/read` recognized version 2.0.0 and the shared PreToolUse hook without installation.
- All seven new acceptance checks passed: two packaging tests and five runtime tests (including all three cancellation signals).
- A real Codex workspace-sandbox invocation returned 125 without executing its task when priority setup was denied.
- Type checking passed. The full watchdog run passed 49/50; its legacy log-writing wait-loop case passed when isolated on both branches.
- The npm run passed 95/97; the unchanged TypeScript LSP exit test also failed on the parent branch, while its recovery test passed there in isolation. Neither full suite is claimed green.
- No installed plugin or user configuration was changed.
