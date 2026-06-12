# statusline Tests

Tests for the `statusline` package.

## Overview

The statusline package has automated unit tests covering its TypeScript renderer functions
and shell integration.

**Test file:** `packages/statusline/statusline-render.test.mts`
**Framework:** Node.js `node:test` with `node:assert`

## How to Run

From the repo root:

```bash
node --experimental-strip-types --test packages/statusline/statusline-render.test.mts
```

Requires Node.js 22+ for `--experimental-strip-types`.

## Test Coverage

| Function / Suite | What It Validates |
|------------------|-------------------|
| `resolveContextWindowSize` | Maps model names to context window sizes |
| `isSectionEnabled` | Checks section visibility from environment config |
| `stripAnsi` | Removes ANSI escape codes from strings |
| `formatDuration` | Formats millisecond durations into human-readable strings |
| `formatLocalTime` | Formats timestamps as local time strings |
| `formatTokenCount` | Formats token counts with K/M suffixes |
| `shortenPath` | Abbreviates home directory and long paths |
| `progressBar` | Renders ASCII progress bars |
| `plTransition` / `plEnd` | Powerline segment transitions |
| `joinSep` | Joins segments with separator characters |
| `computeUsedPct` | Computes percentage of context window used |
| Shell integration | Renders line1/line2 output via `statusline.sh` |

## Adding Tests

Add new `describe`/`it` blocks to `packages/statusline/statusline-render.test.mts`:

```typescript
describe('myFunction', () => {
  it('handles edge case X', () => {
    assert.strictEqual(myFunction(input), expected);
  });
});
```

**Record results in:** [test-results.md](test-results.md)
