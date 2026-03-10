# Claude Instructions

## Post-Commit Tasks

After every `git commit` or `git merge` on the `main` always perform the following steps:

1. **Bump the patch version in `package.json`** — Increment the `version` field by one patch version (e.g., `1.0.0` → `1.0.1`). If no `version` field exists, add one starting at `0.0.1`.

2. **Update `CHANGELOG.md`** — Add an entry for today's date (if one does not already exist) and summarize the changes from the commit. The heading will be the version number from step 1 and the date; for example `## v1.0.1 - 2026-03-09`

3. Check if the changes affected anything documented in the `README.md`. If so, **Update the `README.md`** to match the changed behavior.
