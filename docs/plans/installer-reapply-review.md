# Review: are the modified `packages/installer` files a complete feature?

> Plan-file note: the harness designated `~/.claude/plans/…` for this file, but
> this repo's `CLAUDE.md` puts `~/.claude` off-limits and the global rule prefers
> the repo `docs/` dir for plan/spec files. Written here instead.

## Context

Branch `ct/installer-tweaks` carries 5 uncommitted files under
`packages/installer` (+72/−17). `src/lib/hash.ts` is staged; the other four are
unstaged. The question is a **review** question: does this diff constitute a
complete, shippable feature?

### What the diff actually does

One coherent feature: **Enter always applies.** It reframes the TUI's Enter key
from "install what you selected" to "apply changes / re-apply what's installed."

1. **`App.ts`** — splits the old `hasSelections` flag into `hasInstalls` /
   `hasRemovals`, drops the `hasSelections` guard on Enter so Enter is always
   live, and picks one of four labels (`Apply changes` / `Apply removals` /
   `Install selected` / `Re-apply / confirm`). Footer hint: `enter install` →
   `enter apply`. Also renames a shadowed local `hasRemovals` → `pkgHasRemovals`.
2. **`hooks/useInstaller.ts`** — before the install loop, auto-enables every item
   that is `alreadyInstalled` and not `markedForRemoval`, so a bare Enter
   re-applies the current install set. Adds a synthetic "Nothing to do" result
   so the results screen is never blank.
3. **`lib/install.ts`** — `installFiles` hash-compares src vs dest and reports
   `already-exists` instead of a misleading `updated` when content is identical.
   This is what makes re-apply tolerable to look at.
4. **`lib/hash.ts`** (new) + **`lib/discover.ts`** — lifts the private `fileHash`
   helper out of `discover.ts` into a shared module so `install.ts` can use it.
   Pure extraction, no behavior change.

## Verdict

**The code is complete. The change is not.**

All three moving parts (UI gating, descriptor preparation, idempotent reporting)
are present, they fit, and the parts that look risky hold up under inspection.
Nothing is half-wired.

But this diff is a **deliberate reversal of a previously specified and manually
verified design**, and it does not update any of the artifacts that specified it:

- The TUI-redesign plan (preserved verbatim inside
  `docs/output-style-examples-long.json`) says: "`enter` installs **when there
  are selections** — Install button becomes a static status line." That same plan
  scoped itself to "**No changes** to `lib/discover.ts`, `lib/install.ts`, the
  hooks" — the exact three files this diff modifies.
- Commit `9ea7acc`: "InstallButton demoted to static status line (↵ Install /
  Nothing selected)."
- Commit `3137727`: "Install button **activates** when any item is queued for
  install or removal."
- `tests/packages/installer/test-results.md` step 6 asserts: "install line shows
  '↵ Nothing selected' when nothing is toggled" — recorded **PASS, 2026-06-23**.

So the only written statement of intent for the new behavior is the comment block
inside the diff itself. `ct/installer-tweaks` has **zero commits** — the whole
feature is uncommitted working tree. Every prior installer change in this repo's
history shipped its README/CHANGELOG updates in the same commit; the one
exception is the squash `e952d01`, which is also the commit that introduced the
behavior now being reverted.

That makes the two stale artifacts below **scope evidence, not style nits.**

### Correctness checks that pass

- **Removal/install ordering makes the guard load-bearing.**
  `useInstaller.ts:46-55` runs `removePackage` *before* `installPackage` per
  package. So the `pkgHasRemoval` guard (line 29-30) is genuinely necessary, not
  defensive noise: `installFiles` **never reads `pkg.items` at all** — it
  iterates `manifest.files` wholesale — while `removeFiles`' non-settings branch
  unlinks all of `manifest.files`. Without the guard, auto-enabling a sibling
  `settings.json config` item would make the install pass recopy exactly what the
  removal pass just unlinked. The guard is correct and the comment explaining it
  is accurate.
