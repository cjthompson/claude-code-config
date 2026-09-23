# Hand-off: `npm run install-packages` TUI redesign

**Status:** design exploration complete, no code written. Five mockups are
drawn and one is recommended; the next session picks a direction and
implements it.

**Artifact:** `docs/installer-tui-designs.html` — open it in a browser
before reading further. It is standalone (inline CSS, no assets).

> **Before editing that file, read this.** The mockups are
> character-grid-exact: every `<pre>` block is a real terminal grid at a
> declared column width, with colour applied by `<span>` at field
> boundaries. Hand-editing the aligned rows breaks the columns silently —
> it happened on the first attempt at every one of the four grid designs.
> The mockups were ultimately produced by a throwaway generator that padded
> each field to a declared width; that script was in session scratch and is
> gone. If you change a grid, verify it by stripping tags and counting code
> points (not bytes, not `String.length` — `[...line].length`), and confirm
> every body row in a block comes out the same width. The design-1 body rows
> are 79 columns, design 3's are 114.

---

## Why this started

The user's words: *"npm run install-packages uses a simple TUI, but I don't
like the design. The layout is weird."* The ask was five design alternatives
as an HTML page — monospace, near-black background, colour for contrast —
and, first, confirmation of what the TUI is actually for.

An explicit instruction from the session, worth carrying forward:

> Forgot how it's implemented right now. I don't want that to have any
> influence.

So the current implementation is documented below as *diagnosis*, not as a
starting point. Do not treat the existing component structure as a
constraint on the redesign.

---

## Confirmed goals

These four were presented to the user and not disputed. They are the design
brief, and they are reproduced at the top of the HTML page.

1. **Reconcile.** Show what this repo offers against what is on the machine
   — `~/.claude/`, `~/.local/bin`, `settings.json` keys, the plugin cache —
   and whether each is current. Files compare by content hash
   (`lib/hash.ts`); plugins compare by `marketplace.json` version. A symlink
   pointing back into the repo counts as always-current
   (`discover.ts:427` `isSymlinkIntoRepo`).
2. **Select a subset and apply as one batch.** Installs, upgrades and
   removals commit together on a single keypress.
3. **Explain before deciding.** Any row can show its description; some
   packages carry sample output (`manifest.json` `example` field).
4. **Report per-item outcome.** `created` / `updated` / `removed` /
   `already-exists` / `warning` / `error`, streamed as each item finishes
   rather than all at the end.

## The scoring criterion

Everything below is judged on one question:

> **Does the design keep *current state* and *queued action* in separate
> visual channels?**

Collapsing both into one glyph column is the actual defect behind "the
layout is weird." A tick that means "installed", "current" *and* "will
install" teaches the reader nothing.

---

## Diagnosis of the current TUI

Recorded so the redesign does not reintroduce these. Not a to-do list —
several of these disappear by construction under any of the five designs.

| # | Defect | Where |
|---|--------|-------|
| 1 | Seven state branches collapse into three glyphs. `✓` means *will install*, *installed & current*, and *installed*. `·` means *off* and *outdated* — a no-op and a pending upgrade render identically. | `components/ToggleItem.ts:21-47` |
| 2 | `space` is polymorphic: it toggles `enabled` on an uninstalled row but `markedForRemoval` on an installed one, with no cue that the verb changed. | `App.ts:81-84` |
| 3 | The description footer returns `null` when empty, so the list shifts vertically as the cursor moves. This is literally the weird layout. | `components/DetailFooter.ts:9` |
| 4 | Group status is lossy — one marked child labels the whole package `REMOVE`. | `App.ts:160` |
| 5 | Two competing action zones: `↵ Apply changes` sits between the list and the footer, while the keyhints are centred below it. | `App.ts:182-195` |
| 6 | `i` (info) and the results phase each replace the entire render, losing list context. Results end in a dead-end "press q to exit". | `App.ts:134`, `App.ts:137`, `components/ResultsView.ts:35` |
| 7 | Single-item packages render a section header *and* one child row — the two-level hierarchy earns nothing and duplicates the name. | `App.ts:156-174` |
| 8 | For `files` packages the item's display name is a comma-joined file list, not a human-readable name. | `discover.ts:135-146` |
| 9 | 11 plugins are discovered with real `needsUpgrade` state but filtered out of the TUI entirely. | `App.ts:25`, `App.ts:48` |

### A known correctness hole, documented in-tree

`hooks/useInstaller.ts:32-36` calls this out already:

> `toggleItem` sets `markedForRemoval` without clearing `enabled`, so a
> files package whose items differ in install state (files present, settings
> key absent) keeps `enabled` on the settings item and the install pass
> recopies what the removal pass just unlinked.

