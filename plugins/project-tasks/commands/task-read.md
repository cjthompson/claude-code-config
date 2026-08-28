---
description: Show one task's full record
---

Parse `$ARGUMENTS` as a task seq (`#NNN` or bare `N`).

Run the project-tasks skill's host-compatibility setup block to resolve
`$TASK_DB`, then:

```bash
$TASK_DB task get --project "<current project>" --seq <seq>
```

Print the full record.
