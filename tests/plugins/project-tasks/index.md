# project-tasks Tests

Tests for the `project-tasks` plugin and its `task-db` helper.

## Overview

The automated task-db coverage is organized as six Node test suites. See the
[task-db test index](../../packages/task-db/index.md) for module ownership,
parser groups, and per-suite coverage. Historical output is recorded in
[test-results.md](../../packages/task-db/test-results.md).

Prerequisites are Node with `--experimental-strip-types` support and the
`sqlite3` package. Each integration test uses its own temporary
`PROJECT_TASKS_HOME`, so suites do not share a database.

## Test Files

Located at `plugins/project-tasks/`:

| File | Purpose |
|------|---------|
| `task-db.test.mts` | Platform-native storage, normalization, registry/parser behavior, and hard-cutover call-site lint |
| `task-db.integration.test.mts` | CLI dispatch, migrations, schema/FKs, handlers, transactions, and concurrency |
| `task-db.plan-read.test.mts` | Plan tasks, status, and progress |
| `task-db.plan-sync.test.mts` | Plan reconciliation and lifecycle mutations |
| `task-db.gfm.test.mts` | GFM writer (`lib/gfm.mjs`): table/cell/heading/paragraph/blockquote output and GFM validity |
| `task-db.format.test.mts` | Result model and formatter (`lib/format.mjs`): parts, json/pipe/md output, pipe escaping round-trip, warnings |

The canonical six-suite run is below. Run `npm install` first:
`task-db.gfm.test.mts` and `task-db.integration.test.mts` import the `micromark` devDependencies.

```bash
node --experimental-strip-types --test plugins/project-tasks/task-db.test.mts plugins/project-tasks/task-db.integration.test.mts plugins/project-tasks/task-db.plan-read.test.mts plugins/project-tasks/task-db.plan-sync.test.mts plugins/project-tasks/task-db.gfm.test.mts plugins/project-tasks/task-db.format.test.mts
```

## Release guard

`tests/plugins/project-tasks/structure.test.mjs` is a separate release guard.
It verifies that the Claude manifest, Codex manifest, and Claude marketplace
entry agree on the project-tasks plugin name and version. Run it directly with:

```bash
node --test tests/plugins/project-tasks/structure.test.mjs
```
