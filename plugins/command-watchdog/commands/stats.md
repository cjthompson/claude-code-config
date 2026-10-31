---
description: Show command-watchdog kill and success statistics, or offer to enable collection
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" stats` with Bash and show its output as printed.

If the output is `stats disabled. Do you want to enable stats collection?`, ask the user that question with AskUserQuestion. Run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" enable-stats` only if the answer is yes.
