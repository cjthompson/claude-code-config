# statusline Tests

Tests for the `statusline` package.

## Overview

The statusline package has automated unit tests covering its TypeScript renderer functions
and shell integration. Test source lives here, in `tests/packages/statusline/`, rather than
in `packages/statusline/` itself, so it can never end up in the installed package.

**Test file:** `tests/packages/statusline/statusline-render.test.mts` (imports the renderer
from `../../../packages/statusline/statusline-render.mts`)
**Framework:** Node.js `node:test` with `node:assert`

## How to Run

From the repo root:

```bash
node --experimental-strip-types --test tests/packages/statusline/statusline-render.test.mts
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
| `fitSegments` | Priority-based drop/keep decisions, including the `PROTECTED_PRIORITY` floor |
| `buildContextTiers` | Context-usage shrink ladder (full → drop token count → icon+% only) |
| `buildBranchTiers` | Branch-name shrink ladder (25 → 18 → 12 chars) |
| Shell integration | Renders line1/line2 output via `statusline.sh`, including width monotonicity and shrink-order (context before branch) regression tests |

## Manual Resize Testing

`statusline-resize-sweep.mts` (same directory) renders the statusline at every width across a
range with one fixed payload, for eyeballing drop/shrink behavior interactively — not part of
this automated suite. See `packages/statusline/README.md`'s "Manual Resize Testing" section.

## Adding Tests

Add new `describe`/`it` blocks to `statusline-render.test.mts`:

```typescript
describe('myFunction', () => {
  it('handles edge case X', () => {
    assert.strictEqual(myFunction(input), expected);
  });
});
```

**Record results in:** [test-results.md](test-results.md)
