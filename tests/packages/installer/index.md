# installer Tests

Tests for the `installer` package.

## Overview

No automated tests exist yet. The installer is an interactive TUI built with Ink/React.

**Source:** `packages/installer/src/`

## Test Files

None yet.

## Suggested Test Approach

Because the installer is interactive, testing requires one of:

1. **Extract pure logic** — Move pure functions (package resolution, manifest parsing)
   into a `lib/` module and add Node.js unit tests following the `statusline` pattern

2. **Integration testing via CLI** — Test the non-interactive code path:
   ```bash
   npm run install-package <name>
   ```
   This exits non-zero on failure, making it scriptable

## How to Add Tests

1. Create a `.test.mts` file in `packages/installer/`
2. Use `node:test` and `node:assert`
3. Run with: `node --experimental-strip-types --test packages/installer/<test>.test.mts`

**Record results in:** [test-results.md](test-results.md)