- **`pkg.type === "files"` is exhaustive for that hazard.**
  `PackageDescriptor.type` is exactly `"skills" | "files" | "plugin"`
  (`types.ts:59`), and `installPackage` routes plugin → `installPlugin`,
  skills → `installSkills`, else → `installFiles`. No fourth variant can fall
  through to the wholesale-copy path.
- **The comment's skills/plugin exemption is accurate.** `installSkills` and
  `installPlugin` both `continue` on `!item.enabled`, so per-item gating already
  holds and the guard is correctly *not* applied there.
- **The synthetic empty-`packageId` result renders cleanly.**
  `components/ResultsView.ts` switches on `r.status` for glyph/color and prints
  only `r.message`; it never groups or labels by `packageId`/`itemName`. The
  empty strings are inert — `already-exists` renders as a yellow `–`.
- **The new `fileHash(dest)` call cannot kill the install pass.** It sits inside
  the pre-existing per-file `try`/`catch` (`install.ts:265-289`), so any hash
  failure degrades to a single `error` row. And `existed` comes from `stat`,
  which follows symlinks, so a dangling symlink gives `existed === false` and
  never reaches the hash call.
- **`installFiles` is now uniformly idempotent in its reporting.** The
  `manifest.settings` merge below it already reported `already-exists` on no-op;
  the new hash check brings the file-copy half to parity. The diff closes a real
  asymmetry rather than inventing one.
- **The `needsUpgrade` omission is benign.** `reinstall.ts` keys on
  `alreadyInstalled || needsUpgrade`; the new code keys only on
  `alreadyInstalled`, which `discover.ts` defines as `allExist && !needsUpgrade`
  — so an upgradeable item has `alreadyInstalled: false`. It is still picked up,
  because `discover.ts` sets `enabled: !allInstalled`, i.e. pre-enables anything
  needing an upgrade. The `item.enabled` half of the condition covers it. Worth
  knowing this is load-bearing, though: the two predicates only agree because of
  that pre-enable.
- **Incidental bug fix.** `installFiles` previously clobbered a
  symlink-into-repo dest with a real file copy, destroying the auto-updating
  symlink. The hash check now short-circuits that (the hash follows the link and
  matches). Worth *knowing* it happened — it is not mentioned anywhere.

## Gaps worth closing

Ranked. None block the feature working.

### 1. Two stale artifacts assert the old behavior — the real incompleteness

**`README.md:34` is now wrong.** It currently reads:

> Uses a flat checklist. Navigate with `↑↓`, toggle with `space`, view details
> with `i`, install with `enter`. Only `packages/` entries are shown — plugins
> are installed via the Claude Code marketplace.

`install with enter` no longer describes the behavior — Enter now applies
removals and re-applies installed items too. Reword to match the new footer
(`enter apply`) and state that Enter with nothing selected re-applies the current
install set. The trailing sentence about `packages/` only is still accurate
(`App.ts:48` filters plugins out).

**`tests/packages/installer/test-results.md` step 6 is now a failing assertion.**
The recorded `flat-checklist-navigation` scenario says:

> 6. Verify: install line shows "↵ Nothing selected" when nothing is toggled

marked **PASS / 2026-06-23**. That row is now false. Rewrite step 6 to assert the
new label (`↵ Re-apply / confirm`) and add a step for the re-apply-is-idempotent
case, then record a fresh dated run.

There is **no `README.md` in `packages/installer`** — no `.md` of any kind in
that directory, and none in history. It's the only package without one
(`git-utils` and `claude-optin` both got READMEs in `72189c4` / `a6d52a9`). The
root README is the only prose doc to fix.

`CHANGELOG.md` tops out at `## v0.0.57 - 2026-08-03`, matching
`package.json`'s `0.0.57` — so this work has **no changelog entry and no version
bump yet**. Both are required by this repo's `CLAUDE.md` post-commit rule, along
with the README check above.

Note also there is **no `docs/plans/` doc for this feature** (the only installer
hits under `docs/` are this review and an incidental mention in
`abort-stray-stash-pop.md`). So there is no written spec to measure the diff
against — "complete" here is judged intrinsically, from the code.

