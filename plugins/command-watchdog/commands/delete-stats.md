---
description: Delete all command-watchdog stats and backups; turns collection off
---

Before running anything, ask the user to confirm with AskUserQuestion. Explain that this deletes the stats database and every backup, that collection turns off, and that the rule file is kept.

Only if the user confirms, run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" delete-stats --all --yes` with Bash and report the removed count.
