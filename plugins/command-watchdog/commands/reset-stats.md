---
description: Back up command-watchdog stats, then clear them
---

Before running anything, ask the user to confirm with AskUserQuestion. Explain that the current stats are copied to a timestamped backup and then cleared, and that collection stays on.

Only if the user confirms, run `"${CLAUDE_PLUGIN_ROOT}/bin/command-watchdog-stats" reset-stats --yes` with Bash and report the backup path.
