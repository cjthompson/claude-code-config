# Tasks

---

## task: update the CLAUDE.md so that when editing a skill that defines a model (`model: haiku`) that a subagent is used with that model to process it and report back to a new opus subagent to verify. this will loop until the opus agent is satisfied or the use cancels.
**ID:** #009 | **Date:** 2026-03-10 14:30 | **Priority:** medium | **Tags:** —
**Status:** completed (2026-03-10 14:35)

### Requirements
- Add a section to `CLAUDE.md` describing a skill-editing verification workflow
- When editing a skill file that has a `model:` frontmatter field, after making changes, dispatch a subagent using that model to process/exercise the edited skill
- That subagent reports its results to a new Opus subagent acting as verifier
- The Opus verifier either approves or sends feedback for another iteration
- Loop continues until Opus approves or the user cancels

---

## task: add `check task #NNN` command to verify work is in codebase
**ID:** #008 | **Date:** 2026-03-10 11:45 | **Priority:** medium | **Tags:** —
**Status:** completed (2026-03-10 11:52)

### Requirements
- Add a `check task #NNN` command to the project-tasks SKILL.md
- When triggered, dispatch a read-only subagent (no code changes) that: searches git log for commits referencing the task ID or title; scouts relevant files using Glob/Grep/Read based on keywords extracted from the task requirements
- Subagent reports per-requirement: Found / Partial / Not Found / Cannot Verify, with evidence (file:line or commit hash)
- Lead agent presents the report to the user with an overall confidence summary
- No changes to TASKS.md status — `check` is purely informational

---

## task: skill should not commit changes until Accept is selected
**ID:** #007 | **Date:** 2026-03-10 00:10 | **Priority:** medium | **Tags:** —
**Status:** in_progress (dispatched 2026-03-10 00:11)

### Requirements
- In `packages/skills/project-tasks/SKILL.md`, remove the `git commit` step from the task runner subagent prompt (Phase 2: Execute)
- When the user selects "Accept" (Step 4), the lead agent should perform the git commit at that point (after updating TASKS.md status)
- If the user selects "Retry", no commit is made and files are reverted with `git checkout .` instead of `git reset --hard HEAD~1`
- Update the Phase 3 Report format: subagent reports files changed and test results but no commit hash (since no commit happened yet)

---

## task: add CLI flag to install individual packages by name without TUI
**ID:** #006 | **Date:** 2026-03-10 00:05 | **Priority:** medium | **Tags:** —
**Status:** completed (2026-03-10 00:08)

### Requirements
- Add CLI argument support (e.g. `--install <package-name>`) to `packages/installer` so a specific package can be installed by name without launching the TUI
- No interactive prompts — runs fully non-interactively, prints progress to stdout
- Expose via a root `package.json` script or document usage via the existing `install-packages` script with the flag

---

## task: add `reinstall` npm script that reinstalls already-installed packages
**ID:** #005 | **Date:** 2026-03-10 00:00 | **Priority:** medium | **Tags:** —
**Status:** completed (2026-03-10 00:03)

### Requirements
- Add a `reinstall` entry point in `packages/installer` that detects which packages are already installed and reinstalls only those
- No TUI, no interactive prompts — runs fully non-interactively
- Add `reinstall` npm script to the root `package.json`

---

## task: update CLAUDE.md to clarify repo-based changes
**ID:** #004 | **Date:** 2026-03-09 15:30 | **Priority:** medium | **Tags:** —
**Status:** completed (2026-03-09 15:33)

### Requirements
- Add a section to CLAUDE.md explaining that requests for changes to things contained in this repo (e.g., skills, configs) should be made within this repo itself
- Mention that `npm run install-packages` can be used to reinstall/apply changes if needed
- Note that some items like skills are symlinked and don't require updating after changes

---

## task: swap the order of branch and directory but keep the colors in the same spot
**Date:** 2026-03-09 15:00 | **Priority:** medium | **Tags:** —
**Status:** completed (2026-03-09 15:05)

### Requirements
- In `packages/statusline/statusline-render.ts`, swap the order of the directory and branch segments in `line1Segs` so branch appears first (blue, section 24) and directory appears second (gray, section 237)
- Keep the colors in their positional spots: blue section stays first (after green), gray section stays last
- Update the icon and foreground colors on each segment to match the new section colors (branch uses CYAN_FG/WHITE for blue section; directory uses fg(148) for gray section)
- Copy the updated file to `~/.claude/statusline-render.ts`

---

## task: change "todo: " to always "Log Only"
**Date:** 2026-03-09 14:00 | **Priority:** medium | **Tags:** —
**Status:** completed (2026-03-09 14:10)

### Requirements
- In the project-tasks SKILL.md, update the "Logging a Task" section so that the `todo:` prefix skips the execution choice prompt entirely and always behaves as "Log Only" (task is saved as `pending` with no dispatch)
- Update any documentation or quick reference that implies `todo:` has the same behavior as `task:`

---

## task: Add CLAUDE.md with post-commit changelog and version update instructions
**Date:** 2026-03-09 12:00 | **Priority:** medium | **Tags:** #workflow
**Status:** completed (2026-03-09 12:01)

### Requirements
- Create a `CLAUDE.md` at the project root with instructions for Claude to always update `docs/CHANGELOG.md` after committing new changes
- Include an instruction to do a patch version bump in `package.json` after each commit
