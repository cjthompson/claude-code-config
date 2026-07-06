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
6. Verify: install line shows "↵ Nothing selected" when nothing is toggled
7. Verify: plugins do NOT appear in the list (installed via marketplace)
8. Verify: files packages show one row per package (not one row per file)

## Execution Log

| Date | Scenario | Status | Notes |
|------|----------|--------|-------|
| 2026-06-23 | flat-checklist-navigation | PASS | Verified in tmux with real TTY; bug found and fixed (plugins leaking into hasSelections) |
