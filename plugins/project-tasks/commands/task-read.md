---
description: Show one task's full record
---

Parse `$ARGUMENTS` as a task seq (`#NNN` or bare `N`).

If this invocation has not already completed `commands/init.md`, run it now to
resolve `$TASK_DB` and `$PROJECT`. Otherwise, reuse those resolved values. Then:

```bash
$TASK_DB task get --project "<current project>" --seq <seq>
```

Print the full record.