### 2. `installPlugin`'s file branch didn't get the same treatment

`install.ts:60-64` still has the bare `existed ? "updated" : "created"` report
with no hash comparison, and `installPlugin` **never emits `already-exists` at
all** — `symlinkItem` early-returns when the link already points at the source,
but the caller unconditionally pushes `created` / `Linked: …`. That diverges
from `installSkills`, which reports `already-exists` in exactly that case.

Not reachable from the new Enter path (`App.ts:48` filters
`p.type !== "plugin"`, and `buildFlatItems` skips plugins), but reachable via
`src/reinstall.ts` and `src/install-package.ts`. Applying the same short-circuit
would make "already up to date" uniform across all three entrypoints.

### 3. The new hash check ignores the existing `isSymlinkIntoRepo` helper

`discover.ts:112-121` deliberately skips symlinks-into-repo when computing
`needsUpgrade` ("they auto-update"). The new check in `installFiles` has no such
guard — it behaves correctly only because `fileHash` happens to follow the link.
Two sites now express the same intent by different mechanisms. If `fileHash` was
extracted to `lib/hash.ts` for sharing, `isSymlinkIntoRepo` is the natural
second extraction, and would make `installFiles`' intent explicit rather than
incidental. Note also that `discover.ts` already computes an `isCurrent` flag
per item meaning "hash matches source" — the install-time hash is a second,
independent computation of the same fact.

### 4. Removing the Enter guard removed an accidental safety net

Enter now always writes to `~/.claude`. That is the point of the feature, so it
is a design call, not a defect — but be deliberate about it. Related: the
`↵ Re-apply / confirm` label shows even when nothing is installed *and* nothing
is selected, the one case where Enter does nothing but print "Nothing to do." A
fifth `↵ Nothing to apply` case would be more honest.

### 5. Pre-existing hole the new comment names but cannot fix

`useInstaller.ts:27` says "Explicit user toggles still apply." Concretely: toggle
a files item ON *and* mark the sibling `settings.json config` item for removal →
`hasInstalls` is true → `installFiles` runs → its unconditional
`manifest.settings` merge re-adds the keys `removeFiles` just deleted. This
predates the diff (the old code derived `hasInstalls` from `item.enabled` the
same way). Out of scope, but it deserves a "known issue" note rather than an
unqualified comment, since the guard demonstrably does not cover it.

Two more pre-existing oddities found while tracing, unrelated to this diff:
`installFiles`' settings merge pushes `status: "created"` with message
`"Updated settings.json"` (status/message mismatch), and `removeFiles`'
non-settings branch would unlink every file once per marked item, so two marked
non-settings items produce ENOENT `error` rows on the second pass.

### 6. Nothing verifies this mechanically

- **No tests.** No `*.test.mts`/`*.test.ts` under `packages/installer`, no
  vitest/jest config in the repo, no `test` script at root or in the package.
  The repo *does* have a precedent — `packages/statusline/statusline-render.test.mts`
  — and a documented convention in `tests/packages/installer/index.md`: a
  `.test.mts` file using `node:test` + `node:assert`, run via
  `node --experimental-strip-types --test`, with results recorded in
  `tests/packages/installer/test-results.md`. That doc currently says "No
  automated tests exist yet."
- **No typecheck is currently possible.** `tsconfig.json` sets `strict` and
  `noEmit`, but **TypeScript is not installed** — `npx tsc` resolves to the
  unrelated `tsc` package, and root `devDependencies` lists only `@types/node`.
  The strict config is decorative today. Adding `typescript` as a root
  devDependency plus a `typecheck` script is the highest-leverage follow-up, and
  is what would catch any import fallout from the `hash.ts` extraction.
- **No CI.** There is no `.github/workflows/` at all, so nothing runs on push
  either. Per the global `~/dev` rule this repo needs no PR and skips the post-PR
  Fresh Eyes watch — but it also means manual verification is the only gate.

