---
description: Update a task's status, priority, or other fields
---

`$ARGUMENTS` is a task reference plus the change to make, e.g. `#012 status=completed`,
`#012 cancel`, `#012 priority high`. The task seq (`#NNN`) is the leading token.

Follow the project-tasks skill's instructions for the matching request —
"complete task #NNN", "cancel task #NNN", "set priority of #NNN to <level>",
or a general field update via `task update` — based on what the rest of
`$ARGUMENTS` asks for.
