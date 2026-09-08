---
description: Initialize the project-tasks plugin and load the skill
---

Run the project-tasks skill's Host Compatibility setup block to resolve
`$TASK_DB` and the `PROJECT_TASKS_HOME` / `PROJECT_TASKS_CONFIG_DIR`
variables, then initialize the database:

```bash
$TASK_DB db init
```

Handle the exit codes:
- `0` — database already existed; continue silently.
- `2` — first-time setup; the database was just created. Show the user this
  tip verbatim:

  > **First-time setup tip:** To avoid approval prompts for every task-db
  > command, allow the helper invocation in your host's command allowlist
  > if it supports one. On Claude Code add `"Bash(task-db *)"` to
  > `permissions.allow` in `~/.claude/settings.json`; on hosts that run
  > it via node, allow the equivalent `node <path>/bin/task-db *` form.

- Any other exit code — surface the helper's stderr and stop.

Then use the Skill tool to load the `project-tasks` skill so its full
instructions are in context and the user is ready to issue `task:`,
`fix:`, `todo:`, `plan:`, `list tasks`, etc. on their next message.

Finish with one short sentence confirming the plugin is initialized and
the skill is loaded — no further instructions.
