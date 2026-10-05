# task-db Test Results

Tracks test execution history for the task-db package.

The canonical six-suite command is below. Run `npm install` first:
`task-db.gfm.test.mts` and `task-db.integration.test.mts` import the `micromark` devDependencies.

```bash
node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts plugins/project-tasks/task-db.integration.test.mts plugins/project-tasks/task-db.plan-read.test.mts plugins/project-tasks/task-db.plan-sync.test.mts plugins/project-tasks/task-db.gfm.test.mts plugins/project-tasks/task-db.format.test.mts
```

To capture and regenerate the TAP summary, run the suites into a temporary
file and extract the aggregate lines:

```bash
set -e
capture_file="$(mktemp)"
trap 'rm -f "$capture_file"' EXIT
node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts plugins/project-tasks/task-db.integration.test.mts plugins/project-tasks/task-db.plan-read.test.mts plugins/project-tasks/task-db.plan-sync.test.mts plugins/project-tasks/task-db.gfm.test.mts plugins/project-tasks/task-db.format.test.mts >"$capture_file" 2>&1
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
| 2026-10-04 | Step 2 implementation: task deps blocked full rows + format tests | PASS | Added unknown format integration test; all 628 tests passing. |
| 2026-10-04 | Step 2 completion: pipe escaping round-trip tests | PASS | Added 4 pipe escaping round-trip tests (###, ##x, \##, multi-value); all 632 tests passing. |

Generated summary:

```text
# tests 632
# pass 632
# fail 0
```

Per-suite breakdown:
- task-db.test.mts: 292 pass, 0 fail
- task-db.integration.test.mts: 171 pass, 0 fail
- task-db.plan-read.test.mts: 34 pass, 0 fail
- task-db.plan-sync.test.mts: 58 pass, 0 fail
- task-db.gfm.test.mts: 25 pass, 0 fail
- task-db.format.test.mts: 52 pass, 0 fail (added 4 new tests)