## Verification

**Do not run the TUI against the real home directory.** Both `discover.ts` and
`install.ts` compute `CLAUDE_DIR` from `process.env.HOME!` at module load, and
this repo's `CLAUDE.md` puts `~/.claude` off-limits. Use a scratch HOME:

```bash
cd packages/installer
export SCRATCH=$(mktemp -d)
HOME=$SCRATCH npm start
```

Walk these cases in order:

1. **Fresh install** — scratch HOME, nothing installed. Label reads
   `↵ Install selected` once something is toggled on. Bare Enter with an empty
   selection shows "Nothing to do — no items selected." (This sentinel is
   reachable *only* when nothing is installed and nothing is selected.)
2. **Re-apply is idempotent** — install a files package, quit, relaunch, press
   Enter with nothing selected. Every file must report `– Already up to date: …`
   plus `settings.json already configured`. Zero `↑ Updated:` rows. This is the
   core new behavior and the main thing to confirm.
3. **Re-apply after an edit** — modify one installed file in `$SCRATCH/.claude`,
   relaunch, Enter. That file alone reports `↑ Updated:`.
4. **Removal beats re-apply (the guard)** — use a files package that has both a
   files item and a `settings.json config` item. Install it, relaunch, mark the
   files item for removal, Enter. Files must be removed and must **not** be
   recopied. Label reads `↵ Apply removals`.
5. **Mixed** — one package toggled on, another marked for removal → label reads
   `↵ Apply changes`; both effects land.
6. **Skills per-item gating** — in a skills package, mark one skill for removal
   while others stay installed. Only that one unlinks; the rest report
   `Already linked:`.

Then add `typescript` to root devDependencies and run
`tsc --noEmit -p packages/installer/tsconfig.json`.

Cleanup: `rm -rf "$SCRATCH"`.

---

## Empirical verification results (2026-08-06)

Run with `HOME=$(mktemp -d)` and the mise-pinned node 24 binary invoked directly
(`~/.local/share/mise/installs/node/24/bin/node`) — the `node` on `PATH` is a
mise shim that fails once `HOME` moves, and `npm run` inherits that failure.

### Passing

| Case | Result |
|---|---|
| `install-package statusline`, run 1 | `Copied: …` ×2 + `Updated settings.json` |
| run 2, nothing changed | `Already up to date: …` ×2 + `settings.json already configured` |
| run 3, one file tampered | `Updated: statusline.sh` + `Already up to date:` for the other |
| run 4, clean again | fully idempotent |
| run 5, `statusLine` key clobbered | files idempotent, `Updated settings.json` only |
| TUI footer | reads `enter apply` ✓ |
| TUI label, all installed / nothing selected | `↵ Re-apply / confirm` ✓ |
| TUI Enter on that state | three yellow `–` rows, **and `mtime` unchanged on all three files** — proof no rewrite occurred |

The `mtime` check is the strongest evidence the hash short-circuit actually
prevents the copy rather than just relabeling it.

### Failing — but pre-existing, not introduced

**A files package whose items have mixed install state loses its removal.**
Reproduced live in the TUI, then reproduced **identically on HEAD** with the diff
reverted, so this diff neither causes nor fixes it.

Setup: statusline files installed, `statusLine` settings key absent. Discovery
then yields `items[0] = {alreadyInstalled: true, enabled: false}` and
`items[1] = {alreadyInstalled: false, enabled: true}`. Pressing space marks the
package for removal, and `App.ts:toggleItem` sets `markedForRemoval: true` on
**all** items but never clears `enabled`. So `items[1].enabled` stays `true`:

```
 ↵ Apply changes          ← not "Apply removals"

 Results
  ✗ Removed: statusline.sh
  ✗ Removed: statusline-render.mts
  ✗ Removed keys from settings.json
  ✓ Copied: statusline.sh              ← the removal is undone
  ✓ Copied: statusline-render.mts
  ✓ Updated settings.json
```

Net effect of asking to remove the package: nothing is removed.

