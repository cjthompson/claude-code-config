---
description: Show one plan's record and its tasks
---

Parse `$ARGUMENTS` as a plan seq (`PNNN` or bare `N`).

Run the project-tasks skill's host-compatibility setup block to resolve
`$TASK_DB`, then both:

```bash
$TASK_DB plan get --project "<current project>" --seq <seq>
$TASK_DB plan tasks --project "<current project>" --seq <seq>
```

Print the plan's own record, then its task list. (This is deliberately the
raw record + task rows, not the skill's "show plan PNNN" annotated view.)