This is a **partially-installed package** — a state the current UI has no
way to express. Design 5 addresses it directly with per-sub-item checkboxes;
designs 1, 3 and 4 show sub-items but do not give them independent state.
Whichever design wins, the fix belongs in `toggleItem`.

---

## Hard constraints

- **Ink renders inline today.** `packages/installer/src/index.ts:10` is a
  bare `render(h(App, { repoRoot }))`. There is no alternate screen, so
  pinned footers and fixed-height scrolling panes are not available without
  a wrapper. Designs 1 and 3 assume fullscreen and need that wrapper;
  designs 2, 4 and 5 work as-is.
- **Scrollback is a real trade.** Fullscreen wipes the results on quit.
  Inline keeps the plan and every result line in terminal history.
- **Results already stream.** `useInstaller.ts:58,63` call `setResults`
  after each package, so incremental progress is drawable — not a fiction
  in the mockups.
- **Removal is implemented.** `lib/install.ts` exports `removePackage`; the
  destructive path is real, not aspirational.
- **80 columns is the baseline.** Only design 3 needs 120, and it loses the
  column carrying its whole argument below that width.
- **Colour must have an emission path.** Ink and Chalk accept hex and
  256-colour, so the palette is not limited to the eight the installer uses
  now. `packages/claude-optin/claude-optin` already proves the pattern:
  256-colour navy `17` and orange `214`, each with a reverse-video fallback.
  The HTML page has a table mapping every colour to its ANSI/256 equivalent
  and its Ink call.

---

## The fixture

Every mockup uses exactly this data, so the designs are comparable. 15 rows:
11 current, 2 outdated, 2 absent. One current row is queued for removal, so
a full apply is **5 changes — 2 installs, 2 updates, 1 removal — against 10
untouched rows.**

| row | kind | state | why it is in the set |
|-----|------|-------|----------------------|
| `Statusline` | package | current | 2 files plus a `settings.json` sub-item — the only multi-item row, so it stresses grouping |
| `Git Utils` | package | outdated | `repos` hash differs from the repo copy |
| `Skill Testing` | package | absent | never installed |
| `claude-optin` | package | current, queued for removal | the destructive case |
| `project-tasks` | plugin | outdated | 2.1.0 on disk, 2.2.0 in `marketplace.json` |
| `command-watchdog` | plugin | absent | 1.3.0 available |
| `lean-agents` + 8 more | plugin | current | the realistic majority-current tail |

If the counts in the page ever disagree with each other again, they are
wrong — this table is canonical. The generator holds them in one place.

---

## The five designs

Pattern families were chosen by the user from a survey of established TUI
idioms. `claude-optin` (`packages/claude-optin/claude-optin`, curses) was
named as the house-style reference.

### Recommended — 5 · Two-channel list *(inline, 80 cols)*

A checkbox left of the name for **intent**; a plain-English consequence
column right of it for **effect**. Current rows have an empty action column,
so the queue reads as a shape before any word is read. Removal-only confirm
step. The everything-is-current run collapses to about six lines.

Why it wins: the stated goal is a simpler UX, and this is the smallest
vocabulary that still keeps both channels apart — a checkbox and a short
sentence. No glyph legend, no state words to memorise, no colour carrying
meaning on its own. The selection screen's verbs become the results
screen's verbs (`will update` → `updated`).

Its costs: the action column spends ~15 columns that design 4 gives to
version numbers; it must be fixed-width, so a long consequence truncates
rather than wraps; and expanded sub-items break the fixed row rhythm.

### The four alternatives

- **1 · claude-optin house style** *(fullscreen, 80)* — pinned title / stats
  / tab bars, fixed column grid, right-aligned metadata, full-row reverse
  video, navy legend strip. Densest of the five and zero new muscle memory.
  *Deciding con:* the glyph and the state word are redundant with each other
  while the queued action is still only inferred from colour — two channels
  saying one thing, zero saying the other.
- **2 · Plan-then-apply diff** *(inline, 80)* — `+` / `~` / `-` sigils, a
  totals sentence, one confirm; `terraform plan`'s shape. Genuinely strong,
  and the closest runner-up: an unchanged row has *no sigil at all*, so the
  sigil column is purely pending action. *Deciding con:* no alignable
  version columns — `2.1.0 → 2.2.0` is prose in a detail field rather than
  something you can scan down.
- **3 · Transaction list** *(fullscreen, 120)* — `aptitude`'s read-only
  `STATE` column beside a cycled `ACT` column, plus `REPO` / `ON DISK` side
  by side. The only design that spells the queued action as a word in its
  own column. *Deciding con:* needs 120 columns, and `ACTION ON APPLY` is
  the first column to drop below that.