**Consequence for this diff: the `pkgHasRemoval` guard is unreachable, and its
comment is wrong.** For the guard to fire, a files package would need one item
`markedForRemoval` and a sibling `alreadyInstalled && !markedForRemoval`.
`toggleItem` marks every item in a files package uniformly, so that state cannot
arise — and `useInstaller` is only used by the TUI. The comment claims the guard
stops "the install pass recopy files the removal pass just unlinked"; that recopy
demonstrably still happens, via `enabled` set at discovery rather than by the
auto-enable the guard gates.

Correction applied in slice A: the guard stays (harmless, and correct if
`toggleItem` ever becomes per-item), but the comment is rewritten to state what
it actually does and to record the real hole. Fixing the hole itself is a
separate slice — it belongs in `App.ts:toggleItem` (clear `enabled` when marking
for removal), not in `useInstaller`.

## Agreed execution scope

User selected: fix README + CHANGELOG, verify with scratch HOME, add
typescript + typecheck.

### Branch slices

This repo is under `~/dev`, so per the global rule: keep the PR Cadence
slicing/branching discipline — cut a branch per independently-shippable slice —
but **skip `gh pr create`** unless a PR is explicitly asked for, and Fresh Eyes
is local-only (no CI exists here anyway).

Checkpoint 2 — one line per slice, base confirmed:

- `ct/installer-tweaks ← origin/main` ✓ (branch currently has **zero commits**
  and sits exactly at `origin/main` `9e5c85b`, so it is already cut from the
  default branch)
- `ct/installer-typecheck ← origin/main` ✓ (new branch, `git switch -c
  ct/installer-typecheck origin/main` after `git fetch`)

Both target the default branch. They share `package.json` — slice A bumps
`version`, slice B adds `devDependencies.typescript` and `scripts.typecheck` —
but those are disjoint keys, and per the rule "avoiding conflicts" is **not** a
dependency. No non-default base is needed or justified.

**Slice A — `ct/installer-tweaks`** (the feature + its docs, one commit):
1. The 5 existing working-tree files, as-is (`hash.ts` is already staged).
2. `README.md:34` — reword "install with `enter`" → `enter` applies changes;
   with nothing selected it re-applies the installed set.
3. `tests/packages/installer/test-results.md` — rewrite step 6, add an
   idempotent-re-apply step, record a fresh dated manual run.
4. `CHANGELOG.md` — new `## v0.0.58 - 2026-08-06` entry describing the Enter
   reversal, the hash-based `already-exists` reporting, and the `hash.ts`
   extraction. Say explicitly that this reverses the `9ea7acc` gating design.
5. `package.json` — `0.0.57` → `0.0.58`.

Steps 2–5 belong in this slice, not a follow-up: the repo's `CLAUDE.md`
post-commit rule ties them to the change, and step 3 is a currently-false
assertion. Splitting them would ship a commit whose own test spec contradicts it.

**Slice B — `ct/installer-typecheck`** (independently shippable, off `origin/main`):
1. Add `typescript` to root `devDependencies`.
2. Add a root `typecheck` script covering `packages/installer/tsconfig.json`.
3. Run it; fix anything the `hash.ts` extraction surfaced.

Not slice A's job — it stands alone, reviewable in any order, and touches no
installer source.

### Order of work

1. Verify slice A's behavior first (scratch-HOME walkthrough above) — the
   verification result is what step 3's dated run records, so it must precede
   the commit.
2. Commit slice A on `ct/installer-tweaks`.
3. Cut `ct/installer-typecheck` from `origin/main`, do slice B, run the
   typecheck.
4. Load `pre-push-check` before pushing either branch (local `fresheyes` review
   only — skip the post-PR watch, there is no CI).

### Explicitly out of scope

Gaps 2, 3, 4, and 5 above (`installPlugin` hash parity, extracting
`isSymlinkIntoRepo`, the `Nothing to apply` fifth label, the pre-existing
toggle-ON-plus-remove-sibling hole). Each is a candidate for its own slice off
`origin/main` later; none block this work.
