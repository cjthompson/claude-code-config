# Add a "time" segment to the statusline

## Context

The user wants to glance at the statusline and know when the last command ran. Claude Code only re-invokes the statusline renderer when there's activity (it's spawned fresh per render, not on a timer), so there's no need to track/cache a timestamp — the renderer can simply read the system clock (`new Date()`) at render time and the displayed value will naturally reflect "now" (i.e. the moment of the most recent render).

This adds a new **protected, tiered** segment (like `model`/`context_window`/`branch`/`pwd`) to `packages/statusline/statusline-render.mts`, following the exact pattern those four already use: a `buildXTiers()` function producing an ordered `string[]` (fullest → narrowest), a segment pushed into `line1Segs`, and a `stepTiers()` call that shrinks it under width pressure. It deviates from that pattern in one way — its narrowest tier is `''` (empty), so under extreme width pressure it can disappear entirely, unlike model/context/branch/path which never fully vanish.

**Confirmed with the user:**
- Format ladder (4 tiers, each one used only if the previous doesn't fit):
  1. `M/D h:mm AM/PM` — e.g. `8/12 3:45 PM` (month/day not zero-padded, hour not zero-padded, minutes zero-padded)
  2. `h:mm AM/PM` — e.g. `3:45 PM` (drop the date)
  3. `HH:mm` (24-hour, zero-padded) — e.g. `15:45` (drop AM/PM, switch to 24h)
  4. `''` — empty (segment disappears entirely)
- Position: **furthest left** in line 1 (pushed before the `model` segment) — a new powerline color group, distinct from the existing green(22)/blue(24)/gray(237) groups.
- Shrink priority: **protected**, and high in the shrink-order cascade (shrinks late, i.e. close to last) — but not the single most-protected item. Working directory (`pwd`) stays the most-protected segment (shrinks last, per existing design intent — "always show the full path if nothing else can be sacrificed"). Time slots in just before `pwd` in the shrink cascade, after `model`/`context`/`branch` have already exhausted their own tiers.
- No icon — plain text only, matching how reset times are already rendered on line 2 (e.g. `2:00PM`, no icon).

## Implementation

All changes are in **`packages/statusline/statusline-render.mts`**.

### 1. New color group

Add a fourth powerline color group (purple), alongside the existing green/blue/gray ones near the top of the file (~line 22-41):

```ts
const BG_TIME = bg(53);     // dark purple
const TIME_FG = fg(183);    // light lavender text
const R_TIME  = RST + BG_TIME;
```

Register it in `SECTION_STYLES` (~line 305-309) with its own separator shade:

```ts
53: { bg: BG_TIME, sep: 97 },
```

### 2. New section name

Add to the `SECTION` const (~line 87-98) and its comment block:

```ts
TIME: 'time',
```

This makes it config-gated via the existing `isSectionEnabled(config, SECTION.TIME)` mechanism — like every other section, it's on by default when no `statusline-config.json`/`sections` array exists, and can be added/omitted from an explicit `sections` allowlist.

### 3. `buildTimeTiers()` — new function

Add near the other tier builders (~after `buildModelTiers`, before "Path tiers"), following the same shape as `buildModelTiers`/`buildBranchTiers`:

```ts
// ── Time tiers ───────────────────────────────────────────────
// Time is protected but not permanently — unlike model/context/branch/path,
// its narrowest tier is empty, so under enough width pressure it disappears
// entirely rather than staying visible in some minimal form. It's read live
// from the system clock at render time (the renderer is spawned fresh per
// render, so no caching/tracking is needed to keep it current).
function buildTimeTiers(d: Date): string[] {
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const h24 = d.getHours();
  const h12 = h24 % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const hh24 = String(h24).padStart(2, '0');
  return [
    ` ${TIME_FG}${BOLD}${month}/${day} ${h12}:${mm} ${ampm}${R_TIME} `,
    ` ${TIME_FG}${BOLD}${h12}:${mm} ${ampm}${R_TIME} `,
    ` ${TIME_FG}${BOLD}${hh24}:${mm}${R_TIME} `,
    '',
  ];
}

export { buildTimeTiers };
```

### 4. Register the segment in `main()`

Push it **first** (leftmost) in the `line1Segs` build-up (~line 560, before the existing `modelSeg` block):

```ts
let timeSeg: PowerlineSeg | undefined;
let timeTiers: string[] | undefined;
if (isSectionEnabled(config, SECTION.TIME)) {
  timeTiers = buildTimeTiers(new Date());
  timeSeg = { section: 53, priority: PROTECTED_PRIORITY, content: timeTiers[0] };
  line1Segs.push(timeSeg);
}
```

### 5. Shrink order + empty-segment filtering

In the `stepTiers` cascade (~line 644-647), insert `time` between `branch` and `path` — path stays last (most protected):

```ts
stepTiers(modelSeg, modelTiers);
stepTiers(contextSeg, contextTiers);
stepTiers(branchSeg, branchTiers);
stepTiers(timeSeg, timeTiers);
stepTiers(pathSeg, pathTiers);
```

Then, since `stepTiers` can leave `timeSeg.content` as `''` (its last tier), filter it out before final render instead of rendering an empty group (~line 648):

```ts
const line1 = renderPowerline(fitted.filter(seg => stripAnsi(seg.content).length > 0));
```

(`fitted` still holds the same segment object references `stepTiers` mutated, so this only ever drops the time segment — every other segment always has non-empty content.)

## Documentation updates

**`packages/statusline/README.md`**:
- Update the example output block (top of file) to include the new leading time segment, e.g. `8/12 3:45 PM │ Opus 4.6 │ ...`.
- Add a `time` row to the "Controlling Which Sections Appear" table (`| time | Current time (e.g. 3:45 PM, shrinks to date+time / time-only / 24h / hidden) |`).
- Add a `time` row to the "Line 1 — Session + Environment" segment table, priority column: `protected — shrinks then disappears (see below)`.
- Extend the numbered shrink-order list (currently model → context → branch → path) to insert time as step 4 (between branch and path), describing its 3-step ladder + final disappearance, and renumber path to step 5.

**Repo root `README.md`**: update the short statusline example block (~line 118) the same way, prefixing the sample output with the time segment.

## Tests

Add to **`tests/packages/statusline/statusline-render.test.mts`**:
- Unit tests for `buildTimeTiers()` (mirroring the existing `describe('formatLocalTime', ...)` / context-tier tests): verify tier 0 matches `M/D h:mm AM/PM` shape, tier 1 drops the date, tier 2 is 24h zero-padded with no AM/PM, tier 3 is `''`.
- An e2e width-sweep assertion (mirroring the existing shrink-order/monotonicity tests) confirming: time is present at wide widths, shrinks through its tiers before `pwd` starts truncating, and — at very narrow widths where it's dropped — the line still renders cleanly (no stray empty powerline segment/separator).

## Files touched

- `packages/statusline/statusline-render.mts` — new color group, `SECTION.TIME`, `buildTimeTiers()`, segment registration, shrink-order insertion, empty-segment filtering.
- `packages/statusline/README.md` — example output, section table, segment table, shrink-order list.
- `README.md` (repo root) — example output block.
- `tests/packages/statusline/statusline-render.test.mts` — unit tests for `buildTimeTiers()`, e2e width-sweep assertions.
- Per repo `CLAUDE.md`: after committing, bump `package.json`/`package-lock.json` patch version and add a `CHANGELOG.md` entry.

## Verification

1. Run the existing + new unit tests:
   ```
   node --experimental-strip-types --test tests/packages/statusline/statusline-render.test.mts
   ```
2. Manually eyeball shrink behavior across widths with the existing dev tool:
   ```
   node --experimental-strip-types tests/packages/statusline/statusline-resize-sweep.mts --summary
   ```
   Confirm the time segment appears leftmost, steps through its 4 tiers as width shrinks, and disappears cleanly (no dangling separator) at the narrowest widths.
3. Spot-check live by running `packages/statusline/statusline.sh` directly (or observing the real statusline in a Claude Code session) to confirm the purple time segment renders correctly and updates on each render.
