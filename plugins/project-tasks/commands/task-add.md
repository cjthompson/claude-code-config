---
description: Log a new task, fix, or todo
---

Treat `$ARGUMENTS` exactly as if the user had typed it after one of the
project-tasks skill's logging prefixes (`task:`, `fix:`, `todo:`, `log task:`,
`log fix:`, `run task:`, `run fix:`).

- If `$ARGUMENTS` already starts with one of those prefixes, use it as given.
- Otherwise default to `task:` (medium priority, asks Run Now / Log Only)
  unless the wording clearly describes a bug (use `fix:`, high priority) or
  the user says to only log it, never run it (use `todo:`).

Follow the project-tasks skill's instructions for that trigger phrase,
including dependency parsing (`depends on #NNN, #NNN`), tag parsing (`#tag`),
and the Run Now / Log Only prompt.