- **4 · Outdated table** *(inline, 80)* — `brew outdated`'s flat grid, one
  checkbox, no symbols, uniform row height. *Deciding con:* the queued
  action is never shown anywhere. Ten checked boxes mean "do nothing" and
  one unchecked box means "delete a file"; they look identical.

---

## Open decisions for the next session

1. **Which design.** The user has seen the page but has not chosen. Do not
   start implementing on the strength of the recommendation alone.
2. **Do plugins belong in the TUI?** Stated to the user as an assumption
   they could kill in one word; no answer yet. They are discovered with real
   version state (`discover.ts:187-278`) but filtered out at `App.ts:25`
   and `App.ts:48`, and installed instead by a separate non-interactive
   script (`install-plugins.ts`, which sets `enabled: true` on all of them
   unconditionally). If they stay out, every design loses 11 rows and
   nothing else changes.
   - Note: the project `CLAUDE.md` rule about not prompting to reinstall
     after plugin-only changes governs the *post-commit prompt*, not whether
     plugins appear in the installer. Those are different questions.
3. **Fullscreen or inline**, if a fullscreen design is chosen — the
   scrollback loss is the real cost, and it hits the results screen hardest.
4. **Default view on a no-op run.** Never answered directly. Designs 2 and
   5 collapse the current tail behind `a`; 1, 3 and 4 always render all 15
   rows. At 15 rows this matters; the user was asked and moved on.
5. **Primary scenario** — re-sync after `git pull` versus fresh-machine
   setup. Also unanswered. The hash/`needsUpgrade` machinery suggests
   re-sync is the real workload, which favours the delta-first layouts.

---

## Implementation notes

### Files a redesign touches

```
packages/installer/src/
  index.ts                     bare render() — the only place a fullscreen wrapper goes
  App.ts                       list building, useInput, phase switching — the bulk of the work
  components/ToggleItem.ts     defect #1 lives here; likely replaced outright
  components/SectionHeader.ts  defect #4; may disappear entirely under designs 2/4/5
  components/DetailFooter.ts   defect #3 — must not return null
  components/InfoOverlay.ts    defect #6 — should not blank the list
  components/ResultsView.ts    defect #6 — needs an `r` re-reconcile exit, not just `q`
  hooks/useInstaller.ts        apply orchestration; the toggleItem hole is described at :32-36
  hooks/usePackageDiscovery.ts unchanged
  lib/discover.ts              unchanged unless plugins become interactive
  lib/types.ts                 PackageItem's flag set may need a real action field
  lib/install.ts               unchanged
  lib/output-style-check.ts    unchanged — emits the advisory warning shown in the mockups
```

Entry points that build descriptors the same way and must keep working:
`reinstall.ts`, `install-package.ts`, `install-plugins.ts`.

### Data model

`lib/types.ts` currently encodes state as four independent booleans on
`PackageItem`: `enabled`, `alreadyInstalled`, `needsUpgrade`, `isCurrent`,
plus `markedForRemoval`. That is the root of defect #1 — there is no single
field naming the *action*. Any of the winning designs wants something closer
to a derived `action: "install" | "upgrade" | "remove" | "none"` computed
from (state, intent), with the booleans reduced to observed state only.

### Tests

No existing test touches the UI. `tests/packages/installer/` covers only
`lib/` behaviour — `plugin-install.test.mjs`, `output-style-check.test.mjs`,
`plugin-manifest.test.mjs`. A UI redesign will not break them, and new
coverage for the action-derivation logic would be new ground.

### Repo conventions that apply

- Per the user's global `CLAUDE.md`: slice into independently-shippable PRs,
  each branch cut from `origin/main` after a `git fetch`, each prefixed
  `ct/`. The default-branch base rule needs written proof to deviate from.
- This repo is under `~/dev`, so it is a personal project: keep the slicing
  discipline but skip `gh pr create` unless asked, and only the local
  `fresheyes` review applies (no CI to watch).
- Per the project `CLAUDE.md`: after any commit or merge on `main`, bump the
  patch version in both `package.json` and `package-lock.json` (two places
  in the lockfile), add a `CHANGELOG.md` entry, and check whether
  `README.md` needs updating.
- Changes under `packages/` are applied by `npm run install-packages`, so
  ask the user whether to re-run it after merging.

---

## What was deliberately not done

- No installer source was edited.
- No branch, commit, or version bump — this is a design artifact.
- No spec or implementation plan beyond this hand-off. Classify the
  implementation separately once a design is chosen; it is likely
  architectural rather than bounded, since it restructures how the
  components fit together.
