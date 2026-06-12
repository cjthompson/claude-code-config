# task-db Tests

Tests for the `task-db` package.

## Overview

No automated tests exist yet. `task-db.mjs` is a CLI wrapper over SQLite used by the
project-tasks skill.

**Source:** `packages/task-db/task-db.mjs`

## Test Files

None yet.

## Suggested Test Approach

Node.js unit tests that spin up a temporary SQLite database and exercise each subcommand:

```typescript
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert';

test('insert and list tasks', () => {
  const result = execFileSync('node', [
    'packages/task-db/task-db.mjs', 'insert',
    '--project', 'test-project',
    '--type', 'task',
    '--title', 'Test task',
    '--priority', 'medium',
  ], { encoding: 'utf8' });
  assert.match(result, /#\d+/);
});
```

Subcommands to cover: `init`, `insert`, `list`, `get`, `update`, `changelog`,
`mark-changelog`, `recent`, `check-deps`, `validate-deps`, `blocked`, `unblocked`.

## How to Add Tests

1. Create `packages/task-db/task-db.test.mts`
2. Use `node:test` and `node:child_process.execFileSync`
3. Run with: `node --experimental-strip-types --test packages/task-db/task-db.test.mts`

**Record results in:** [test-results.md](test-results.md)
