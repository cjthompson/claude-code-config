---
description: Show one plan's record and its tasks
---

Parse `$ARGUMENTS` as a plan seq (`PNNN` or bare `N`).

If this invocation has not already completed `commands/init.md`, run it now to
resolve `$TASK_DB` and `$PROJECT`. Otherwise, reuse those resolved values. Then
run both:

```bash
$TASK_DB plan get --project "<current project>" --seq <seq>
$TASK_DB plan tasks --project "<current project>" --seq <seq>
```

Print the plan's own record, then its task list. (This is deliberately the
raw record + task rows, not the skill's "show plan PNNN" annotated view.)
