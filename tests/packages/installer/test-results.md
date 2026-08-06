# installer Test Results

Tracks test execution history for the installer package.

## Scenarios

### flat-checklist-navigation
Manual verification of the flat checklist TUI (introduced in refactor replacing card-based layout).

Steps:
1. Run `npm run install-packages` from repo root
2. Verify: flat list renders, no bordered cards, section headers per package
3. Verify: `↑↓` moves cursor continuously across package boundaries
4. Verify: footer description updates per focused item; falls back to package description
5. Verify: `space` toggles item; `i` opens info overlay; `Esc`/`i` closes it
6. Verify: install line reads "↵ Re-apply / confirm" when nothing is pending,
   "↵ Install selected" / "↵ Apply removals" / "↵ Apply changes" as appropriate
7. Verify: plugins do NOT appear in the list (installed via marketplace)
8. Verify: files packages show one row per package (not one row per file)

### reapply-idempotency

Manual verification that `enter` with nothing selected re-applies the installed
set without rewriting unchanged files.

Run everything against a scratch HOME — `discover.ts` and `install.ts` both read
`process.env.HOME` at module load, and `~/.claude` must not be touched. The
`node` on `PATH` is a mise shim that fails once `HOME` moves, so invoke the
pinned binary directly:

```bash
export SCRATCH=$(mktemp -d)
NODE=~/.local/share/mise/installs/node/24/bin/node
env HOME=$SCRATCH $NODE --experimental-strip-types packages/installer/src/index.ts
```

Steps:
1. Fresh scratch HOME: install a files package (statusline), then quit
2. Record `mtime` of each installed file
3. Relaunch, toggle every uninstalled package off so nothing is pending
4. Verify: install line reads "↵ Re-apply / confirm"
5. Press `enter`. Verify: every file reports "– Already up to date", settings
   reports "settings.json already configured", and **no `mtime` changed**
6. Tamper with one installed file, relaunch, `enter`. Verify: only that file
   reports "↑ Updated"; the sibling still reports "Already up to date"
7. Skills package: mark one installed skill for removal, leave a sibling
   installed, `enter`. Verify: only the marked skill is removed, the sibling
   reports "– Already linked", and its symlink inode is unchanged

### known-issue: mixed-state files package loses its removal

Pre-existing (reproduces identically with the re-apply change reverted). Not a
regression; recorded so it is not rediscovered as new.

With a files package whose items differ in install state — files present but the
`settings` key absent — `App.ts toggleItem` sets `markedForRemoval` on every item
without clearing `enabled`. The settings item keeps `enabled: true`, so the
install pass follows the removal pass and recopies everything. The install line
reads "↵ Apply changes" rather than "↵ Apply removals", and the results view
shows three `✗ Removed` rows followed by three `✓ Copied` rows. Net effect of
requesting removal: nothing is removed. Fix belongs in `toggleItem`.

## Execution Log

| Date | Scenario | Status | Notes |
|------|----------|--------|-------|
| 2026-06-23 | flat-checklist-navigation | PASS | Verified in tmux with real TTY; bug found and fixed (plugins leaking into hasSelections) |
| 2026-08-06 | flat-checklist-navigation | PASS | Re-verified in tmux with scratch HOME after the re-apply change. Step 6 rewritten — the old "↵ Nothing selected" assertion no longer applies |
| 2026-08-06 | reapply-idempotency | PASS | tmux + real TTY, scratch HOME. All 7 steps. `mtime` unchanged across re-apply; skills symlink inode unchanged. Non-interactive path cross-checked via `install-package statusline` run twice |
