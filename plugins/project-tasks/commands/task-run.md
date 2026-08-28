---
description: Run a specific task by ID, or all pending tasks
---

If `$ARGUMENTS` is `all`, treat this exactly like the user said "run all
tasks". Otherwise treat `$ARGUMENTS` as a task seq and treat this like
"run task #NNN".

Follow the project-tasks skill's Running a Task pipeline (Check Dependencies
→ dispatch subagent). This command always means Run Now — skip the
Run Now / Log Only prompt.
