---
description: Suggest per-command watchdog limits from collected stats, then apply a chosen one
---

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" suggest-timeouts` with Bash to list rule sections. If the output is the disabled prompt, stop and ask the user whether to enable collection.
2. Ask which section to review with AskUserQuestion, using the listed sections as options.
3. Run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" suggest-timeouts SECTION` and show its output as printed. It lists tight, medium, and long for idle, max_runtime, and poll_cap. If it prints an `excluded ... run(s) with overrides` line, tell the user which variables excluded those runs; a stale `WATCHDOG_IDLE`, `WATCHDOG_MAX_RUNTIME`, `WATCHDOG_POLL_CAP`, or `WATCHDOG_POLL` set at launch keeps every run out of the suggestions.
4. Ask the user which option to choose for each check with AskUserQuestion. Leave out any check the user does not want to change.
5. Preview by re-running with `--choose`, without `--apply`, and show the result.
6. Ask with AskUserQuestion whether to apply the previewed change; run `--apply` only on a yes. Pass the same `--choose` value, for example `--choose idle=tight,max_runtime=long --apply`. If the preview says `(no change)`, there is nothing to apply.
