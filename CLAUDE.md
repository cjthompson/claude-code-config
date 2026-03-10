# Claude Instructions

## Post-Commit Tasks

After every `git commit` or `git merge` on the `main` always perform the following steps:

1. **Bump the patch version in `package.json`** — Increment the `version` field by one patch version (e.g., `1.0.0` → `1.0.1`). If no `version` field exists, add one starting at `0.0.1`.

2. **Update `CHANGELOG.md`** — Add an entry for today's date (if one does not already exist) and summarize the changes from the commit. The heading will be the version number from step 1 and the date; for example `## v1.0.1 - 2026-03-09`

3. Check if the changes affected anything documented in the `README.md`. If so, **Update the `README.md`** to match the changed behavior.

## Repository-Based Changes

This repository contains configurable elements for Claude Code, including skills, statusline customizations, and package configurations. When making changes to items contained in this repo:

- **Make changes directly in this repository** — Any updates to skills, statusline, configurations, or packages should be committed to this repo via pull request.

- **AskUserQuestion: Run `install-packages`?** — After changes are committed and merged, ask the user if they want to run `npm run install-packages` to reinstall/apply updates to your Claude Code configuration.

- **`~/.claude` is off-limits** — Never read or write files directly under `~/.claude/`. Always work in this repository (`packages/skills/`, etc.). The installed copies under `~/.claude/` are symlinked and will reflect changes automatically.

- **Symlinked items** — Some items like skills are symlinked rather than copied during installation. Changes to these symlinked resources take effect automatically without requiring a reinstall, though running the installer may help propagate other related changes.

## Skill Editing Verification

When editing a skill file (`SKILL.md`) that contains a `model:` field in its YAML frontmatter (e.g., `model: haiku`), perform the following verification loop after making changes:

**Trigger:** A skill file has been edited AND its frontmatter contains a `model:` field.

**Workflow:**

1. **Dispatch a model subagent** — Launch a subagent using the model named in the `model:` field. Provide it with the full contents of the edited skill file and instruct it to process and exercise the skill as if it were responding to a realistic user request that would invoke the skill. The subagent should produce a detailed report of: what it did, whether the skill instructions were clear and actionable, any ambiguities or gaps it encountered, and the output it produced.

2. **Dispatch an Opus verifier** — Pass the subagent's report (along with the edited skill file contents) to a new subagent running `claude-opus-4-5` (or the most capable Opus model available). Instruct the Opus verifier to review whether the skill edits are correct, complete, and unambiguous based on the model subagent's report. The Opus verifier must respond with one of:
   - **APPROVED** — The skill edits are satisfactory. Include a brief rationale.
   - **NEEDS REVISION** — The skill edits have problems. Include specific, actionable feedback describing what must be fixed.

3. **Loop or terminate:**
   - If the Opus verifier responds **APPROVED**, the verification is complete. Proceed with any remaining steps (e.g., commit).
   - If the Opus verifier responds **NEEDS REVISION**, apply the feedback to the skill file, then return to step 1 for another iteration.
   - If the user cancels at any point (e.g., says "stop", "cancel", or interrupts the process), halt the loop immediately without further changes.
