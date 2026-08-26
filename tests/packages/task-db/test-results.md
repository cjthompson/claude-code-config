# task-db Test Results

Tracks test execution history for the task-db package.

The canonical four-suite command is:

```bash
node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts plugins/project-tasks/task-db.integration.test.mts plugins/project-tasks/task-db.plan-read.test.mts plugins/project-tasks/task-db.plan-sync.test.mts
```

To capture and regenerate the TAP summary, run the suites into a temporary
file and extract the aggregate lines:

```bash
set -e
capture_file="$(mktemp)"
trap 'rm -f "$capture_file"' EXIT
node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts plugins/project-tasks/task-db.integration.test.mts plugins/project-tasks/task-db.plan-read.test.mts plugins/project-tasks/task-db.plan-sync.test.mts >"$capture_file" 2>&1
awk '/^# (tests|pass|fail) /' "$capture_file"
```

The recorded total is historical output from the documentation-update run, not
a maintained expected-count contract. The test count may change as coverage
changes.

## Execution Log

| Date | Scenario | Status | Notes |
|------|----------|--------|-------|
| 2026-08-16 | Documentation update: canonical four-suite run | PASS | Generated TAP summary recorded from the actual run below. |
| 2026-08-16 | Project-qualified plan-note references: canonical four-suite run | PASS | Qualified task references, legacy read compatibility, and JSON preservation verified. |

Generated summary:

```text
# tests 513
# pass 513
# fail 0
```
