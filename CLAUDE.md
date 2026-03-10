# Claude Instructions

## Post-Commit Tasks

After every `git commit` or `git merge` on the `main` always perform the following steps:

1. **Bump the patch version in `package.json`** — Increment the `version` field by one patch version (e.g., `1.0.0` → `1.0.1`). If no `version` field exists, add one starting at `0.0.1`.

2. **Update `CHANGELOG.md`** — Add an entry for today's date (if one does not already exist) and summarize the changes from the commit. The heading will be the version number from step 1 and the date; for example `## v1.0.1 - 2026-03-09`

3. Check if the changes affected anything documented in the `README.md`. If so, **Update the `README.md`** to match the changed behavior.

## Repository-Based Changes

This repository contains configurable elements for Claude Code, including skills, statusline customizations, and package configurations. When making changes to items contained in this repo:

- **Make changes directly in this repository** — Any updates to skills, statusline, configurations, or packages should be committed to this repo via pull request.

- **Apply changes with npm** — After changes are committed and merged, run `npm run install-packages` to reinstall/apply updates to your Claude Code configuration.

- **Symlinked items** — Some items like skills are symlinked rather than copied during installation. Changes to these symlinked resources take effect automatically without requiring a reinstall, though running the installer may help propagate other related changes.
