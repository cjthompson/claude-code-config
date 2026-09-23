# Statusline resizing: remove right margin, fix core-block priority, shrink context usage

(Note: written to `docs/plans/` per the user's global CLAUDE.md — direct
writes under `~/.claude/` are blocked by permission settings, and that
same instruction says to prefer the repo's `docs` directory anyway.)

## Context

`packages/statusline/statusline-render.mts` renders the two-line Claude Code
statusline and fits it to the terminal width via `fitSegments`, a
drop-least-important-segment loop keyed on a per-segment `drop: number`
field (higher = dropped first).

Two real defects, not a priority-ordering redesign:

1. **`fitSegments` has no floor.** At a narrow enough width it keeps
   dropping until the array is empty — it will remove branch, then context,
   then even `model`, leaving a blank line. The *relative* order of the
   existing `drop` values is already correct (model=0, context_window=2,
   branch=3, pwd=4 are all below cost=5, duration=6, lines_changed=7,
   time_to_full=9, burn_rate=10 — the four "core" blocks are already
   dropped last as a group). The bug is that the loop doesn't stop before
   touching them. **Do not renumber `drop` values** — that would be
   no-op churn disguised as a fix.
2. **`RIGHT_RESERVE` creates a non-monotonic cliff.** `termWidth` 79 →
   `maxWidth` 79; `termWidth` 80 → `maxWidth` 60 (`statusline-render.mts:445-446`).
   Widening the terminal by one column can suddenly drop more blocks. Claude
   Code no longer renders anything in that right column, so the reserve
   should be deleted outright, not adjusted.

On top of the floor fix, context usage (`SECTION.CONTEXT_WINDOW`) currently
has exactly one rendering form (icon + `%` + 8-cell bar + `(used/total)`
suffix). The user wants it to shrink instead of just surviving-or-vanishing,
mirroring the tiered-string pattern `buildQuotaLine` already uses for line 2.

Decided (confirmed with user):
- Remove `RIGHT_RESERVE` entirely; `maxWidth = termWidth`.
- Core four (model, context_window, branch, pwd) are never dropped by
  `fitSegments`; only the five optional segments (usd_cost, burn_rate,
  time_to_full, lines_changed, duration) are droppable.
- Context usage gets 3 tiers: full → drop the `(used/total)` suffix → drop
  the bar too (icon + `%` only). Applied after `fitSegments` has removed
  everything droppable, not interleaved with it.
- If the core four still don't fit after that (very narrow terminal),
  **accept the overflow** — keep today's fixed-length `shortenBranch`/
  `shortenPath` truncation as-is (no new width-aware squeeze). The line
  may wrap; that's acceptable per the user.

## Changes

All in `packages/statusline/statusline-render.mts`.

### 1. Delete `RIGHT_RESERVE`

Replace (`statusline-render.mts:444-446`):
```ts
  // Claude Code's right column sits inline when wide enough, wraps below when narrow
  const RIGHT_RESERVE = termWidth >= 80 ? 20 : 0;
  const maxWidth = termWidth - RIGHT_RESERVE;
```
with:
```ts
  const maxWidth = termWidth;
```
`isWide`/`barWidth` (next two lines) are unrelated to the reserve — leave them.

### 2. Add a `core` floor to `fitSegments`

Add `core?: boolean` to `PowerlineSeg` (`statusline-render.mts:286-290`).
Mark the four segment pushes for `MODEL`, `CONTEXT_WINDOW`, `BRANCH`, `PWD`
(`statusline-render.mts:460, 487, 517, 521`) with `core: true`. Leave every
other segment's `drop` value untouched.

Rewrite `fitSegments` (`statusline-render.mts:325-337`) to scan only
non-core segments, and **stop** once none remain — do not fall through to
an unguarded `splice(-1, 1)`, which would silently delete the last element
(pwd) instead of stopping:

```ts
function fitSegments(segs: PowerlineSeg[], maxWidth: number): PowerlineSeg[] {
  const active = [...segs];
  while (stripAnsi(renderPowerline(active)).length >= maxWidth) {
    let maxDrop = -1, maxIdx = -1;
    for (let i = 0; i < active.length; i++) {
      if (!active[i].core && active[i].drop > maxDrop) { maxDrop = active[i].drop; maxIdx = i; }
    }
    if (maxIdx === -1) break; // only core segments left — never drop them
    active.splice(maxIdx, 1);
  }
  return active;
}
```

### 3. Tiered context-usage shrink

Replace the single-string `CONTEXT_WINDOW` push (`statusline-render.mts:473-489`)
with a small tier builder, mirroring `buildQuotaLine`'s tier-array pattern
(`statusline-render.mts:380-390`):

```ts
function buildContextTiers(usedPct: number, effectiveWindowSize: number, ctx: Record<string, any>): string[] {
  const displayPct = Math.min(100, Math.max(0, usedPct));
  const rawTokens = totalContextTokens(ctx);
  const totalTokens = rawTokens > 0 ? rawTokens
    : effectiveWindowSize > 0 ? Math.round(usedPct * effectiveWindowSize / 100)
    : 0;
  const bar = `${R_GREEN}${progressBar(usedPct, BG_GREEN, 8)}`;
  const tokens = effectiveWindowSize > 0
    ? ` ${GREEN_DIM}(${formatTokenCount(totalTokens)}/${formatTokenCount(effectiveWindowSize)})${R_GREEN}`
    : '';
  const head = ` ${WHITE}${circleIcon(usedPct)} ${displayPct}${PCT} `;
  return [
    `${head}${bar}${tokens} `,   // full
    `${head}${bar} `,            // drop token-count suffix
    `${head}`,                   // drop bar too — icon + % only
  ];
}
```

Push the full tier as today (`core: true`), keep a reference to the tiers
array and the pushed segment object. After `fitSegments` runs
(`statusline-render.mts:524`), if a context segment exists, step down its
tiers while the rendered line is still `>= maxWidth`:

```ts
const fitted = fitSegments(line1Segs, maxWidth);
if (contextSeg && contextTiers) {
  let tier = 0;
  while (tier < contextTiers.length - 1 && stripAnsi(renderPowerline(fitted)).length >= maxWidth) {
    tier++;
    contextSeg.content = contextTiers[tier];
  }
}
const line1 = renderPowerline(fitted);
```
(`contextSeg` is the same object reference inside `fitted`/`line1Segs`, so
mutating `.content` is visible without re-splicing the array.)

### 4. Export `fitSegments` usage in tests / README

- `fitSegments` is already exported (`statusline-render.mts:355`) but never
  imported by the test file. Add it to the import list
  (`statusline-render.test.mts:10-24`) alongside `shortenBranch` (also
  exported but unused) so the new unit tests below can use them.
- `README.md`'s "Terminal Width Detection" section currently claims a
  stale 2-character right reserve — update it to state there is no right
  margin anymore, and document the core-four-never-dropped /
  context-usage-shrinks behavior in the drop-priority table.

## Verification

1. **Unit tests for `fitSegments`** (new, in `statusline-render.test.mts`):
   construct synthetic `PowerlineSeg[]` with a mix of `core: true` and
   `drop` values, call `fitSegments` directly at a `maxWidth` too small for
   everything to fit, and assert:
   - all `core: true` segments survive even when `maxWidth` is smaller than
     their combined width (the floor holds — this is the regression test
     for the "drops down to empty" bug).
   - non-core segments are removed in descending `drop` order.
2. **Monotonicity check** (new): run `main()`/the CLI end-to-end (via the
   existing `run(...)` test helper pattern, e.g. around
   `statusline-render.test.mts:433-476`) at increasing `termWidth` values
   (e.g. 40, 60, 80, 100, 120) with a fixed session fixture that has all
   segments populated, and assert that the set of segments present at
   width *n* is a superset of the set present at width *n-1* — i.e.
   widening the terminal never removes a block. This is the direct
   regression test for the `RIGHT_RESERVE` cliff.
3. **Context-tier end-to-end test** (new): run with a narrow `termWidth`
   (e.g. 50) and a session that would normally render the full context
   segment, assert the output contains the shrunk form (icon+`%`, no
   `(used/total)` and/or no bar) rather than the segment being absent.
4. **Existing suite**: run
   `node --experimental-strip-types --test packages/statusline/statusline-render.test.mts`
   and confirm all existing tests still pass unmodified (none of them
   exercise narrow widths today, so none should change behavior).
5. Manually eyeball `statusline.sh` output in a resized terminal pane to
   confirm no right-side gap and that shrinking (not vanishing) is visible
   on the context block as the pane narrows.

## Process notes

This is a personal repo under `~/dev` — per user's global instructions, cut
a branch (`ct/...`) for this work but no PR is required; skip Fresh Eyes'
post-PR watch step (local `fresheyes` pre-push review still applies if/when
pushed). Per this repo's own `CLAUDE.md`, the post-commit steps (bump
`package.json`/`package-lock.json` patch version, update `CHANGELOG.md`,
check `README.md`) apply after a commit lands on `main` — this work should
land on a branch first per the user's PR Cadence rule, so those steps apply
once/if it's merged to `main`.

**Plan-mode handoff:** the `main` agent profile has no `ExitPlanMode` tool,
and per `docs/plans/lean-agents-exitplanmode.md` (this repo's own prior
decision) that tool cannot be delegated to a sub-agent — Claude Code hard-
blocks `ExitPlanMode` inside any subagent. So instead of escalating, this
plan is being handed back to the user directly: exit plan mode yourself and
say so explicitly when ready to proceed with implementation.
